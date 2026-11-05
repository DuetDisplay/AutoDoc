import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

const realPlatform = process.platform
const MAC_SHA = '9f95b794325857d412c1a795db78fbb35aee3567a0b81868917606cdb2d693cb'
const WINDOWS_SHA = 'c869517b0852372d694c2978564a73b5aa70eaafe96d73aab1783971f7c2f9d2'

async function setup(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  vi.resetModules()
  const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-runtime-'))
  const downloadVerifiedFile = vi.fn().mockResolvedValue('verified')
  const execFile = vi.fn((_cmd: string, _args: string[], ...rest: unknown[]) => {
    const callback = rest.at(-1) as (error: Error | null) => void
    callback(null)
  })
  vi.doMock('electron', () => ({
    app: { getPath: vi.fn(() => rootDir), isPackaged: false }
  }))
  vi.doMock('child_process', () => ({ spawn: vi.fn(), execFile, execSync: vi.fn() }))
  vi.doMock('../autodoc-log', () => ({ logAutodocEvent: vi.fn(), logAutodocFailure: vi.fn() }))
  vi.doMock('../resumable-download', () => ({ downloadVerifiedFile }))
  vi.doMock('fs/promises', async (importOriginal) => ({
    ...(await importOriginal<typeof import('fs/promises')>()),
    chmod: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined)
  }))
  const { OllamaManager } = await import('../ollama-manager')
  const manager = new OllamaManager() as unknown as {
    downloadBinary(): Promise<void>
    emit(event: string, payload: unknown): boolean
    on(event: string, listener: (payload: unknown) => void): void
  }
  return { manager, downloadVerifiedFile, execFile, rootDir }
}

afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: realPlatform })
  vi.doUnmock('fs/promises')
  vi.doUnmock('../resumable-download')
})

describe.each([
  ['darwin', 'ollama-darwin.tgz', MAC_SHA, 'tar'],
  ['win32', 'ollama-windows-amd64.zip', WINDOWS_SHA, 'powershell']
] as const)('Ollama runtime download on %s', (platform, archive, sha256, extractor) => {
  it('verifies the pinned archive before extracting it', async () => {
    const { manager, downloadVerifiedFile, execFile, rootDir } = await setup(platform)
    try {
      await manager.downloadBinary()

      expect(downloadVerifiedFile).toHaveBeenCalledTimes(1)
      const [sources, dest, expected] = downloadVerifiedFile.mock.calls[0]
      expect(sources).toEqual([
        `https://github.com/ollama/ollama/releases/download/v0.30.0/${archive}`
      ])
      expect(String(dest)).toContain(platform === 'win32' ? 'ollama.zip' : archive)
      expect(expected).toBe(sha256)
      expect(execFile.mock.calls[0][0]).toBe(extractor)
      expect(downloadVerifiedFile.mock.invocationCallOrder[0]).toBeLessThan(
        execFile.mock.invocationCallOrder[0]
      )
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('never extracts an archive that failed verification', async () => {
    const { manager, downloadVerifiedFile, execFile, rootDir } = await setup(platform)
    try {
      downloadVerifiedFile.mockRejectedValue(new Error('failed SHA256 verification'))

      await expect(manager.downloadBinary()).rejects.toThrow(/SHA256/)

      expect(execFile).not.toHaveBeenCalled()
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('reports download progress for the runtime', async () => {
    const { manager, downloadVerifiedFile, rootDir } = await setup(platform)
    try {
      const onProgress = vi.fn()
      manager.on('download-progress', onProgress)
      downloadVerifiedFile.mockImplementation(async (_sources, _dest, _sha, _label, options) => {
        options.onBytes({ file: 'Ollama', percent: 50, bytesDownloaded: 5, bytesTotal: 10 })
        return 'verified'
      })

      await manager.downloadBinary()

      expect(onProgress).toHaveBeenCalledWith({
        file: 'ollama',
        percent: 50,
        bytesDownloaded: 5,
        bytesTotal: 10
      })
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})
