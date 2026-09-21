import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'fs/promises'
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
