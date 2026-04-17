import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, access } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

const originalPlatform = process.platform

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform,
  })
}

async function loadWhisperManager(
  platform: 'darwin' | 'win32',
  rootDir: string,
  options?: { isPackaged?: boolean; ffmpegStaticPath?: string | null },
) {
  setPlatform(platform)
  vi.resetModules()

  const execSyncMock = vi.fn()
  const execFileMock = vi.fn((_file, _args, _options, callback) => {
    callback(null)
    return {} as never
  })

  vi.doMock('electron', () => ({
    app: {
      getPath: vi.fn(() => rootDir),
      isPackaged: options?.isPackaged ?? false,
    },
  }))

  vi.doMock('child_process', () => ({
    execFile: execFileMock,
    execSync: execSyncMock,
  }))

  vi.doMock('ffmpeg-static', () => ({
    default: options?.ffmpegStaticPath ?? null,
  }))

  const mod = await import('../whisper-manager')
  return {
    WhisperManager: mod.WhisperManager,
    execSyncMock,
    execFileMock,
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  vi.doUnmock('electron')
  vi.doUnmock('child_process')
  vi.doUnmock('ffmpeg-static')
  vi.resetModules()
  setPlatform(originalPlatform)
})

describe('Whisper onboarding dependency installation', () => {
  it('completes the packaged macOS dependency setup flow with managed runtime assets', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-whisper-mac-'))
    const bundledFfmpeg = join(rootDir, 'bundled-ffmpeg')
    await writeFile(bundledFfmpeg, 'ffmpeg')

    try {
      const { WhisperManager, execSyncMock } = await loadWhisperManager('darwin', rootDir, {
        isPackaged: true,
        ffmpegStaticPath: bundledFfmpeg,
      })
      execSyncMock.mockImplementation(() => {
        throw new Error('system lookup should not be used in packaged mode')
      })

      const manager = new WhisperManager()
      const downloadWhisperSpy = vi
        .spyOn(manager as never, 'downloadWhisperMac')
        .mockImplementation(async () => {
          await writeFile(manager.getWhisperPath(), 'whisper')
        })
      const downloadModelSpy = vi
        .spyOn(manager as never, 'downloadModel')
        .mockImplementation(async () => {
          await writeFile(manager.getModelPath(), 'model')
        })

      await manager.ensureReady()

      await expect(access(manager.getWhisperPath())).resolves.toBeUndefined()
      await expect(access(manager.getFfmpegPath())).resolves.toBeUndefined()
      await expect(access(manager.getModelPath())).resolves.toBeUndefined()
      expect(downloadWhisperSpy).toHaveBeenCalledTimes(1)
      expect(downloadModelSpy).toHaveBeenCalledTimes(1)
      expect(execSyncMock).not.toHaveBeenCalled()
      await expect(manager.isReady()).resolves.toBe(true)
      expect(manager.getSetupStatus()).toMatchObject({ phase: 'ready', percent: 100 })
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('still allows macOS dev builds to adopt system binaries', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-whisper-dev-mac-'))
    const systemBinDir = join(rootDir, 'system-bin')
    await mkdir(systemBinDir, { recursive: true })

    const whisperBinary = join(systemBinDir, 'whisper-cli')
    const ffmpegBinary = join(systemBinDir, 'ffmpeg')
    await writeFile(whisperBinary, 'whisper')
    await writeFile(ffmpegBinary, 'ffmpeg')

    try {
      const { WhisperManager, execSyncMock } = await loadWhisperManager('darwin', rootDir)
      execSyncMock.mockImplementation((command: string) => {
        if (command.includes('whisper-cli')) return whisperBinary
        if (command.includes('ffmpeg')) return ffmpegBinary
        throw new Error(`Unexpected command: ${command}`)
      })

      const manager = new WhisperManager()
      const downloadModelSpy = vi
        .spyOn(manager as never, 'downloadModel')
        .mockImplementation(async () => {
          await writeFile(manager.getModelPath(), 'model')
        })

      await manager.ensureReady()

      await expect(access(manager.getWhisperPath())).resolves.toBeUndefined()
      await expect(access(manager.getFfmpegPath())).resolves.toBeUndefined()
      await expect(access(manager.getModelPath())).resolves.toBeUndefined()
      expect(downloadModelSpy).toHaveBeenCalledTimes(1)
      await expect(manager.isReady()).resolves.toBe(true)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('completes the packaged Windows dependency setup flow and emits the full install sequence', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-whisper-win-'))
    const bundledFfmpeg = join(rootDir, 'bundled-ffmpeg.exe')
    await writeFile(bundledFfmpeg, 'bundled ffmpeg')

    try {
      const { WhisperManager, execSyncMock } = await loadWhisperManager('win32', rootDir, {
        isPackaged: true,
        ffmpegStaticPath: bundledFfmpeg,
      })
      execSyncMock.mockImplementation(() => {
        throw new Error('system lookup should not be used in packaged mode')
      })

      const manager = new WhisperManager()
      const statuses: string[] = []
      manager.on('setup-status', (status) => {
        statuses.push(status.phase)
      })

      vi.spyOn(manager as never, 'downloadWhisperWindows').mockImplementation(async () => {
        await writeFile(manager.getWhisperPath(), 'whisper exe')
        await writeFile(join(manager.getModelsDir(), 'whisper.dll'), 'dll')
        await writeFile(join(manager.getModelsDir(), 'ggml.dll'), 'dll')
      })

      vi.spyOn(manager as never, 'downloadModel').mockImplementation(async () => {
        await writeFile(manager.getModelPath(), 'model')
      })

      await manager.ensureReady()

      await expect(access(manager.getWhisperPath())).resolves.toBeUndefined()
      await expect(access(manager.getFfmpegPath())).resolves.toBeUndefined()
      await expect(access(manager.getModelPath())).resolves.toBeUndefined()
      await expect(access(join(manager.getModelsDir(), 'whisper.dll'))).resolves.toBeUndefined()
      await expect(access(join(manager.getModelsDir(), 'ggml.dll'))).resolves.toBeUndefined()
      expect(statuses).toEqual([
        'downloading-whisper',
        'downloading-ffmpeg',
        'downloading-model',
        'ready',
      ])
      expect(execSyncMock).not.toHaveBeenCalled()
      await expect(manager.isReady()).resolves.toBe(true)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})
