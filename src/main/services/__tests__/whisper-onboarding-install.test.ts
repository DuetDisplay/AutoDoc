import { createHash } from 'crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readlink, rm, writeFile, access, chmod, readFile } from 'fs/promises'
import { constants } from 'fs'
import { delimiter, dirname, join } from 'path'
import { tmpdir } from 'os'

const originalPlatform = process.platform
const originalArch = process.arch
const originalTestUserDataDir = process.env.AUTODOC_TEST_USER_DATA_DIR
const originalWindowsAssetBaseUrl = process.env.AUTODOC_WINDOWS_TRANSCRIPTION_ASSET_BASE_URL
const originalResourcesPathDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
type ExecFileCallback = (error: Error | null, stdout?: string, stderr?: string) => void

function getExecFileCallback(
  optionsOrCallback: unknown,
  maybeCallback?: unknown
): ExecFileCallback {
  const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback
  if (typeof callback !== 'function') {
    throw new Error('Expected execFile callback in test')
  }

  return callback as ExecFileCallback
}

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform
  })
}

function setArch(arch: NodeJS.Architecture) {
  Object.defineProperty(process, 'arch', {
    configurable: true,
    value: arch
  })
}

async function loadWhisperManager(
  platform: 'darwin' | 'win32',
  rootDir: string,
  options?: {
    isPackaged?: boolean
    ffmpegStaticPath?: string | null
    macBackend?: 'mlx-whisper' | 'whisper-cpp' | 'auto'
    windowsBackend?:
      | 'faster-whisper-cuda'
      | 'faster-whisper-cpu'
      | 'parakeet-gpu'
      | 'parakeet-cpu'
      | 'whisper-cpp'
      | 'auto'
  }
) {
  setPlatform(platform)
  if (platform === 'darwin' && options?.macBackend && options.macBackend !== 'auto') {
    process.env.AUTODOC_MAC_TRANSCRIPTION_BACKEND = options.macBackend
  }
  if (platform === 'win32' && options?.windowsBackend && options.windowsBackend !== 'auto') {
    process.env.AUTODOC_WINDOWS_TRANSCRIPTION_BACKEND = options.windowsBackend
    if (
      options.windowsBackend !== 'whisper-cpp' &&
      !process.env.AUTODOC_WINDOWS_TRANSCRIPTION_ASSET_BASE_URL
    ) {
      process.env.AUTODOC_WINDOWS_TRANSCRIPTION_ASSET_BASE_URL = 'https://example.invalid/autodoc'
    }
  }
  vi.resetModules()

  const execSyncMock = vi.fn()
  const execFileMock = vi.fn((_file, _args, optionsOrCallback, callback) => {
    const resolvedCallback = getExecFileCallback(optionsOrCallback, callback)
    resolvedCallback(null)
    return {} as never
  })

  vi.doMock('electron', () => ({
    app: {
      getPath: vi.fn((name: string) => (name === 'appData' ? join(rootDir, 'app-data') : rootDir)),
      getAppPath: vi.fn(() => rootDir),
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
  delete process.env.AUTODOC_MAC_TRANSCRIPTION_BACKEND
  delete process.env.AUTODOC_WINDOWS_TRANSCRIPTION_BACKEND
  if (originalWindowsAssetBaseUrl == null) {
    delete process.env.AUTODOC_WINDOWS_TRANSCRIPTION_ASSET_BASE_URL
  } else {
    process.env.AUTODOC_WINDOWS_TRANSCRIPTION_ASSET_BASE_URL = originalWindowsAssetBaseUrl
  }
  if (originalTestUserDataDir == null) {
    delete process.env.AUTODOC_TEST_USER_DATA_DIR
  } else {
    process.env.AUTODOC_TEST_USER_DATA_DIR = originalTestUserDataDir
  }
  if (originalResourcesPathDescriptor) {
    Object.defineProperty(process, 'resourcesPath', originalResourcesPathDescriptor)
  } else {
    Reflect.deleteProperty(process, 'resourcesPath')
  }
  vi.resetModules()
  setPlatform(originalPlatform)
  setArch(originalArch)
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
        macBackend: 'whisper-cpp'
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

  it('uses MLX Whisper by default on Apple Silicon without reporting a model download during validation', async () => {
    setArch('arm64')
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-whisper-mac-mlx-'))
    const bundledFfmpeg = join(rootDir, 'bundled-ffmpeg')
    await writeFile(bundledFfmpeg, 'ffmpeg')

    try {
      const { WhisperManager, execSyncMock } = await loadWhisperManager('darwin', rootDir, {
        ffmpegStaticPath: bundledFfmpeg,
        isPackaged: true,
        macBackend: 'auto'
      })
      execSyncMock.mockImplementation(() => {
        throw new Error('system lookup should not be used when packaged ffmpeg exists')
      })

      const manager = new WhisperManager()
      await mkdir(dirname(manager.getMlxWhisperPythonPath()), { recursive: true })
      await mkdir(dirname(manager.getMlxWhisperScriptPath()), { recursive: true })
      await writeFile(manager.getMlxWhisperPythonPath(), 'python')
      await writeFile(manager.getMlxWhisperScriptPath(), 'bridge')
      await writeFile(
        join((manager as any).getMlxWhisperRuntimeDir(), 'AUTODOC_MLX_WHISPER_READY.txt'),
        'ready'
      )

      const statuses: Array<{ phase: string; backend?: string; backendLabel?: string }> = []
      manager.on('setup-status', (status) => {
        statuses.push({
          phase: status.phase,
          backend: status.backend,
          backendLabel: status.backendLabel
        })
      })

      vi.spyOn(manager as any, 'isMlxWhisperUsableWithRetry').mockResolvedValue(true)

      await manager.ensureReady()

      expect(manager.getTranscriptionBackend()).toBe('mlx-whisper')
      expect(manager.getModelName()).toBe('distil-large-v3')
      await expect(access(manager.getMlxWhisperPythonPath())).resolves.toBeUndefined()
      await expect(access(manager.getMlxWhisperScriptPath())).resolves.toBeUndefined()
      await expect(access(manager.getFfmpegPath())).resolves.toBeUndefined()
      expect(statuses).toContainEqual({
        phase: 'checking',
        backend: 'mlx-whisper',
        backendLabel: 'Apple Silicon optimized transcription'
      })
      expect(statuses).not.toContainEqual({
        phase: 'downloading-model',
        backend: 'mlx-whisper',
        backendLabel: 'Apple Silicon optimized transcription'
      })
      expect(statuses.at(-1)).toMatchObject({
        phase: 'ready',
        backend: 'mlx-whisper'
      })
      await expect(manager.isReady()).resolves.toBe(true)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('falls back to whisper.cpp when the bundled MLX Whisper runtime is incomplete', async () => {
    setArch('arm64')
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-whisper-mac-mlx-incomplete-'))
    const bundledFfmpeg = join(rootDir, 'bundled-ffmpeg')
    await writeFile(bundledFfmpeg, 'ffmpeg')

    try {
      const { WhisperManager } = await loadWhisperManager('darwin', rootDir, {
        ffmpegStaticPath: bundledFfmpeg,
        isPackaged: true,
        macBackend: 'auto'
      })

      const manager = new WhisperManager()
      await mkdir(dirname(manager.getMlxWhisperPythonPath()), { recursive: true })
      await mkdir(dirname(manager.getMlxWhisperScriptPath()), { recursive: true })
      await writeFile(manager.getMlxWhisperPythonPath(), 'python')
      await writeFile(manager.getMlxWhisperScriptPath(), 'bridge')

      const usabilitySpy = vi.spyOn(manager as any, 'isMlxWhisperUsableWithRetry')
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

      expect(usabilitySpy).not.toHaveBeenCalled()
      expect(downloadWhisperSpy).toHaveBeenCalledTimes(1)
      expect(downloadModelSpy).toHaveBeenCalledTimes(1)
      expect(manager.getTranscriptionBackend()).toBe('whisper-cpp')
      await expect(manager.isReady()).resolves.toBe(true)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('clears the MLX Whisper model cache and retries after probe validation fails', async () => {
    setArch('arm64')
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-whisper-mac-mlx-retry-'))
    const bundledFfmpeg = join(rootDir, 'bundled-ffmpeg')
    await writeFile(bundledFfmpeg, 'ffmpeg')

    try {
      const { WhisperManager } = await loadWhisperManager('darwin', rootDir, {
        ffmpegStaticPath: bundledFfmpeg,
        isPackaged: true,
        macBackend: 'auto'
      })

      const manager = new WhisperManager()
      await mkdir(dirname(manager.getMlxWhisperPythonPath()), { recursive: true })
      await mkdir(dirname(manager.getMlxWhisperScriptPath()), { recursive: true })
      await writeFile(manager.getMlxWhisperPythonPath(), 'python')
      await writeFile(manager.getMlxWhisperScriptPath(), 'bridge')
      await writeFile(
        join((manager as any).getMlxWhisperRuntimeDir(), 'AUTODOC_MLX_WHISPER_READY.txt'),
        'ready'
      )

      const staleCacheFile = join((manager as any).getMlxWhisperCacheDir(), 'stale-model-file')
      await mkdir(dirname(staleCacheFile), { recursive: true })
      await writeFile(staleCacheFile, 'stale')

      const statuses: Array<{ phase: string; backend?: string; backendLabel?: string }> = []
      manager.on('setup-status', (status) => {
        statuses.push({
          phase: status.phase,
          backend: status.backend,
          backendLabel: status.backendLabel
        })
      })
      const usabilitySpy = vi
        .spyOn(manager as any, 'isMlxWhisperUsableWithRetry')
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true)

      await manager.ensureReady()

      expect(usabilitySpy).toHaveBeenCalledTimes(2)
      await expect(access(staleCacheFile)).rejects.toThrow()
      expect(statuses).toContainEqual({
        phase: 'downloading-model',
        backend: 'mlx-whisper',
        backendLabel: 'Apple Silicon optimized transcription'
      })
      expect(statuses.at(-1)).toMatchObject({
        phase: 'ready',
        backend: 'mlx-whisper'
      })
      await expect(manager.isReady()).resolves.toBe(true)
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
      const { WhisperManager, execSyncMock } = await loadWhisperManager('darwin', rootDir, {
        macBackend: 'whisper-cpp'
      })
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
      delete process.env.AUTODOC_TEST_USER_DATA_DIR
      await mkdir(installedModelsDir, { recursive: true })
      await writeFile(join(installedModelsDir, 'whisper-cli.exe'), 'whisper')
      await writeFile(join(installedModelsDir, 'ffmpeg.exe'), 'ffmpeg')
      await writeFile(join(installedModelsDir, 'ggml-base.en.bin'), 'model')

      const { WhisperManager, execSyncMock } = await loadWhisperManager('win32', rootDir, {
        windowsBackend: 'whisper-cpp'
      })
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

  it('resolves packaged Windows transcription resources from app.asar.unpacked', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-whisper-packaged-resources-'))
    const resourcesPath = join(rootDir, 'resources')
    const unpackedResourcesPath = join(resourcesPath, 'app.asar.unpacked', 'resources')

    try {
      await mkdir(unpackedResourcesPath, { recursive: true })
      await writeFile(join(unpackedResourcesPath, 'windows-transcription-manifest.json'), '{}')
      await writeFile(join(unpackedResourcesPath, 'transcription-worker.py'), 'print("ok")')
      Object.defineProperty(process, 'resourcesPath', {
        configurable: true,
        value: resourcesPath
      })

      const { WhisperManager } = await loadWhisperManager('win32', rootDir, {
        isPackaged: true,
        windowsBackend: 'whisper-cpp'
      })
      const manager = new WhisperManager()

      expect((manager as any).getWindowsTranscriptionManifestPath()).toBe(
        join(unpackedResourcesPath, 'windows-transcription-manifest.json')
      )
      expect(manager.getTranscriptionWorkerScriptPath()).toBe(
        join(unpackedResourcesPath, 'transcription-worker.py')
      )
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('repairs packaged macOS runtime linker failures without redownloading the speech model', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-whisper-mac-runtime-repair-'))
    const bundledFfmpeg = join(rootDir, 'bundled-ffmpeg')
    await writeFile(bundledFfmpeg, 'ffmpeg')

    try {
      const { WhisperManager } = await loadWhisperManager('darwin', rootDir, {
        isPackaged: true,
        ffmpegStaticPath: bundledFfmpeg,
        macBackend: 'whisper-cpp'
      })

      const manager = new WhisperManager()
      await mkdir(manager.getModelsDir(), { recursive: true })
      await writeFile(manager.getWhisperPath(), 'broken-whisper')
      await writeFile(manager.getFfmpegPath(), 'ffmpeg')
      await writeFile(manager.getModelPath(), 'existing-model')
      await writeFile(join(manager.getModelsDir(), 'libwhisper.1.dylib'), 'broken-lib')

      const usabilityChecks = vi
        .spyOn(manager as never, 'isWhisperUsable')
        .mockResolvedValueOnce('runtime-link-failure')
        .mockResolvedValueOnce('runtime-link-failure')
        .mockResolvedValueOnce('runtime-link-failure')
        .mockResolvedValueOnce('ready')
      const resolveWhisperSpy = vi
        .spyOn(manager as never, 'resolveWhisper')
        .mockImplementation(async () => {
          await writeFile(manager.getWhisperPath(), 'fixed-whisper')
          await writeFile(join(manager.getModelsDir(), 'libwhisper.1.dylib'), 'fixed-lib')
        })
      const downloadModelSpy = vi
        .spyOn(manager as never, 'downloadModel')
        .mockImplementation(async () => {
          await writeFile(manager.getModelPath(), 'redownloaded-model')
        })

      await manager.ensureReady()

      expect(resolveWhisperSpy).toHaveBeenCalledTimes(1)
      expect(downloadModelSpy).not.toHaveBeenCalled()
      expect(usabilityChecks).toHaveBeenCalledTimes(4)
      await expect(readFile(manager.getWhisperPath(), 'utf8')).resolves.toBe('fixed-whisper')
      await expect(readFile(manager.getModelPath(), 'utf8')).resolves.toBe('existing-model')
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('installs bundled packaged macOS whisper runtime without rewriting binaries on the customer machine', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-whisper-mac-bundled-runtime-'))
    const bundledRuntimeDir = join(rootDir, 'resources', 'macos-whisper-runtime', process.arch)

    try {
      await mkdir(bundledRuntimeDir, { recursive: true })
      await writeFile(join(bundledRuntimeDir, 'whisper-cpp'), 'bundled-whisper')
      await writeFile(join(bundledRuntimeDir, 'libwhisper.1.dylib'), 'bundled-lib')
      await writeFile(join(bundledRuntimeDir, 'libggml-base.0.dylib'), 'bundled-lib')
      await writeFile(join(bundledRuntimeDir, 'libggml.0.dylib'), 'bundled-lib')
      await writeFile(join(bundledRuntimeDir, 'libomp.dylib'), 'bundled-lib')
      await writeFile(join(bundledRuntimeDir, 'libggml-metal.so'), 'bundled-lib')

      const { WhisperManager, execFileMock } = await loadWhisperManager('darwin', rootDir, {
        isPackaged: true,
        macBackend: 'whisper-cpp'
      })

      const manager = new WhisperManager()

      await (manager as any).downloadWhisperMac()

      expect(
        execFileMock.mock.calls.some(([command]) =>
          ['install_name_tool', 'codesign'].includes(String(command))
        )
      ).toBe(false)
      await expect(readFile(manager.getWhisperPath(), 'utf8')).resolves.toBe('bundled-whisper')
      await expect(
        readFile(join(manager.getModelsDir(), 'libwhisper.1.dylib'), 'utf8')
      ).resolves.toBe('bundled-lib')
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('rejects incomplete packaged macOS whisper runtimes before installing them', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-whisper-mac-incomplete-runtime-'))
    const bundledRuntimeDir = join(rootDir, 'resources', 'macos-whisper-runtime', process.arch)

    try {
      vi.spyOn(process, 'cwd').mockReturnValue(rootDir)
      await mkdir(bundledRuntimeDir, { recursive: true })
      await writeFile(join(bundledRuntimeDir, 'whisper-cpp'), 'bundled-whisper')
      await writeFile(join(bundledRuntimeDir, 'libwhisper.1.dylib'), 'bundled-lib')
      await writeFile(join(bundledRuntimeDir, 'libggml-base.0.dylib'), 'bundled-lib')
      await writeFile(join(bundledRuntimeDir, 'libggml.0.dylib'), 'bundled-lib')
      await writeFile(join(bundledRuntimeDir, 'libomp.dylib'), 'bundled-lib')

      const { WhisperManager } = await loadWhisperManager('darwin', rootDir, {
        isPackaged: true,
        macBackend: 'whisper-cpp'
      })

      const manager = new WhisperManager()

      await expect((manager as any).downloadWhisperMac()).rejects.toThrow(
        'Managed macOS whisper runtime assets are not configured'
      )
      await expect(access(manager.getWhisperPath())).rejects.toThrow()
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('installs an extracted macOS whisper runtime without deleting the extraction source first', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-whisper-mac-extracted-runtime-'))

    try {
      const { WhisperManager } = await loadWhisperManager('darwin', rootDir, {
        isPackaged: true,
        macBackend: 'whisper-cpp'
      })

      const manager = new WhisperManager()
      const runtimeDir = join(manager.getModelsDir(), '_whisper_extract', 'runtime')
      await mkdir(runtimeDir, { recursive: true })
      await writeFile(manager.getModelPath(), 'existing-model')
      await writeFile(manager.getWhisperPath(), 'stale-whisper')
      await writeFile(join(runtimeDir, 'whisper-cpp'), 'extracted-whisper')
      await writeFile(join(runtimeDir, 'libwhisper.1.dylib'), 'extracted-lib')
      await writeFile(join(runtimeDir, 'libggml-base.0.dylib'), 'extracted-lib')
      await writeFile(join(runtimeDir, 'libggml.0.dylib'), 'extracted-lib')
      await writeFile(join(runtimeDir, 'libomp.dylib'), 'extracted-lib')
      await writeFile(join(runtimeDir, 'libggml-metal.so'), 'extracted-lib')

      await (manager as any).installMacWhisperRuntimeFromDir(runtimeDir)

      await expect(readFile(manager.getWhisperPath(), 'utf8')).resolves.toBe('extracted-whisper')
      await expect(readFile(manager.getModelPath(), 'utf8')).resolves.toBe('existing-model')
      await expect(
        readFile(join(manager.getModelsDir(), 'libwhisper.1.dylib'), 'utf8')
      ).resolves.toBe('extracted-lib')
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
        windowsBackend: 'whisper-cpp'
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
          const assetRoot = (manager as any).getWindowsTranscriptionAssetRoot(profile, asset.id)
          for (const expectedFile of asset.expectedFiles) {
            const target = join(assetRoot, ...expectedFile.split('/'))
            await mkdir(dirname(target), { recursive: true })
            await writeFile(target, `${asset.id} file`)
          }
          if (profile.id === 'faster-whisper-cuda' && asset.id === 'runtime') {
            await mkdir(join(assetRoot, 'DLLs'), { recursive: true })
            await mkdir(join(assetRoot, 'Lib', 'site-packages', 'nvidia', 'cublas', 'bin'), {
              recursive: true
            })
            await mkdir(join(assetRoot, 'Lib', 'site-packages', 'nvidia', 'cudnn', 'bin'), {
              recursive: true
            })
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
      const fasterWhisperEnvPath = manager.getFasterWhisperProcessEnv().PATH?.split(delimiter)
      expect(fasterWhisperEnvPath).toContain(
        join(
          (manager as any).getFasterWhisperRuntimeDir(),
          'Lib',
          'site-packages',
          'nvidia',
          'cublas',
          'bin'
        )
      )
      expect(fasterWhisperEnvPath).toContain(
        join(
          (manager as any).getFasterWhisperRuntimeDir(),
          'Lib',
          'site-packages',
          'nvidia',
          'cudnn',
          'bin'
        )
      )
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
          const assetRoot = (manager as any).getWindowsTranscriptionAssetRoot(profile, asset.id)
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

  it('installs the parakeet-gpu profile on supported Windows hardware', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-whisper-win-parakeet-gpu-'))
    const bundledFfmpeg = join(rootDir, 'bundled-ffmpeg.exe')
    await writeFile(bundledFfmpeg, 'bundled ffmpeg')

    try {
      const { WhisperManager } = await loadWhisperManager('win32', rootDir, {
        isPackaged: true,
        ffmpegStaticPath: bundledFfmpeg,
        windowsBackend: 'parakeet-gpu'
      })

      const manager = new WhisperManager()
      const assetDownloads: string[] = []
      vi.spyOn(manager as any, 'downloadAndExtractWindowsTranscriptionAsset').mockImplementation(
        async (profile: any, asset: any) => {
          assetDownloads.push(asset.filename)
          const assetRoot = (manager as any).getWindowsTranscriptionAssetRoot(profile, asset.id)
          for (const expectedFile of asset.expectedFiles) {
            const target = join(assetRoot, ...expectedFile.split('/'))
            await mkdir(dirname(target), { recursive: true })
            await writeFile(target, `${asset.id} file`)
          }
        }
      )
      vi.spyOn(manager as any, 'isParakeetUsableWithRetry').mockResolvedValue(true)

      await manager.ensureReady()

      expect(manager.getTranscriptionBackend()).toBe('parakeet-gpu')
      expect(manager.getModelName()).toBe('parakeet-tdt-0.6b-v3')
      expect(assetDownloads).toEqual([
        'parakeet-runtime-win-x64.zip',
        'parakeet-tdt-0.6b-v3-fp32.zip'
      ])
      await expect(access(manager.getParakeetPythonPath())).resolves.toBeUndefined()
      await expect(
        access(join(manager.getParakeetModelPath(), 'encoder-model.onnx'))
      ).resolves.toBeUndefined()
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('installs the parakeet-cpu profile on Windows', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-whisper-win-parakeet-cpu-'))
    const bundledFfmpeg = join(rootDir, 'bundled-ffmpeg.exe')
    await writeFile(bundledFfmpeg, 'bundled ffmpeg')

    try {
      const { WhisperManager } = await loadWhisperManager('win32', rootDir, {
        isPackaged: true,
        ffmpegStaticPath: bundledFfmpeg,
        windowsBackend: 'parakeet-cpu'
      })

      const manager = new WhisperManager()
      const assetDownloads: string[] = []
      vi.spyOn(manager as any, 'downloadAndExtractWindowsTranscriptionAsset').mockImplementation(
        async (profile: any, asset: any) => {
          assetDownloads.push(asset.filename)
          const assetRoot = (manager as any).getWindowsTranscriptionAssetRoot(profile, asset.id)
          for (const expectedFile of asset.expectedFiles) {
            const target = join(assetRoot, ...expectedFile.split('/'))
            await mkdir(dirname(target), { recursive: true })
            await writeFile(target, `${asset.id} file`)
          }
        }
      )
      vi.spyOn(manager as any, 'isParakeetUsableWithRetry').mockResolvedValue(true)

      await manager.ensureReady()

      expect(manager.getTranscriptionBackend()).toBe('parakeet-cpu')
      expect(assetDownloads).toEqual([
        'parakeet-runtime-win-x64.zip',
        'parakeet-tdt-0.6b-v3-int8.zip'
      ])
      await expect(
        access(join(manager.getParakeetModelPath(), 'encoder-model.int8.onnx'))
      ).resolves.toBeUndefined()
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('downgrades parakeet-gpu to parakeet-cpu when GPU validation fails', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-whisper-win-parakeet-gpu-fallback-'))
    const bundledFfmpeg = join(rootDir, 'bundled-ffmpeg.exe')
    await writeFile(bundledFfmpeg, 'bundled ffmpeg')

    try {
      const { WhisperManager } = await loadWhisperManager('win32', rootDir, {
        isPackaged: true,
        ffmpegStaticPath: bundledFfmpeg,
        windowsBackend: 'parakeet-gpu'
      })

      const manager = new WhisperManager()
      vi.spyOn(manager as any, 'downloadAndExtractWindowsTranscriptionAsset').mockImplementation(
        async (profile: any, asset: any) => {
          const assetRoot = (manager as any).getWindowsTranscriptionAssetRoot(profile, asset.id)
          for (const expectedFile of asset.expectedFiles) {
            const target = join(assetRoot, ...expectedFile.split('/'))
            await mkdir(dirname(target), { recursive: true })
            await writeFile(target, `${asset.id} file`)
          }
        }
      )
      const usabilitySpy = vi
        .spyOn(manager as any, 'isParakeetUsableWithRetry')
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true)

      await manager.ensureReady()

      expect(usabilitySpy).toHaveBeenCalledTimes(2)
      expect(manager.getTranscriptionBackend()).toBe('parakeet-cpu')
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
          const assetRoot = (manager as any).getWindowsTranscriptionAssetRoot(profile, asset.id)
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
      ).resolves.toBe(expectedSha256)
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

  it('fails Windows faster-whisper extraction when expected files are missing after archive extraction', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-whisper-win-missing-extract-'))

    try {
      const { WhisperManager, execFileMock } = await loadWhisperManager('win32', rootDir, {
        windowsBackend: 'faster-whisper-cpu'
      })
      const manager = new WhisperManager()
      const payload = 'known payload'
      const expectedSha256 = createHash('sha256').update(payload).digest('hex')
      const existingRuntimeFile = join(
        manager.getModelsDir(),
        'transcription-runtimes',
        'faster-whisper-cpu',
        'existing.txt'
      )
      await mkdir(dirname(existingRuntimeFile), { recursive: true })
      await writeFile(existingRuntimeFile, 'existing runtime')
      vi.spyOn(manager as any, 'downloadFile').mockImplementation(async (...args: unknown[]) => {
        const destPath = String(args[1])
        await mkdir(dirname(destPath), { recursive: true })
        await writeFile(destPath, payload)
      })

      await expect(
        (manager as any).downloadAndExtractWindowsTranscriptionAsset(
          {
            id: 'faster-whisper-cpu',
            label: 'CPU optimized transcription',
            modelName: 'small.en',
            device: 'cpu',
            computeType: 'int8',
            minSystemMemoryGiB: 8,
            assets: []
          },
          {
            id: 'runtime',
            filename: 'faster-whisper-runtime-cpu-win-x64.zip',
            url: 'https://example.invalid/faster-whisper-runtime-cpu-win-x64.zip',
            sha256: expectedSha256,
            expectedFiles: ['python.exe']
          }
        )
      ).rejects.toThrow(/missing expected files/i)
      expect(execFileMock).toHaveBeenCalledWith(
        'tar',
        expect.arrayContaining(['-xf', '-C']),
        expect.any(Function)
      )
      await expect(readFile(existingRuntimeFile, 'utf8')).resolves.toBe('existing runtime')
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
        ffmpegStaticPath: packagedFfmpeg,
        windowsBackend: 'whisper-cpp'
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
          ffmpegStaticPath: bundledFfmpeg,
          macBackend: 'whisper-cpp'
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
          ffmpegStaticPath: bundledFfmpeg,
          windowsBackend: 'whisper-cpp'
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
        ffmpegStaticPath: bundledFfmpeg,
        windowsBackend: 'whisper-cpp'
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
          ffmpegStaticPath: bundledFfmpeg,
          windowsBackend: 'whisper-cpp'
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
        const callback = getExecFileCallback(optionsOrCallback, maybeCallback)
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
          ffmpegStaticPath: bundledFfmpeg,
          windowsBackend: 'whisper-cpp'
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
        const callback = getExecFileCallback(optionsOrCallback, maybeCallback)
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
        ffmpegStaticPath: bundledFfmpeg,
        macBackend: 'whisper-cpp'
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
        ffmpegStaticPath: bundledFfmpeg,
        macBackend: 'whisper-cpp'
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
        ffmpegStaticPath: bundledFfmpeg,
        macBackend: 'whisper-cpp'
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
