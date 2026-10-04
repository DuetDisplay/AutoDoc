import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createHash } from 'crypto'
import { access, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
vi.mock('electron', () => ({ app: { getPath: () => '/unused', isPackaged: false } }))
vi.mock('../autodoc-log', () => ({ logAutodocEvent: vi.fn(), logAutodocFailure: vi.fn() }))
import { WhisperManager } from '../whisper-manager'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'autodoc-progress-test-'))
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(root, { recursive: true, force: true })
})
type Downloader = {
  downloadFile(
    url: string,
    dest: string,
    label: string,
    progress: (n: number) => void
  ): Promise<void>
  downloadWithRetry(fn: () => Promise<void>, label: string): Promise<void>
}
function response(known: boolean, fail = false, failAtChunk = 5000): Response {
  let chunks = 0
  return {
    ok: true,
    headers: new Headers(known ? { 'content-length': '5000' } : {}),
    body: {
      getReader: () => ({
        read: async () => {
          if (fail && chunks === failAtChunk) throw new Error('stream failed after last byte')
          if (chunks++ < 5000) return { done: false, value: new Uint8Array([42]) }
          return { done: true }
        }
      })
    }
  } as unknown as Response
}
it('deduplicates 5000 chunks, preserves bytes, and resets for the next asset', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(() => Promise.resolve(response(true)))
  )
  const manager = new WhisperManager() as unknown as Downloader
  for (const asset of ['one', 'two']) {
    const progress = vi.fn()
    await manager.downloadFile('https://test.invalid/asset', join(root, asset), asset, progress)
    const values = progress.mock.calls.map(([n]) => n)
    expect(values.length).toBeLessThanOrEqual(101)
    expect(values[0]).toBe(0)
    expect(values.at(-1)).toBe(100)
    expect(values.every((n, i) => i === 0 || n > values[i - 1])).toBe(true)
    expect(await readFile(join(root, asset))).toEqual(Buffer.alloc(5000, 42))
  }
})
it('reports unknown size once and still finishes writing the asset', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(false)))
  const progress = vi.fn()
  await (new WhisperManager() as unknown as Downloader).downloadFile(
    'https://test.invalid/a',
    join(root, 'a'),
    'a',
    progress
  )
  expect(progress.mock.calls).toEqual([[0]])
  expect((await readFile(join(root, 'a'))).length).toBe(5000)
})
it.each([500, 5000])(
  'retries after a stream error at chunk %i with fresh progress',
  async (failAtChunk) => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(response(true, true, failAtChunk))
        .mockResolvedValueOnce(response(true))
    )
    const manager = new WhisperManager() as unknown as Downloader
    const attempts: number[][] = []
    const errors: string[] = []
    await manager.downloadWithRetry(async () => {
      const values: number[] = []
      attempts.push(values)
      try {
        await manager.downloadFile('https://test.invalid/a', join(root, 'a'), 'a', (n) =>
          values.push(n)
        )
      } catch (error) {
        errors.push(String(error))
        throw error
      }
    }, 'a')
    expect(errors).toEqual(['Error: stream failed after last byte'])
    expect(attempts).toHaveLength(2)
    expect(attempts[0].at(-1)).toBe(failAtChunk / 50)
    expect(attempts[1].at(-1)).toBe(100)
    for (const values of attempts) {
      expect(values[0]).toBe(0)
      expect(values.length).toBeLessThanOrEqual(101)
    }
    expect((await readFile(join(root, 'a'))).length).toBe(5000)
  }
)

type ResumeDownloader = Downloader & {
  downloadFile(
    url: string,
    dest: string,
    label: string,
    progress?: (n: number) => void,
    init?: RequestInit,
    options?: { expectedSha256?: string }
  ): Promise<string | null>
}

function bytesResponse(
  body: Uint8Array,
  status = 200,
  extraHeaders: Record<string, string> = {}
): Response {
  let offset = 0
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 206 ? 'Partial Content' : 'OK',
    headers: new Headers({
      'content-length': String(body.length),
      ...extraHeaders
    }),
    body: {
      getReader: () => ({
        read: async () => {
          if (offset >= body.length) return { done: true, value: undefined }
          const value = body.subarray(offset, offset + 1)
          offset += 1
          return { done: false, value }
        }
      })
    }
  } as unknown as Response
}

