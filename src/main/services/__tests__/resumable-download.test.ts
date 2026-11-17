import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

vi.mock('../autodoc-log', () => ({ logAutodocEvent: vi.fn(), logAutodocFailure: vi.fn() }))

const BODY = Buffer.from('the pinned bytes of a large speech model')
const SHA256 = createHash('sha256').update(BODY).digest('hex')
const FAST_TIMEOUTS = { timeouts: { headerMs: 50, inactivityMs: 50 } }

type Handler = (req: IncomingMessage, res: ServerResponse) => void

let root: string
let dest: string
let servers: Server[]
let downloadVerifiedFile: typeof import('../resumable-download').downloadVerifiedFile

async function startSource(handler: Handler): Promise<{ url: string; hits: () => string[] }> {
  const requests: string[] = []
  const server = createServer((req, res) => {
    requests.push(req.headers.range ?? 'no-range')
    handler(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/file`,
    hits: () => requests
  }
}

/** Serves BODY, honoring Range like a real file host. */
const serveFile: Handler = (req, res) => {
  const start = Number(/bytes=(\d+)-/.exec(req.headers.range ?? '')?.[1] ?? 0)
  if (start > 0) {
    res.writeHead(206, {
      'content-length': BODY.length - start,
      'content-range': `bytes ${start}-${BODY.length - 1}/${BODY.length}`
    })
  } else {
    res.writeHead(200, { 'content-length': BODY.length })
  }
  res.end(BODY.subarray(start))
}

const dropConnection: Handler = (req) => req.socket.destroy()

beforeEach(async () => {
  vi.resetModules()
  ;({ downloadVerifiedFile } = await import('../resumable-download'))
  root = await mkdtemp(join(tmpdir(), 'autodoc-resumable-'))
  dest = join(root, 'model.bin')
  servers = []
})

afterEach(async () => {
  for (const server of servers) {
    server.closeAllConnections()
    server.close()
  }
  await rm(root, { recursive: true, force: true })
})

describe('downloadVerifiedFile', () => {
  it('uses only the first source when it works', async () => {
    const first = await startSource(serveFile)
    const second = await startSource(serveFile)

    await expect(
      downloadVerifiedFile([first.url, second.url], dest, SHA256, 'model')
    ).resolves.toBe(SHA256)

    expect(await readFile(dest)).toEqual(BODY)
    expect(second.hits()).toHaveLength(0)
  })

  it('moves to the next source when a connection fails', async () => {
    const blocked = await startSource(dropConnection)
    const mirror = await startSource(serveFile)

    await downloadVerifiedFile([blocked.url, mirror.url], dest, SHA256, 'model')

    expect(await readFile(dest)).toEqual(BODY)
  })

  it('tries a connection-failed origin last for later files, without skipping it', async () => {
    const blocked = await startSource(dropConnection)
    const mirror = await startSource(serveFile)

    await downloadVerifiedFile([blocked.url, mirror.url], dest, SHA256, 'one')
    expect(blocked.hits()).toHaveLength(1)

    await downloadVerifiedFile([blocked.url, mirror.url], join(root, 'two.bin'), SHA256, 'two')
    expect(blocked.hits()).toHaveLength(1)
    expect(mirror.hits()).toHaveLength(2)
  })

  it('moves to the next source when response headers stall', async () => {
    const stalled = await startSource(() => {})
    const mirror = await startSource(serveFile)

    await downloadVerifiedFile([stalled.url, mirror.url], dest, SHA256, 'model', FAST_TIMEOUTS)

    expect(await readFile(dest)).toEqual(BODY)
  })

  it('resumes on the next source from the partial when a body stalls', async () => {
    const half = Math.floor(BODY.length / 2)
    const stalled = await startSource((_req, res) => {
      res.writeHead(200, { 'content-length': BODY.length })
      res.write(BODY.subarray(0, half))
    })
    const mirror = await startSource(serveFile)

    await downloadVerifiedFile([stalled.url, mirror.url], dest, SHA256, 'model', FAST_TIMEOUTS)

    expect(mirror.hits()).toEqual([`bytes=${half}-`])
    expect(await readFile(dest)).toEqual(BODY)
  })

  it('lets a slow transfer finish as long as bytes keep arriving', async () => {
    const slow = await startSource((_req, res) => {
      res.writeHead(200, { 'content-length': BODY.length })
      let sent = 0
      const send = (): void => {
        res.write(BODY.subarray(sent, sent + 4))
        sent += 4
        if (sent < BODY.length) setTimeout(send, 20)
        else res.end()
      }
      send()
    })
    const mirror = await startSource(serveFile)

    await downloadVerifiedFile([slow.url, mirror.url], dest, SHA256, 'model', {
      timeouts: { headerMs: 200, inactivityMs: 100 }
    })

    expect(mirror.hits()).toHaveLength(0)
  })

  it('keeps the partial after an unsuccessful response and resumes it on the next source', async () => {
    await writeFile(`${dest}.tmp`, BODY.subarray(0, 8))
    const failing = await startSource((_req, res) => {
      res.writeHead(503)
      res.end()
    })
    const mirror = await startSource(serveFile)

    await downloadVerifiedFile([failing.url, mirror.url], dest, SHA256, 'model')

    expect(mirror.hits()).toEqual(['bytes=8-'])
    expect(await readFile(dest)).toEqual(BODY)
  })

  it('does not penalize an origin for one missing file', async () => {
    let missing = true
    const flaky = await startSource((req, res) => {
      if (missing) {
        missing = false
        res.writeHead(404)
        res.end()
        return
      }
      serveFile(req, res)
    })
    const mirror = await startSource(serveFile)

    await downloadVerifiedFile([flaky.url, mirror.url], dest, SHA256, 'one')
    expect(mirror.hits()).toHaveLength(1)

    await downloadVerifiedFile([flaky.url, mirror.url], join(root, 'two.bin'), SHA256, 'two')
    expect(flaky.hits()).toHaveLength(2)
    expect(mirror.hits()).toHaveLength(1)
  })

  it('moves on when a source serves the wrong bytes, without trusting any of them', async () => {
    const wrong = await startSource((_req, res) => {
      res.writeHead(200)
      res.end('different bytes')
    })
    const mirror = await startSource(serveFile)

    await downloadVerifiedFile([wrong.url, mirror.url], dest, SHA256, 'model')

    expect(await readFile(dest)).toEqual(BODY)
  })

  it('does not penalize an origin for serving wrong bytes', async () => {
    let bad = true
    const source = await startSource((req, res) => {
      if (bad) {
        res.writeHead(200)
        res.end('different bytes')
        return
      }
      serveFile(req, res)
    })
    const mirror = await startSource(serveFile)

    await downloadVerifiedFile([source.url, mirror.url], dest, SHA256, 'one')
    bad = false
    await downloadVerifiedFile([source.url, mirror.url], join(root, 'two.bin'), SHA256, 'two')

    expect(mirror.hits()).toHaveLength(1)
  })

  it('tries each source once per call, then fails', async () => {
    const first = await startSource(dropConnection)
    const second = await startSource(dropConnection)

    await expect(
      downloadVerifiedFile([first.url, second.url], dest, SHA256, 'model')
    ).rejects.toThrow()

    expect(first.hits()).toHaveLength(1)
    expect(second.hits()).toHaveLength(1)
  })

  it('still tries every source on a later call after they all failed', async () => {
    const first = await startSource(dropConnection)
    const second = await startSource(dropConnection)
    await expect(
      downloadVerifiedFile([first.url, second.url], dest, SHA256, 'model')
    ).rejects.toThrow()

    await expect(
      downloadVerifiedFile([first.url, second.url], dest, SHA256, 'model')
    ).rejects.toThrow()

    expect(first.hits()).toHaveLength(2)
    expect(second.hits()).toHaveLength(2)
  })

  it('stops without switching hosts when the caller cancels', async () => {
    const controller = new AbortController()
    const source = await startSource((_req, res) => {
      res.writeHead(200, { 'content-length': BODY.length })
      res.write(BODY.subarray(0, 4), () => controller.abort(new Error('aborted by caller')))
    })
    const mirror = await startSource(serveFile)

    await expect(
      downloadVerifiedFile([source.url, mirror.url], dest, SHA256, 'model', {
        init: { signal: controller.signal }
      })
    ).rejects.toThrow()

    expect(mirror.hits()).toHaveLength(0)
  })

  it('treats a cancellation racing a timeout as a cancellation', async () => {
    const controller = new AbortController()
    const stalled = await startSource(() => controller.abort(new Error('aborted by caller')))
    const mirror = await startSource(serveFile)

    await expect(
      downloadVerifiedFile([stalled.url, mirror.url], dest, SHA256, 'model', {
        ...FAST_TIMEOUTS,
        init: { signal: controller.signal }
      })
    ).rejects.toThrow()

    expect(mirror.hits()).toHaveLength(0)
    await downloadVerifiedFile(
      [stalled.url, mirror.url],
      join(root, 'later.bin'),
      SHA256,
      'later',
      {
        timeouts: { headerMs: 50, inactivityMs: 50 }
      }
    )
    expect(stalled.hits()).toHaveLength(2)
  })

  it('does not switch hosts for a local write failure', async () => {
    const source = await startSource(serveFile)
    const mirror = await startSource(serveFile)

    await expect(
      downloadVerifiedFile(
        [source.url, mirror.url],
        join(root, 'missing', 'model.bin'),
        SHA256,
        'm'
      )
    ).rejects.toThrow()

    expect(mirror.hits()).toHaveLength(0)
  })

  it('accepts an existing verified file without any request', async () => {
    await writeFile(dest, BODY)
    const source = await startSource(serveFile)

    await downloadVerifiedFile([source.url], dest, SHA256, 'model')

    expect(source.hits()).toHaveLength(0)
  })
})
