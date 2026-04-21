import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readlink, rm, writeFile, access, chmod, readFile } from 'fs/promises'
import { constants } from 'fs'
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
  const storageMod = await import('../storage-manager')
  return {
    WhisperManager: mod.WhisperManager,
    clearDownloadedComponents: storageMod.clearDownloadedComponents,
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

  it('creates macOS compatibility symlinks for packaged whisper dylibs', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-whisper-mac-links-'))

    try {
      const { WhisperManager } = await loadWhisperManager('darwin', rootDir, {
        isPackaged: true,
      })

      const manager = new WhisperManager()
      await mkdir(manager.getModelsDir(), { recursive: true })
      await writeFile(join(manager.getModelsDir(), 'libwhisper.1.8.4.dylib'), 'whisper dylib')
      await writeFile(join(manager.getModelsDir(), 'libggml.0.10.0.dylib'), 'ggml dylib')
      await writeFile(join(manager.getModelsDir(), 'libggml-base.0.10.0.dylib'), 'ggml base dylib')

      await (manager as any).ensureMacCompatibilitySymlinks()

      await expect(readlink(join(manager.getModelsDir(), 'libwhisper.1.dylib'))).resolves.toBe('libwhisper.1.8.4.dylib')
      await expect(readlink(join(manager.getModelsDir(), 'libggml.0.dylib'))).resolves.toBe('libggml.0.10.0.dylib')
      await expect(readlink(join(manager.getModelsDir(), 'libggml-base.0.dylib'))).resolves.toBe('libggml-base.0.10.0.dylib')
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('overwrites read-only macOS dylibs during setup retries', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-whisper-mac-retry-'))

    try {
      const { WhisperManager } = await loadWhisperManager('darwin', rootDir, {
        isPackaged: true,
      })

      const manager = new WhisperManager()
      const sourceDir = join(rootDir, 'source-libs')
      await mkdir(sourceDir, { recursive: true })
      await mkdir(manager.getModelsDir(), { recursive: true })

      const sourcePath = join(sourceDir, 'libwhisper.1.8.4.dylib')
      const destPath = join(manager.getModelsDir(), 'libwhisper.1.8.4.dylib')

      await writeFile(sourcePath, 'fresh dylib')
      await chmod(sourcePath, 0o444)
      await writeFile(destPath, 'stale dylib')
      await chmod(destPath, 0o444)

      await (manager as any).copyMatchingFiles(sourceDir, /^libwhisper.*\.dylib$/i, manager.getModelsDir())

      await expect(readFile(destPath, 'utf8')).resolves.toBe('fresh dylib')
      await expect(access(destPath, constants.W_OK)).resolves.toBeUndefined()
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

  it('re-downloads packaged macOS whisper assets after downloaded components are cleared', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-whisper-mac-recovery-'))
    const bundledFfmpeg = join(rootDir, 'bundled-ffmpeg')
    await writeFile(bundledFfmpeg, 'ffmpeg')

    try {
      const { WhisperManager, clearDownloadedComponents, execSyncMock } = await loadWhisperManager('darwin', rootDir, {
        isPackaged: true,
        ffmpegStaticPath: bundledFfmpeg,
      })
      execSyncMock.mockImplementation(() => {
        throw new Error('system lookup should not be used in packaged mode')
      })

      const manager = new WhisperManager()
      await mkdir(manager.getModelsDir(), { recursive: true })
      await writeFile(manager.getWhisperPath(), 'whisper')
      await writeFile(manager.getFfmpegPath(), 'ffmpeg')
      await writeFile(manager.getModelPath(), 'model')

      await expect(manager.isReady()).resolves.toBe(true)

      await clearDownloadedComponents()
      await expect(access(manager.getWhisperPath())).rejects.toThrow()
      await expect(access(manager.getFfmpegPath())).rejects.toThrow()
      await expect(access(manager.getModelPath())).rejects.toThrow()
      await expect(manager.isReady()).resolves.toBe(false)

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

      expect(downloadWhisperSpy).toHaveBeenCalledTimes(1)
      expect(downloadModelSpy).toHaveBeenCalledTimes(1)
      await expect(access(manager.getWhisperPath())).resolves.toBeUndefined()
      await expect(access(manager.getFfmpegPath())).resolves.toBeUndefined()
      await expect(access(manager.getModelPath())).resolves.toBeUndefined()
      expect(execSyncMock).not.toHaveBeenCalled()
      await expect(manager.isReady()).resolves.toBe(true)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('re-downloads packaged Windows whisper assets after downloaded components are cleared', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-whisper-win-recovery-'))
    const bundledFfmpeg = join(rootDir, 'bundled-ffmpeg.exe')
    await writeFile(bundledFfmpeg, 'ffmpeg')

    try {
      const { WhisperManager, clearDownloadedComponents, execSyncMock } = await loadWhisperManager('win32', rootDir, {
        isPackaged: true,
        ffmpegStaticPath: bundledFfmpeg,
      })
      execSyncMock.mockImplementation(() => {
        throw new Error('system lookup should not be used in packaged mode')
      })

      const manager = new WhisperManager()
      await mkdir(manager.getModelsDir(), { recursive: true })
      await writeFile(manager.getWhisperPath(), 'whisper exe')
      await writeFile(manager.getFfmpegPath(), 'ffmpeg exe')
      await writeFile(manager.getModelPath(), 'model')
      await writeFile(join(manager.getModelsDir(), 'whisper.dll'), 'dll')
      await writeFile(join(manager.getModelsDir(), 'ggml.dll'), 'dll')

      await expect(manager.isReady()).resolves.toBe(true)

      await clearDownloadedComponents()
      await expect(access(manager.getWhisperPath())).rejects.toThrow()
      await expect(access(manager.getFfmpegPath())).rejects.toThrow()
      await expect(access(manager.getModelPath())).rejects.toThrow()
      await expect(manager.isReady()).resolves.toBe(false)

      const downloadWhisperSpy = vi
        .spyOn(manager as never, 'downloadWhisperWindows')
        .mockImplementation(async () => {
          await writeFile(manager.getWhisperPath(), 'whisper exe')
          await writeFile(join(manager.getModelsDir(), 'whisper.dll'), 'dll')
          await writeFile(join(manager.getModelsDir(), 'ggml.dll'), 'dll')
        })
      const downloadModelSpy = vi
        .spyOn(manager as never, 'downloadModel')
        .mockImplementation(async () => {
          await writeFile(manager.getModelPath(), 'model')
        })

      await manager.ensureReady()

      expect(downloadWhisperSpy).toHaveBeenCalledTimes(1)
      expect(downloadModelSpy).toHaveBeenCalledTimes(1)
      await expect(access(manager.getWhisperPath())).resolves.toBeUndefined()
      await expect(access(manager.getFfmpegPath())).resolves.toBeUndefined()
      await expect(access(manager.getModelPath())).resolves.toBeUndefined()
      await expect(access(join(manager.getModelsDir(), 'whisper.dll'))).resolves.toBeUndefined()
      await expect(access(join(manager.getModelsDir(), 'ggml.dll'))).resolves.toBeUndefined()
      expect(execSyncMock).not.toHaveBeenCalled()
      await expect(manager.isReady()).resolves.toBe(true)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})