it('resumes an interrupted download with HTTP Range and keeps the partial file', async () => {
  const full = Buffer.from('abcdefgh')
  const dest = join(root, 'resume.bin')
  const expectedSha256 = createHash('sha256').update(full).digest('hex')
  const fetchMock = vi
    .fn()
    .mockImplementationOnce(async () => {
      let chunks = 0
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-length': '8' }),
        body: {
          getReader: () => ({
            read: async () => {
              if (chunks >= 3) throw new Error('connection reset')
              const value = full.subarray(chunks, chunks + 1)
              chunks += 1
              return { done: false, value }
            }
          })
        }
      } as unknown as Response
    })
    .mockImplementationOnce(async (_url: string, init?: RequestInit) => {
      const range = new Headers(init?.headers).get('Range')
      expect(range).toBe('bytes=3-')
      return bytesResponse(full.subarray(3), 206, { 'content-range': 'bytes 3-7/8' })
    })
  vi.stubGlobal('fetch', fetchMock)

  const manager = new WhisperManager() as unknown as ResumeDownloader
  await expect(
    manager.downloadFile('https://test.invalid/resume', dest, 'resume', undefined, undefined, {
      expectedSha256
    })
  ).rejects.toThrow(/connection reset/)
  expect(await readFile(`${dest}.tmp`)).toEqual(full.subarray(0, 3))

  await manager.downloadFile('https://test.invalid/resume', dest, 'resume', undefined, undefined, {
    expectedSha256
  })
  expect(await readFile(dest)).toEqual(full)
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

it('restarts the file when the server answers 200 instead of 206', async () => {
  const full = Buffer.from('abcdefgh')
  const dest = join(root, 'no-range.bin')
  const expectedSha256 = createHash('sha256').update(full).digest('hex')
  await writeFile(`${dest}.tmp`, full.subarray(0, 3))
  const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
    expect(new Headers(init?.headers).get('Range')).toBe('bytes=3-')
    return bytesResponse(full, 200)
  })
  vi.stubGlobal('fetch', fetchMock)

  await (new WhisperManager() as unknown as ResumeDownloader).downloadFile(
    'https://test.invalid/full',
    dest,
    'full',
    undefined,
    undefined,
    { expectedSha256 }
  )
  const written = await readFile(dest)
  expect(written).toEqual(full)
  expect(createHash('sha256').update(written).digest('hex')).toBe(expectedSha256)
})

it('deletes a corrupt resumed partial, retries without Range, and verifies the hash', async () => {
  const full = Buffer.from('abcdefgh')
  const dest = join(root, 'corrupt.bin')
  const expectedSha256 = createHash('sha256').update(full).digest('hex')
  await writeFile(`${dest}.tmp`, Buffer.from('XXX'))
  const fetchMock = vi
    .fn()
    .mockImplementationOnce(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Range')).toBe('bytes=3-')
      return bytesResponse(full.subarray(3), 206, { 'content-range': 'bytes 3-7/8' })
    })
    .mockImplementationOnce(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Range')).toBeNull()
      return bytesResponse(full, 200)
    })
  vi.stubGlobal('fetch', fetchMock)

  await (new WhisperManager() as unknown as ResumeDownloader).downloadFile(
    'https://test.invalid/corrupt',
    dest,
    'corrupt',
    undefined,
    undefined,
    { expectedSha256 }
  )
  const written = await readFile(dest)
  expect(written).toEqual(full)
  expect(createHash('sha256').update(written).digest('hex')).toBe(expectedSha256)
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

it('restarts without Range after a 416 response', async () => {
  const full = Buffer.from('abcdefgh')
  const dest = join(root, 'range-unsat.bin')
  const expectedSha256 = createHash('sha256').update(full).digest('hex')
  await writeFile(`${dest}.tmp`, full.subarray(0, 3))
  const fetchMock = vi
    .fn()
    .mockImplementationOnce(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Range')).toBe('bytes=3-')
      return {
        ok: false,
        status: 416,
        statusText: 'Range Not Satisfiable',
        headers: new Headers(),
        body: null
      } as unknown as Response
    })
    .mockImplementationOnce(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Range')).toBeNull()
      return bytesResponse(full, 200)
    })
  vi.stubGlobal('fetch', fetchMock)

  await (new WhisperManager() as unknown as ResumeDownloader).downloadFile(
    'https://test.invalid/416',
    dest,
    '416',
    undefined,
    undefined,
    { expectedSha256 }
  )
  const written = await readFile(dest)
  expect(written).toEqual(full)
  expect(createHash('sha256').update(written).digest('hex')).toBe(expectedSha256)
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

