import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ReadStream } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startRecordingMediaHttpServer, stopRecordingMediaHttpServer } from '../media-http-server'

const { openedStreams } = vi.hoisted(() => ({ openedStreams: [] as ReadStream[] }))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
      const stream = actual.createReadStream(...args)
      openedStreams.push(stream)
      return stream
    }
  }
})

vi.mock('../crypto', () => ({
  isEncrypted: vi.fn().mockResolvedValue(false),
  getDecryptedTempPathForMedia: vi.fn(),
  clearMediaDecryptCache: vi.fn(),
  isCurrentBuildDecryptedTempFileName: vi.fn().mockReturnValue(false)
}))
vi.mock('../autodoc-log', () => ({ logAutodocFailure: vi.fn() }))

const meetingId = '11111111-1111-4111-8111-111111111111'
let root: string
let base: string

describe('recording media download responses', () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'autodoc-media-download-test-'))
    await mkdir(join(root, meetingId))
    await writeFile(join(root, meetingId, 'screen.webm'), 'synthetic-media-bytes')
    const port = await startRecordingMediaHttpServer(() => root)
    base = `http://127.0.0.1:${port}/media/${meetingId}/screen.webm`
  })
  afterAll(async () => {
    stopRecordingMediaHttpServer()
    if (root) await rm(root, { recursive: true, force: true })
  })

  it('preserves inline playback and only opts into attachment downloads explicitly', async () => {
    const inline = await fetch(base)
    expect(inline.status).toBe(200)
    expect(inline.headers.get('content-disposition')).toBeNull()
    expect(await inline.text()).toBe('synthetic-media-bytes')
    const download = await fetch(base + '?download=1')
    expect(download.status).toBe(200)
    expect(download.headers.get('content-disposition')).toBe('attachment; filename="screen.webm"')
    expect(await download.text()).toBe('synthetic-media-bytes')
  })

  it('retains byte-range playback and validates the same file paths for downloads', async () => {
    const partial = await fetch(base + '?download=1', { headers: { Range: 'bytes=2-5' } })
    expect(partial.status).toBe(206)
    expect(partial.headers.get('content-disposition')).toBe('attachment; filename="screen.webm"')
    expect(partial.headers.get('content-range')).toBe('bytes 2-5/21')
    expect(await partial.text()).toBe('nthe')
    const invalid = await fetch(base.replace(meetingId, 'not-a-meeting') + '?download=1')
    expect(invalid.status).toBe(404)
    expect(invalid.headers.get('content-disposition')).toBeNull()
  })
})

// The player aborts requests when it seeks or the page closes. A file left open
// afterwards blocks the Windows rename that encrypts the recording (AD-199).
describe('recording media aborted requests', () => {
  const largeSize = 64 * 1024 * 1024
  let largeUrl: string

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'autodoc-media-abort-test-'))
    await mkdir(join(root, meetingId))
    await writeFile(join(root, meetingId, 'system.webm'), Buffer.alloc(largeSize))
    const port = await startRecordingMediaHttpServer(() => root)
    largeUrl = `http://127.0.0.1:${port}/media/${meetingId}/system.webm`
  })
  afterAll(async () => {
    stopRecordingMediaHttpServer()
    if (root) await rm(root, { recursive: true, force: true })
  })

  async function abortAfterFirstChunk(headers: http.OutgoingHttpHeaders): Promise<ReadStream> {
    const before = openedStreams.length
    await new Promise<void>((resolve, reject) => {
      const req = http.get(largeUrl, { headers }, (res) => {
        res.once('data', () => {
          req.destroy()
          resolve()
        })
      })
      req.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(err)
      })
    })
    expect(openedStreams.length).toBe(before + 1)
    return openedStreams[before]
  }

  function closesWithin(stream: ReadStream, ms: number): Promise<boolean> {
    if (stream.closed) return Promise.resolve(true)
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms)
      stream.once('close', () => {
        clearTimeout(timer)
        resolve(true)
      })
    })
  }

  it('closes the file when a full response is aborted', async () => {
    const stream = await abortAfterFirstChunk({})
    expect(await closesWithin(stream, 2_000)).toBe(true)
  })

  it('closes the file when a range response is aborted', async () => {
    const stream = await abortAfterFirstChunk({ Range: `bytes=0-${largeSize - 2}` })
    expect(await closesWithin(stream, 2_000)).toBe(true)
  })
})
