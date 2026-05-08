import { createHash } from 'crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readlink, rm, writeFile, access, chmod, readFile } from 'fs/promises'
import { constants } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'

const originalPlatform = process.platform

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform
  })
}

async function loadWhisperManager(
  platform: 'darwin' | 'win32',
  rootDir: string,
  options?: {
    isPackaged?: boolean
    ffmpegStaticPath?: string | null
    windowsBackend?: 'faster-whisper-cuda' | 'faster-whisper-cpu' | 'whisper-cpp' | 'auto'
  }
) {
  setPlatform(platform)
  if (platform === 'win32' && options?.windowsBackend !== 'auto') {
    process.env.AUTODOC_WINDOWS_TRANSCRIPTION_BACKEND = options?.windowsBackend ?? 'whisper-cpp'
  }
  vi.resetModules()

  const execSyncMock = vi.fn()
  const execFileMock = vi.fn((_file, _args, _options, callback) => {
    callback(null)
    return {} as never
  })

  vi.doMock('electron', () => ({
    app: {
      getPath: vi.fn((name: string) => (name === 'appData' ? join(rootDir, 'app-data') : rootDir)),
      isPackaged: options?.isPackaged ?? false
    }
  }))

  vi.doMock('child_process', () => ({
    execFile: execFileMock,
    execSync: execSyncMock
  }))

  vi.doMock('ffmpeg-static', () => ({
    default: options?.ffmpegStaticPath ?? null
  }))

  const mod = await import('../whisper-manager')
  const storageMod = await import('../storage-manager')
  return {
    WhisperManager: mod.WhisperManager,
    clearDownloadedComponents: storageMod.clearDownloadedComponents,
    execSyncMock,
    execFileMock
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.doUnmock('electron')
  vi.doUnmock('child_process')
  vi.doUnmock('ffmpeg-static')
  delete process.env.AUTODOC_ALLOW_SYSTEM_RUNTIME_FALLBACK
  delete process.env.AUTODOC_WINDOWS_TRANSCRIPTION_BACKEND
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
        ffmpegStaticPath: bundledFfmpeg
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

  it('allows macOS dev builds to adopt system binaries when explicitly enabled', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-whisper-dev-mac-'))
    const systemBinDir = join(rootDir, 'system-bin')
    await mkdir(systemBinDir, { recursive: true })

    const whisperBinary = join(systemBinDir, 'whisper-cli')
    const ffmpegBinary = join(systemBinDir, 'ffmpeg')
    await writeFile(whisperBinary, 'whisper')
    await writeFile(ffmpegBinary, 'ffmpeg')

    try {
      process.env.AUTODOC_ALLOW_SYSTEM_RUNTIME_FALLBACK = '1'
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

  it('reuses installed app whisper assets in dev without redownloading them', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-whisper-dev-reuse-'))
    const installedModelsDir = join(rootDir, 'app-data', 'AutoDoc', 'models')

    try {
      await mkdir(installedModelsDir, { recursive: true })
      await writeFile(join(installedModelsDir, 'whisper-cli.exe'), 'whisper')
      await writeFile(join(installedModelsDir, 'ffmpeg.exe'), 'ffmpeg')
      await writeFile(join(installedModelsDir, 'ggml-distil-large-v3.bin'), 'model')

      const { WhisperManager, execSyncMock } = await loadWhisperManager('win32', rootDir)
      execSyncMock.mockImplementation(() => {
        throw new Error('system lookup should not be needed when installed assets exist')
      })

      const manager = new WhisperManager()
      const resolveWhisperSpy = vi.spyOn(manager as never, 'resolveWhisper')
      const downloadModelSpy = vi.spyOn(manager as never, 'downloadModel')

      await manager.ensureReady()

      expect(resolveWhisperSpy).not.toHaveBeenCalled()
      expect(downloadModelSpy).not.toHaveBeenCalled()
      await expect(access(manager.getWhisperPath())).resolves.toBeUndefined()
      await expect(access(manager.getFfmpegPath())).resolves.toBeUndefined()
      await expect(access(manager.getModelPath())).resolves.toBeUndefined()
      await expect(manager.isReady()).resolves.toBe(true)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('creates macOS compatibility symlinks for packaged whisper dylibs', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-whisper-mac-links-'))

    try {
      const { WhisperManager } = await loadWhisperManager('darwin', rootDir, {
        isPackaged: true
      })

      const manager = new WhisperManager()
      await mkdir(manager.getModelsDir(), { recursive: true })
      await writeFile(join(manager.getModelsDir(), 'libwhisper.1.8.4.dylib'), 'whisper dylib')
      await writeFile(join(manager.getModelsDir(), 'libggml.0.10.0.dylib'), 'ggml dylib')
      await writeFile(join(manager.getModelsDir(), 'libggml-base.0.10.0.dylib'), 'ggml base dylib')

      await (manager as any).ensureMacCompatibilitySymlinks()

      await expect(readlink(join(manager.getModelsDir(), 'libwhisper.1.dylib'))).resolves.toBe(
        'libwhisper.1.8.4.dylib'
      )
      await expect(readlink(join(manager.getModelsDir(), 'libggml.0.dylib'))).resolves.toBe(
        'libggml.0.10.0.dylib'
      )
      await expect(readlink(join(manager.getModelsDir(), 'libggml-base.0.dylib'))).resolves.toBe(
        'libggml-base.0.10.0.dylib'
      )
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('overwrites read-only macOS dylibs during setup retries', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-whisper-mac-retry-'))

    try {
      const { WhisperManager } = await loadWhisperManager('darwin', rootDir, {
        isPackaged: true
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

      await (manager as any).copyMatchingFiles(
        sourceDir,
        /^libwhisper.*\.dylib$/i,
        manager.getModelsDir()
      )

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
        ffmpegStaticPath: bundledFfmpeg
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
        'checking',
        'downloading-whisper',
        'downloading-ffmpeg',
        'downloading-model',
        'ready'
      ])
      expect(execSyncMock).not.toHaveBeenCalled()
      await expect(manager.isReady()).resolves.toBe(true)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('installs the CUDA faster-whisper profile on supported Windows NVIDIA hardware', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-whisper-win-cuda-'))
    const bundledFfmpeg = join(rootDir, 'bundled-ffmpeg.exe')
    await writeFile(bundledFfmpeg, 'bundled ffmpeg')

    try {
      const { WhisperManager, execSyncMock } = await loadWhisperManager('win32', rootDir, {
        isPackaged: true,
        ffmpegStaticPath: bundledFfmpeg,
        windowsBackend: 'faster-whisper-cuda'
      })
      execSyncMock.mockImplementation(() => {
        throw new Error('system lookup should not be used in packaged mode')
      })

      const manager = new WhisperManager()
      const statuses: Array<{ phase: string; backend?: string; backendLabel?: string }> = []
      manager.on('setup-status', (status) => {
        statuses.push({
          phase: status.phase,
          backend: status.backend,
          backendLabel: status.backendLabel
        })
      })

      const assetDownloads: string[] = []
      vi.spyOn(manager as any, 'downloadAndExtractWindowsTranscriptionAsset').mockImplementation(
        async (profile: any, asset: any) => {
          assetDownloads.push(asset.filename)
          const assetRoot = (manager as any).getFasterWhisperAssetRoot(profile, asset.id)
          for (const expectedFile of asset.expectedFiles) {
            const target = join(assetRoot, ...expectedFile.split('/'))
            await mkdir(dirname(target), { recursive: true })
            await writeFile(target, `${asset.id} file`)
          }
        }
      )
      vi.spyOn(manager as any, 'isFasterWhisperUsableWithRetry').mockResolvedValue(true)
      const resolveWhisperSpy = vi.spyOn(manager as any, 'resolveWhisper')
      const downloadModelSpy = vi.spyOn(manager as any, 'downloadModel')

      await manager.ensureReady()

      expect(manager.getTranscriptionBackend()).toBe('faster-whisper-cuda')
      expect(manager.getModelName()).toBe('distil-large-v3')
      expect(assetDownloads).toEqual([
        'faster-whisper-runtime-cuda-win-x64.zip',
        'faster-whisper-distil-large-v3-ct2.zip'
      ])
      expect(resolveWhisperSpy).not.toHaveBeenCalled()
      expect(downloadModelSpy).not.toHaveBeenCalled()
      await expect(access(manager.getFasterWhisperPythonPath())).resolves.toBeUndefined()
      await expect(
        access(join(manager.getFasterWhisperModelPath(), 'model.bin'))
      ).resolves.toBeUndefined()
      await expect(access(manager.getFfmpegPath())).resolves.toBeUndefined()
      expect(statuses).toContainEqual({
        phase: 'downloading-whisper',
        backend: 'faster-whisper-cuda',
        backendLabel: 'NVIDIA accelerated transcription'
      })
      expect(statuses.at(-1)).toMatchObject({
        phase: 'ready',
        backend: 'faster-whisper-cuda'
      })
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('installs the CPU faster-whisper profile on Windows without CUDA', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-whisper-win-fw-cpu-'))
    const bundledFfmpeg = join(rootDir, 'bundled-ffmpeg.exe')
    await writeFile(bundledFfmpeg, 'bundled ffmpeg')

    try {
      const { WhisperManager } = await loadWhisperManager('win32', rootDir, {
        isPackaged: true,
        ffmpegStaticPath: bundledFfmpeg,
        windowsBackend: 'faster-whisper-cpu'
      })

      const manager = new WhisperManager()
      const assetDownloads: string[] = []
      vi.spyOn(manager as any, 'downloadAndExtractWindowsTranscriptionAsset').mockImplementation(
        async (profile: any, asset: any) => {
          assetDownloads.push(asset.filename)
          const assetRoot = (manager as any).getFasterWhisperAssetRoot(profile, asset.id)
          for (const expectedFile of asset.expectedFiles) {
            const target = join(assetRoot, ...expectedFile.split('/'))
            await mkdir(dirname(target), { recursive: true })
            await writeFile(target, `${asset.id} file`)
          }
        }
      )
      vi.spyOn(manager as any, 'isFasterWhisperUsableWithRetry').mockResolvedValue(true)

      await manager.ensureReady()

      expect(manager.getTranscriptionBackend()).toBe('faster-whisper-cpu')
      expect(manager.getModelName()).toBe('small.en')
      expect(assetDownloads).toEqual([
        'faster-whisper-runtime-cpu-win-x64.zip',
        'faster-whisper-small-en-ct2-int8.zip'
      ])
      await expect(access(manager.getFasterWhisperPythonPath())).resolves.toBeUndefined()
      await expect(
        access(join(manager.getFasterWhisperModelPath(), 'tokenizer.json'))
      ).resolves.toBeUndefined()
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('falls back to whisper.cpp when the selected faster-whisper profile fails validation', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-whisper-win-fw-fallback-'))
    const bundledFfmpeg = join(rootDir, 'bundled-ffmpeg.exe')
    await writeFile(bundledFfmpeg, 'bundled ffmpeg')

    try {
      const { WhisperManager } = await loadWhisperManager('win32', rootDir, {
        isPackaged: true,
        ffmpegStaticPath: bundledFfmpeg,
        windowsBackend: 'faster-whisper-cuda'
      })

      const manager = new WhisperManager()
      vi.spyOn(manager as any, 'downloadAndExtractWindowsTranscriptionAsset').mockImplementation(
        async (profile: any, asset: any) => {
          const assetRoot = (manager as any).getFasterWhisperAssetRoot(profile, asset.id)
          for (const expectedFile of asset.expectedFiles) {
            const target = join(assetRoot, ...expectedFile.split('/'))
            await mkdir(dirname(target), { recursive: true })
            await writeFile(target, `${asset.id} file`)
          }
        }
      )
      vi.spyOn(manager as any, 'isFasterWhisperUsableWithRetry').mockResolvedValue(false)
      const resolveWhisperSpy = vi
        .spyOn(manager as any, 'resolveWhisper')
        .mockImplementation(async () => {
          await writeFile(manager.getWhisperPath(), 'whisper exe')
        })
      const downloadModelSpy = vi
        .spyOn(manager as any, 'downloadModel')
        .mockImplementation(async () => {
          await writeFile(manager.getModelPath(), 'model')
        })

      await manager.ensureReady()

      expect(manager.getTranscriptionBackend()).toBe('whisper-cpp')
      expect(resolveWhisperSpy).toHaveBeenCalledTimes(1)
      expect(downloadModelSpy).toHaveBeenCalledTimes(1)
      await expect(access(manager.getWhisperPath())).resolves.toBeUndefined()
      await expect(access(manager.getModelPath())).resolves.toBeUndefined()
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('verifies downloaded Windows faster-whisper assets with SHA256', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-whisper-win-sha-'))

    try {
      const { WhisperManager } = await loadWhisperManager('win32', rootDir, {
        windowsBackend: 'whisper-cpp'
      })
      const manager = new WhisperManager()
      const assetPath = join(rootDir, 'asset.zip')
      await writeFile(assetPath, 'known payload')
      const expectedSha256 = createHash('sha256').update('known payload').digest('hex')

      await expect(
        (manager as any).verifyFileSha256(assetPath, expectedSha256, 'asset.zip')
      ).resolves.toBeUndefined()
      await expect(access(assetPath)).resolves.toBeUndefined()
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('removes downloaded Windows faster-whisper assets when SHA256 verification fails', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-whisper-win-sha-fail-'))

    try {
      const { WhisperManager } = await loadWhisperManager('win32', rootDir, {
        windowsBackend: 'whisper-cpp'
      })
      const manager = new WhisperManager()
      const assetPath = join(rootDir, 'asset.zip')
      await writeFile(assetPath, 'known payload')

      await expect(
        (manager as any).verifyFileSha256(
          assetPath,
          'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
          'asset.zip'
        )
      ).rejects.toThrow(/SHA256 verification/i)
      await expect(access(assetPath)).rejects.toThrow()
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('resolves packaged Windows FFmpeg from the unpacked app asset path', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-whisper-win-unpacked-'))
    const packagedFfmpeg = join(
      rootDir,
      'resources',
      'app.asar',
      'node_modules',
      'ffmpeg-static',
      'ffmpeg.exe'
    )
    const unpackedFfmpeg = join(
      rootDir,
      'resources',
      'app.asar.unpacked',
      'node_modules',
      'ffmpeg-static',
      'ffmpeg.exe'
    )
    await mkdir(dirname(unpackedFfmpeg), { recursive: true })
    await writeFile(unpackedFfmpeg, 'bundled ffmpeg')

    try {
      const { WhisperManager, execSyncMock } = await loadWhisperManager('win32', rootDir, {
        isPackaged: true,
        ffmpegStaticPath: packagedFfmpeg
      })
      execSyncMock.mockImplementation(() => {
        throw new Error('system lookup should not be used in packaged mode')
      })

      const manager = new WhisperManager()
      vi.spyOn(manager as never, 'downloadWhisperWindows').mockImplementation(async () => {
        await writeFile(manager.getWhisperPath(), 'whisper exe')
      })
      vi.spyOn(manager as never, 'downloadModel').mockImplementation(async () => {
        await writeFile(manager.getModelPath(), 'model')
      })

      await manager.ensureReady()

      await expect(readFile(manager.getFfmpegPath(), 'utf8')).resolves.toBe('bundled ffmpeg')
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
      const { WhisperManager, clearDownloadedComponents, execSyncMock } = await loadWhisperManager(
        'darwin',
        rootDir,
        {
          isPackaged: true,
          ffmpegStaticPath: bundledFfmpeg
        }
      )
      execSyncMock.mockImplementation(() => {
        throw new Error('system lookup should not be used in packaged mode')
      })

      const manager = new WhisperManager()
      await mkdir(manager.getModelsDir(), { recursive: true })
      await writeFile(manager.getWhisperPath(), 'whisper')
      await writeFile(manager.getFfmpegPath(), 'ffmpeg')
      await writeFile(manager.getModelPath(), 'model')
      ;(manager as any).runtimeValidated = true

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
      const { WhisperManager, clearDownloadedComponents, execSyncMock } = await loadWhisperManager(
        'win32',
        rootDir,
        {
          isPackaged: true,
          ffmpegStaticPath: bundledFfmpeg
        }
      )
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
      ;(manager as any).runtimeValidated = true

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

  it('retries transient Windows whisper probe failures before redownloading assets', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-whisper-win-probe-retry-'))
    const bundledFfmpeg = join(rootDir, 'bundled-ffmpeg.exe')
    await writeFile(bundledFfmpeg, 'ffmpeg')

    try {
      const { WhisperManager, execSyncMock } = await loadWhisperManager('win32', rootDir, {
        isPackaged: true,
        ffmpegStaticPath: bundledFfmpeg
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

      const usabilityChecks = vi
        .spyOn(manager as never, 'isWhisperUsable')
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true)
      const downloadModelSpy = vi.spyOn(manager as never, 'downloadModel')
      const resolveWhisperSpy = vi.spyOn(manager as never, 'resolveWhisper')

      await manager.ensureReady()

      expect(usabilityChecks).toHaveBeenCalledTimes(2)
      expect(downloadModelSpy).not.toHaveBeenCalled()
      expect(resolveWhisperSpy).not.toHaveBeenCalled()
      await expect(manager.isReady()).resolves.toBe(true)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  }, 10000)

  it('does not redownload installed Windows assets when the startup probe times out after loading the model', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-whisper-win-probe-timeout-'))
    const bundledFfmpeg = join(rootDir, 'bundled-ffmpeg.exe')
    await writeFile(bundledFfmpeg, 'ffmpeg')

    try {
      const { WhisperManager, execFileMock, execSyncMock } = await loadWhisperManager(
        'win32',
        rootDir,
        {
          isPackaged: true,
          ffmpegStaticPath: bundledFfmpeg
        }
      )
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

      execFileMock.mockImplementation((file, _args, optionsOrCallback, maybeCallback) => {
        const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback
        if (file === manager.getWhisperPath()) {
          const err = new Error('Command failed: whisper probe timed out') as Error & {
            killed?: boolean
            signal?: string
            code?: string
          }
          err.killed = true
          err.signal = 'SIGTERM'
          err.code = 'ETIMEDOUT'
          callback(
            err,
            '',
            [
              `whisper_init_from_file_with_params_no_state: loading model from '${manager.getModelPath()}'`,
              'whisper_model_load: model size    = 1518.88 MB',
              'main: processing probe.wav (16000 samples, 1.0 sec)'
            ].join('\n')
          )
          return {} as never
        }

        callback(null, '', '')
        return {} as never
      })

      const downloadModelSpy = vi
        .spyOn(manager as never, 'downloadModel')
        .mockImplementation(async () => {
          await writeFile(manager.getModelPath(), 'redownloaded-model')
        })
      const resolveWhisperSpy = vi
        .spyOn(manager as never, 'resolveWhisper')
        .mockImplementation(async () => {
          await writeFile(manager.getWhisperPath(), 'redownloaded-whisper')
        })

      await manager.ensureReady()

      expect(downloadModelSpy).not.toHaveBeenCalled()
      expect(resolveWhisperSpy).not.toHaveBeenCalled()
      await expect(readFile(manager.getModelPath(), 'utf8')).resolves.toBe('model')
      await expect(readFile(manager.getWhisperPath(), 'utf8')).resolves.toBe('whisper exe')
      await expect(manager.isReady()).resolves.toBe(true)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  }, 10000)

  it('does not redownload after recording post-processing re-enters setup from a slow onboarding probe failure', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-whisper-win-recording-loop-'))
    const bundledFfmpeg = join(rootDir, 'bundled-ffmpeg.exe')
    await writeFile(bundledFfmpeg, 'ffmpeg')

    try {
      const { WhisperManager, execFileMock, execSyncMock } = await loadWhisperManager(
        'win32',
        rootDir,
        {
          isPackaged: true,
          ffmpegStaticPath: bundledFfmpeg
        }
      )
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

      execFileMock.mockImplementation((file, _args, optionsOrCallback, maybeCallback) => {
        const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback
        if (file === manager.getWhisperPath()) {
          const err = new Error('Command failed: whisper probe timed out') as Error & {
            killed?: boolean
            signal?: string
            code?: string
          }
          err.killed = true
          err.signal = 'SIGTERM'
          err.code = 'ETIMEDOUT'
          callback(
            err,
            '',
            [
              `whisper_init_from_file_with_params_no_state: loading model from '${manager.getModelPath()}'`,
              'whisper_model_load: model size    = 1518.88 MB',
              'main: processing probe.wav (16000 samples, 1.0 sec)'
            ].join('\n')
          )
          return {} as never
        }

        callback(null, '', '')
        return {} as never
      })

      const downloadModelSpy = vi
        .spyOn(manager as never, 'downloadModel')
        .mockImplementation(async () => {
          await writeFile(manager.getModelPath(), 'redownloaded-model')
        })
      const resolveWhisperSpy = vi
        .spyOn(manager as never, 'resolveWhisper')
        .mockImplementation(async () => {
          await writeFile(manager.getWhisperPath(), 'redownloaded-whisper')
        })

      ;(manager as any).setupStatus = {
        phase: 'error',
        percent: 0,
        error:
          'whisper-cli failed startup validation after setup. Required Windows runtime files may be missing.',
        failedStep: 'downloading-whisper'
      }

      await manager.ensureReady()

      expect(downloadModelSpy).not.toHaveBeenCalled()
      expect(resolveWhisperSpy).not.toHaveBeenCalled()
      await expect(readFile(manager.getModelPath(), 'utf8')).resolves.toBe('model')
      await expect(readFile(manager.getWhisperPath(), 'utf8')).resolves.toBe('whisper exe')
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  }, 10000)

  it('re-downloads a corrupt packaged macOS model after probe validation fails', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-whisper-mac-model-recovery-'))
    const bundledFfmpeg = join(rootDir, 'bundled-ffmpeg')
    await writeFile(bundledFfmpeg, 'ffmpeg')

    try {
      const { WhisperManager } = await loadWhisperManager('darwin', rootDir, {
        isPackaged: true,
        ffmpegStaticPath: bundledFfmpeg
      })

      const manager = new WhisperManager()
      await mkdir(manager.getModelsDir(), { recursive: true })
      await writeFile(manager.getWhisperPath(), 'whisper')
      await writeFile(manager.getFfmpegPath(), 'ffmpeg')
      await writeFile(manager.getModelPath(), 'stale-model')

      const usabilityChecks = vi
        .spyOn(manager as never, 'isWhisperUsable')
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true)
      const downloadModelSpy = vi
        .spyOn(manager as never, 'downloadModel')
        .mockImplementation(async () => {
          await writeFile(manager.getModelPath(), 'fresh-model')
        })
      const resolveWhisperSpy = vi.spyOn(manager as never, 'resolveWhisper')

      await manager.ensureReady()

      expect(downloadModelSpy).toHaveBeenCalledTimes(1)
      expect(resolveWhisperSpy).not.toHaveBeenCalled()
      expect(usabilityChecks).toHaveBeenCalledTimes(4)
      await expect(readFile(manager.getModelPath(), 'utf8')).resolves.toBe('fresh-model')
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('rejects incomplete model downloads and leaves no partial file behind', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-whisper-mac-partial-download-'))
    const bundledFfmpeg = join(rootDir, 'bundled-ffmpeg')
    await writeFile(bundledFfmpeg, 'ffmpeg')

    try {
      const { WhisperManager } = await loadWhisperManager('darwin', rootDir, {
        isPackaged: true,
        ffmpegStaticPath: bundledFfmpeg
      })

      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          ok: true,
          headers: {
            get: (name: string) => (name.toLowerCase() === 'content-length' ? '10' : null)
          },
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2, 3, 4, 5]))
              controller.close()
            }
          })
        }))
      )

      const manager = new WhisperManager()
      await mkdir(manager.getModelsDir(), { recursive: true })

      await expect((manager as any).downloadModel()).rejects.toThrow(/incomplete/i)
      await expect(access(manager.getModelPath())).rejects.toThrow()
      await expect(access(`${manager.getModelPath()}.tmp`)).rejects.toThrow()
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('silently recovers from a partial packaged macOS model left on disk', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-whisper-mac-partial-recovery-'))
    const bundledFfmpeg = join(rootDir, 'bundled-ffmpeg')
    await writeFile(bundledFfmpeg, 'ffmpeg')

    try {
      const { WhisperManager } = await loadWhisperManager('darwin', rootDir, {
        isPackaged: true,
        ffmpegStaticPath: bundledFfmpeg
      })

      const manager = new WhisperManager()
      await mkdir(manager.getModelsDir(), { recursive: true })
      await writeFile(manager.getWhisperPath(), 'whisper')
      await writeFile(manager.getFfmpegPath(), 'ffmpeg')
      await writeFile(manager.getModelPath(), 'partial-model')

      const resolveWhisperSpy = vi.spyOn(manager as never, 'resolveWhisper')
      const usabilityChecks = vi
        .spyOn(manager as never, 'isWhisperUsable')
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true)
      const downloadModelSpy = vi
        .spyOn(manager as never, 'downloadModel')
        .mockImplementation(async () => {
          await writeFile(manager.getModelPath(), 'recovered-model')
        })

      await manager.ensureReady()

      expect(downloadModelSpy).toHaveBeenCalledTimes(1)
      expect(resolveWhisperSpy).not.toHaveBeenCalled()
      expect(usabilityChecks).toHaveBeenCalledTimes(4)
      await expect(readFile(manager.getModelPath(), 'utf8')).resolves.toBe('recovered-model')
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})