it('ignores an existing .tmp on no-hash downloads and deletes it on failure', async () => {
  const dest = join(root, 'no-hash.bin')
  await writeFile(`${dest}.tmp`, Buffer.from('stale-partial'))
  const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
    expect(new Headers(init?.headers).get('Range')).toBeNull()
    return bytesResponse(new Uint8Array([1, 2, 3, 4, 5]), 200, { 'content-length': '10' })
  })
  vi.stubGlobal('fetch', fetchMock)

  await expect(
    (new WhisperManager() as unknown as ResumeDownloader).downloadFile(
      'https://test.invalid/no-hash',
      dest,
      'no-hash'
    )
  ).rejects.toThrow(/incomplete/i)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  await expect(access(dest)).rejects.toThrow()
  await expect(access(`${dest}.tmp`)).rejects.toThrow()
})

it('skips already-complete files that match sha256', async () => {
  const payload = Buffer.from('already complete')
  const dest = join(root, 'complete.bin')
  await writeFile(dest, payload)
  const expectedSha256 = createHash('sha256').update(payload).digest('hex')
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)

  await (new WhisperManager() as unknown as ResumeDownloader).downloadFile(
    'https://test.invalid/complete',
    dest,
    'complete',
    undefined,
    undefined,
    { expectedSha256 }
  )
  expect(fetchMock).not.toHaveBeenCalled()
  expect(await readFile(dest)).toEqual(payload)
})

it('deletes a checksum mismatch, re-downloads once, then errors', async () => {
  const dest = join(root, 'mismatch.bin')
  const expectedSha256 = createHash('sha256').update('expected payload').digest('hex')
  const fetchMock = vi.fn().mockImplementation(() => bytesResponse(Buffer.from('wrong payload')))
  vi.stubGlobal('fetch', fetchMock)

  await expect(
    (new WhisperManager() as unknown as ResumeDownloader).downloadFile(
      'https://test.invalid/mismatch',
      dest,
      'mismatch',
      undefined,
      undefined,
      { expectedSha256 }
    )
  ).rejects.toThrow(/SHA256 verification/i)
  expect(fetchMock).toHaveBeenCalledTimes(2)
  await expect(access(dest)).rejects.toThrow()
})

function windowsAssetProfile() {
  return {
    id: 'faster-whisper-cpu' as const,
    label: 'CPU optimized transcription',
    modelName: 'small.en',
    engine: 'faster-whisper' as const,
    device: 'cpu' as const,
    computeType: 'int8' as const,
    minSystemMemoryGiB: 8,
    estimatedMemoryGiB: 1.5,
    assets: []
  }
}

it('hashes a downloaded Windows archive once on the success path', async () => {
  const payload = Buffer.from('known payload')
  const expectedSha256 = createHash('sha256').update(payload).digest('hex')
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(bytesResponse(payload)))
  const manager = new WhisperManager()
  vi.spyOn(manager, 'getModelsDir').mockReturnValue(root)
  const hashSpy = vi.spyOn(manager as any, 'hashFileSha256')
  vi.spyOn(manager as any, 'extractWindowsTranscriptionAsset').mockResolvedValue(undefined)
  vi.spyOn(manager as any, 'getMissingExpectedFiles').mockResolvedValue([])

  await (manager as any).downloadAndExtractWindowsTranscriptionAsset(windowsAssetProfile(), {
    id: 'runtime',
    filename: 'faster-whisper-runtime-cpu-win-x64.zip',
    url: 'https://test.invalid/runtime.zip',
    sha256: expectedSha256,
    expectedFiles: ['python.exe']
  })

  expect(hashSpy).toHaveBeenCalledTimes(1)
})

it('hashes an already-present Windows archive once when skipping the download', async () => {
  const payload = Buffer.from('already on disk')
  const expectedSha256 = createHash('sha256').update(payload).digest('hex')
  const archivePath = join(root, 'faster-whisper-runtime-cpu-win-x64.zip')
  await writeFile(archivePath, payload)
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  const manager = new WhisperManager()
  vi.spyOn(manager, 'getModelsDir').mockReturnValue(root)
  const hashSpy = vi.spyOn(manager as any, 'hashFileSha256')
  vi.spyOn(manager as any, 'extractWindowsTranscriptionAsset').mockResolvedValue(undefined)
  vi.spyOn(manager as any, 'getMissingExpectedFiles').mockResolvedValue([])

  await (manager as any).downloadAndExtractWindowsTranscriptionAsset(windowsAssetProfile(), {
    id: 'runtime',
    filename: 'faster-whisper-runtime-cpu-win-x64.zip',
    url: 'https://test.invalid/runtime.zip',
    sha256: expectedSha256,
    expectedFiles: ['python.exe']
  })

  expect(fetchMock).not.toHaveBeenCalled()
  expect(hashSpy).toHaveBeenCalledTimes(1)
})
