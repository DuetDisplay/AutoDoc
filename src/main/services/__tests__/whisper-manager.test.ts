import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as childProcess from 'child_process'
import * as fsPromises from 'fs/promises'
import { join } from 'path'
import { downloadMacSpeechModels } from '../mac-speech-models'
import { WhisperManager } from '../whisper-manager'
import {
  PARAKEET_RUNTIME_FILENAME,
  WINDOWS_TRANSCRIPTION_PROFILES
} from '../windows-transcription-runtime'
vi.mock('../windows-dml-restriction', () => ({
  readDmlRestriction: vi.fn().mockResolvedValue(null),
  writeDmlRestriction: vi.fn().mockResolvedValue(undefined),
  clearDmlRestriction: vi.fn().mockResolvedValue(undefined)
}))

let isPackaged = false

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/home'),
    get isPackaged() {
      return isPackaged
    }
  }
}))

vi.mock('../mac-speech-models', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../mac-speech-models')>()),
  downloadMacSpeechModels: vi.fn().mockResolvedValue(undefined),
  getMacRouteFirstUseDownloadBytes: vi.fn().mockResolvedValue(100)
}))
vi.mock('../mac-canary-transcription', () => ({
  resolveMacCanaryTranscriber: vi.fn(() => ({ pythonPath: '/canary/python3' }))
}))

const ensureWindowsMultilingualEngineReady = vi.fn().mockResolvedValue({
  engineId: 'whisper-turbo-cuda',
  availability: 'available',
  reason: null
})
const getWindowsMeetingLanguageAvailability = vi.fn().mockResolvedValue({
  availability: 'available',
  reason: null,
  engineId: 'whisper-turbo-cuda',
  firstUseDownloadBytes: 0,
  needsSelfTest: false
})

vi.mock('../windows-multilingual-readiness', () => ({
  ensureWindowsMultilingualEngineReady: (...args: unknown[]) =>
    ensureWindowsMultilingualEngineReady(...args),
  getWindowsMeetingLanguageAvailability: (...args: unknown[]) =>
    getWindowsMeetingLanguageAvailability(...args)
}))

vi.mock('ffmpeg-static', () => ({
  default: '/mock/ffmpeg-static'
}))

vi.mock('fs/promises', () => ({
  access: vi.fn(),
  mkdir: vi.fn(),
  mkdtemp: vi.fn(),
  copyFile: vi.fn(),
  readdir: vi.fn(),
  rm: vi.fn(),
  symlink: vi.fn(),
  chmod: vi.fn(),
  writeFile: vi.fn()
}))

vi.mock('child_process', () => ({
  execFile: vi.fn(),
  execSync: vi.fn(() => '')
}))

const mockAccess = vi.mocked(fsPromises.access)
const mockCopyFile = vi.mocked(fsPromises.copyFile)
const mockMkdtemp = vi.mocked(fsPromises.mkdtemp)
const mockReaddir = vi.mocked(fsPromises.readdir)
const mockWriteFile = vi.mocked(fsPromises.writeFile)
const mockExecFile = vi.mocked(childProcess.execFile)
const mockExecSync = vi.mocked(childProcess.execSync)

describe('WhisperManager', () => {
  let manager: WhisperManager

  beforeEach(() => {
    vi.clearAllMocks()
    isPackaged = false
    delete process.env.AUTODOC_ALLOW_SYSTEM_RUNTIME_FALLBACK
    process.env.AUTODOC_MAC_TRANSCRIPTION_BACKEND = 'whisper-cpp'
    process.env.AUTODOC_WINDOWS_TRANSCRIPTION_BACKEND = 'whisper-cpp'
    manager = new WhisperManager()
    mockAccess.mockResolvedValue(undefined)
    mockMkdtemp.mockResolvedValue('/mock/probe-dir')
    mockReaddir.mockResolvedValue([] as never)
    mockWriteFile.mockResolvedValue(undefined)
    mockExecFile.mockImplementation((...args: any[]) => {
      const callback = args[args.length - 1]
      callback(null)
      return {} as never
    })
  })

  describe('meeting language setup on Apple Silicon', () => {
    beforeEach(async () => {
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
      const arch = Object.getOwnPropertyDescriptor(process, 'arch')!
      try {
        Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
        Object.defineProperty(process, 'arch', { configurable: true, value: 'arm64' })
        vi.resetModules()
        const { WhisperManager: MacManager } = await import('../whisper-manager')
        manager = new MacManager()
        vi.spyOn(manager as never, 'selectMacProfile').mockResolvedValue(undefined)
      } finally {
        Object.defineProperty(process, 'platform', platform)
        Object.defineProperty(process, 'arch', arch)
      }
    })

    it('keeps English on the existing setup path', async () => {
      const english = vi.spyOn(manager, 'startSetup').mockResolvedValue()
      await manager.prepareMeetingLanguage('en')
      expect(english).toHaveBeenCalledOnce()
      expect(downloadMacSpeechModels).not.toHaveBeenCalled()
    })

    it.each(['fr', 'es'] as const)(
      'prepares %s without the Distil setup or model',
      async (language) => {
        vi.spyOn(manager as never, 'ensureFfmpegForSelectedRuntime').mockResolvedValue(undefined)
        const english = vi.spyOn(manager, 'startSetup').mockResolvedValue()
        await manager.prepareMeetingLanguage(language)
        expect(downloadMacSpeechModels).toHaveBeenCalledWith(
          language,
          expect.any(Function),
          expect.any(Function)
        )
        expect(english).not.toHaveBeenCalled()
        expect(manager.getSetupStatus().phase).toBe('ready')
      }
    )

    it('deduplicates setup and queues language changes until the current download finishes', async () => {
      vi.spyOn(manager as never, 'ensureFfmpegForSelectedRuntime').mockResolvedValue(undefined)
      let finishDownload!: () => void
      vi.mocked(downloadMacSpeechModels).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishDownload = resolve
          })
      )
      const french = manager.prepareMeetingLanguage('fr')
      expect(manager.prepareMeetingLanguage('fr')).toBe(french)
      await vi.waitFor(() => expect(downloadMacSpeechModels).toHaveBeenCalledTimes(1))
      const spanish = manager.prepareMeetingLanguage('es')
      expect(manager.getSetupStatus().meetingLanguage).toBe('fr')
      finishDownload()
      await Promise.all([french, spanish])
      expect(downloadMacSpeechModels).toHaveBeenCalledTimes(2)
      expect(manager.getSetupStatus()).toMatchObject({ phase: 'ready', meetingLanguage: 'es' })
    })

    it('skips a queued language that a newer choice replaced before it started', async () => {
      vi.spyOn(manager as never, 'ensureFfmpegForSelectedRuntime').mockResolvedValue(undefined)
      let finishDownload!: () => void
      vi.mocked(downloadMacSpeechModels).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishDownload = resolve
          })
      )
      const french = manager.prepareMeetingLanguage('fr')
      await vi.waitFor(() => expect(downloadMacSpeechModels).toHaveBeenCalledTimes(1))
      const spanish = manager.prepareMeetingLanguage('es')
      const german = manager.prepareMeetingLanguage('de')
      finishDownload()
      await french
      await expect(spanish).rejects.toThrow('Meeting language changed during setup')
      await german
      expect(vi.mocked(downloadMacSpeechModels).mock.calls.map(([language]) => language)).toEqual([
        'fr',
        'de'
      ])
    })

    it('aborts a stalled setup download as soon as the language changes', async () => {
      // Like fetch: an aborted signal rejects, and aborting errors a body that
      // is waiting for data that never arrives.
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, init?: RequestInit) => {
          if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError')
          return new Response(
            new ReadableStream({
              start(controller) {
                init?.signal?.addEventListener('abort', () =>
                  controller.error(new DOMException('aborted', 'AbortError'))
                )
              }
            }),
            { status: 200, headers: { 'content-length': '1000' } }
          )
        })
      )
      const internals = manager as unknown as {
        activeSetupLanguage: string
        activeSetupAbort: AbortController
        downloadResumableFile: (url: string, dest: string, label: string) => Promise<void>
      }
      internals.activeSetupLanguage = 'fr'
      internals.activeSetupAbort = new AbortController()
      const dest = join(
        (await import('os')).tmpdir(),
        `autodoc-abort-test-${process.pid}-${Date.now()}.bin`
      )
      const download = internals.downloadResumableFile('https://example.test/model', dest, 'model')
      const rejected = expect(download).rejects.toThrow('Meeting language changed during setup')
      await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
      internals.activeSetupAbort.abort()
      await rejected
      vi.unstubAllGlobals()
      ;(await import('node:fs')).rmSync(`${dest}.tmp`, { force: true })
    })

    it('downloads English on demand after non-English setup', async () => {
      vi.spyOn(manager as never, 'ensureFfmpegForSelectedRuntime').mockResolvedValue(undefined)
      const english = vi.spyOn(manager, 'startSetup').mockResolvedValue()
      await manager.prepareMeetingLanguage('fr')
      expect(english).not.toHaveBeenCalled()
      await manager.prepareMeetingLanguage('en')
      expect(english).toHaveBeenCalledOnce()
    })

    it('retains a Mac download failure in picker state and clears it after retry', async () => {
      vi.spyOn(manager as never, 'ensureFfmpegForSelectedRuntime').mockResolvedValue(undefined)
      vi.mocked(downloadMacSpeechModels).mockRejectedValueOnce(new Error('offline'))
      await expect(manager.prepareMeetingLanguage('fr')).rejects.toThrow('offline')
      expect(await manager.getMacMeetingLanguageState('fr')).toMatchObject({
        availability: 'available',
        reason: 'offline',
        firstUseDownloadBytes: 100
      })
      await manager.prepareMeetingLanguage('fr')
      expect(await manager.getMacMeetingLanguageState('fr')).toMatchObject({ reason: null })
    })
  })

  it('locks a missing Mac turbo runtime with a reason', async () => {
    expect(await manager.getMacMeetingLanguageState('es')).toMatchObject({
      availability: 'locked',
      reason: expect.stringContaining('runtime')
    })
  })

  describe('meeting language setup on Windows', () => {
    beforeEach(async () => {
      ensureWindowsMultilingualEngineReady.mockReset()
      getWindowsMeetingLanguageAvailability.mockReset()
      ensureWindowsMultilingualEngineReady.mockResolvedValue({
        engineId: 'whisper-turbo-cuda',
        availability: 'available',
        reason: null
      })
      getWindowsMeetingLanguageAvailability.mockResolvedValue({
        availability: 'available',
        reason: null,
        engineId: 'whisper-turbo-cuda',
        firstUseDownloadBytes: 0,
        needsSelfTest: false
      })
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
      try {
        Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
        vi.resetModules()
        const { WhisperManager: WindowsManager } = await import('../whisper-manager')
        manager = new WindowsManager()
      } finally {
        Object.defineProperty(process, 'platform', platform)
      }
    })

    it('names the language engine, not the English one, during non-English setup', () => {
      const internals = manager as unknown as {
        activeSetupLanguage: string | undefined
        withBackendStatus: (status: { phase: string; percent: number }) => {
          backendLabel?: string
        }
      }
      const status = { phase: 'downloading-ffmpeg', percent: 0 }
      internals.activeSetupLanguage = 'de'
      expect(internals.withBackendStatus(status).backendLabel).toBe('Canary')
      internals.activeSetupLanguage = 'ja'
      expect(internals.withBackendStatus(status).backendLabel).toBe('Whisper turbo')
      internals.activeSetupLanguage = undefined
      expect(internals.withBackendStatus(status).backendLabel).not.toMatch(/Canary|turbo/)
    })

    it('keeps English on the existing setup path', async () => {
      const english = vi.spyOn(manager, 'startSetup').mockResolvedValue()
      await manager.prepareMeetingLanguage('en')
      expect(english).toHaveBeenCalledOnce()
      expect(ensureWindowsMultilingualEngineReady).not.toHaveBeenCalled()
    })

    it('installs only the Windows multilingual route and skips English Distil setup', async () => {
      const english = vi.spyOn(manager, 'startSetup').mockResolvedValue()
      await manager.prepareMeetingLanguage('es')
      expect(ensureWindowsMultilingualEngineReady).toHaveBeenCalledWith('es')
      expect(english).not.toHaveBeenCalled()
      expect(downloadMacSpeechModels).not.toHaveBeenCalled()
      expect(manager.getSetupStatus()).toMatchObject({ phase: 'ready', meetingLanguage: 'es' })
    })

    it('locks the language when Windows ensure reports a failed self-test with no fallback', async () => {
      ensureWindowsMultilingualEngineReady.mockResolvedValue({
        engineId: null,
        availability: 'locked',
        reason: 'Spanish needs a supported graphics card on this PC.'
      })
      await expect(manager.prepareMeetingLanguage('es')).rejects.toThrow(
        'Spanish needs a supported graphics card on this PC.'
      )
      expect(manager.getSetupStatus()).toMatchObject({
        phase: 'error',
        error: 'Spanish needs a supported graphics card on this PC.',
        meetingLanguage: 'es'
      })
    })

    it('restores the previous saved language when Windows ensure reports a lock', async () => {
      ensureWindowsMultilingualEngineReady.mockResolvedValue({
        engineId: null,
        availability: 'locked',
        reason: 'Spanish needs a supported graphics card on this PC.'
      })
      const { bindMeetingLanguagePreferenceStore } = await import('../meeting-language-availability')
      let current: 'en' | 'es' = 'es'
      bindMeetingLanguagePreferenceStore({
        getMeetingLanguage: () => current,
        restorePreviousMeetingLanguageIfCurrent(locked) {
          if (current !== locked) return current
          current = 'en'
          return current
        }
      })
      await expect(manager.prepareMeetingLanguage('es')).rejects.toThrow(
        'Spanish needs a supported graphics card on this PC.'
      )
      expect(current).toBe('en')
      bindMeetingLanguagePreferenceStore(null)
    })

    it('does not restore when Windows ensure throws a download error', async () => {
      ensureWindowsMultilingualEngineReady.mockRejectedValue(
        new Error('Failed to download the speech model.')
      )
      getWindowsMeetingLanguageAvailability.mockResolvedValue({
        availability: 'available',
        reason: null,
        engineId: 'whisper-turbo-cuda',
        firstUseDownloadBytes: 100,
        needsSelfTest: true
      })
      const { bindMeetingLanguagePreferenceStore } = await import('../meeting-language-availability')
      let current: 'en' | 'es' = 'es'
      bindMeetingLanguagePreferenceStore({
        getMeetingLanguage: () => current,
        restorePreviousMeetingLanguageIfCurrent(locked) {
          if (current !== locked) return current
          current = 'en'
          return current
        }
      })
      await expect(manager.prepareMeetingLanguage('es')).rejects.toThrow(
        'Failed to download the speech model.'
      )
      expect(current).toBe('es')
      bindMeetingLanguagePreferenceStore(null)
    })
  })

  it('returns correct models directory path', () => {
    expect(manager.getModelsDir()).toBe(join('/mock/home', 'models'))
  })

  it('returns correct whisper binary path', () => {
    expect(manager.getWhisperPath()).toBe(
      process.platform === 'win32'
        ? join('/mock/home', 'models', 'whisper-cli.exe')
        : join('/mock/home', 'models', 'whisper-cpp')
    )
  })

  it('returns correct ffmpeg binary path', () => {
    expect(manager.getFfmpegPath()).toBe(
      process.platform === 'win32'
        ? join('/mock/home', 'models', 'ffmpeg.exe')
        : join('/mock/home', 'models', 'ffmpeg')
    )
  })

  it('returns correct model path', () => {
    expect(manager.getModelPath()).toBe(
      process.platform === 'win32'
        ? join('/mock/home', 'models', 'ggml-base.en.bin')
        : join('/mock/home', 'models', 'ggml-large-v3.bin')
    )
  })

  it('reports ready when all files exist', async () => {
    ;(manager as any).runtimeValidated = true
    const ready = await manager.isReady()
    expect(ready).toBe(true)
  })

  it('reports not ready when whisper binary is missing', async () => {
    mockAccess.mockRejectedValueOnce(new Error('ENOENT'))
    const ready = await manager.isReady()
    expect(ready).toBe(false)
  })

  it('reports not ready when model is missing', async () => {
    mockAccess
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('ENOENT'))
      .mockResolvedValue(undefined)
    const ready = await manager.isReady()
    expect(ready).toBe(false)
  })

  it('reports not ready when runtime has not been validated yet', async () => {
    const ready = await manager.isReady()
    expect(ready).toBe(false)
  })

  it('reinstalls whisper when the existing binary fails validation', async () => {
    const resolveWhisperSpy = vi
      .spyOn(manager as never, 'resolveWhisper')
      .mockResolvedValue(undefined)
    vi.spyOn(manager as never, 'downloadModel').mockResolvedValue(undefined)
    vi.spyOn(manager as never, 'isWhisperUsableWithRetry')
      .mockResolvedValueOnce('failed')
      .mockResolvedValueOnce('failed')
      .mockResolvedValueOnce('ready')

    await manager.ensureReady()

    expect(resolveWhisperSpy).toHaveBeenCalledTimes(1)
  })

  it('classifies macOS dyld library load failures as runtime link failures', () => {
    const rpathResult = (manager as any).classifyWhisperProbeFailure(
      new Error('Command failed: whisper-cpp probe'),
      '',
      [
        'dyld[5371]: Library not loaded: @rpath/libwhisper.1.dylib',
        'Referenced from: /Users/test/Library/Application Support/autodoc/models/whisper-cpp',
        "Reason: tried: '/Users/test/Library/Application Support/autodoc/models/../lib/libwhisper.1.dylib' (no such file)"
      ].join('\n')
    )
    const executablePathResult = (manager as any).classifyWhisperProbeFailure(
      new Error('Command failed: whisper-cpp probe'),
      '',
      'Library not loaded: @executable_path/libggml-metal.so'
    )
    const loaderPathResult = (manager as any).classifyWhisperProbeFailure(
      new Error('Command failed: whisper-cpp probe'),
      '',
      'Library not loaded: @loader_path/libomp.dylib'
    )

    if (process.platform === 'darwin') {
      expect(rpathResult).toBe('runtime-link-failure')
      expect(executablePathResult).toBe('runtime-link-failure')
      expect(loaderPathResult).toBe('runtime-link-failure')
    } else {
      expect(rpathResult).toBe('failed')
      expect(executablePathResult).toBe('failed')
      expect(loaderPathResult).toBe('failed')
    }
  })

  it('allows setup to run again after a successful startSetup call', async () => {
    const ensureReadySpy = vi.spyOn(manager, 'ensureReady').mockResolvedValue(undefined)

    await manager.startSetup()
    await manager.startSetup()

    expect(ensureReadySpy).toHaveBeenCalledTimes(2)
  })

  it('copies whisper companion DLLs on Windows', async () => {
    mockReaddir.mockResolvedValue([
      {
        name: 'whisper.dll',
        isFile: () => true,
        isDirectory: () => false
      },
      {
        name: 'ggml.dll',
        isFile: () => true,
        isDirectory: () => false
      },
      {
        name: 'README.md',
        isFile: () => true,
        isDirectory: () => false
      }
    ] as never)

    await (manager as any).copyWhisperBundle(
      'C:\\tmp\\whisper-cli.exe',
      'C:\\dest\\whisper-cli.exe'
    )

    if (process.platform === 'win32') {
      expect(mockCopyFile).toHaveBeenCalledWith(
        'C:\\tmp\\whisper-cli.exe',
        'C:\\dest\\whisper-cli.exe'
      )
      expect(mockCopyFile).toHaveBeenCalledWith(
        'C:\\tmp\\whisper.dll',
        join('/mock/home', 'models', 'whisper.dll')
      )
      expect(mockCopyFile).toHaveBeenCalledWith(
        'C:\\tmp\\ggml.dll',
        join('/mock/home', 'models', 'ggml.dll')
      )
    } else {
      expect(mockCopyFile).toHaveBeenCalledTimes(1)
    }
  })

  it('uses system runtime fallback in dev mode when explicitly enabled', async () => {
    process.env.AUTODOC_ALLOW_SYSTEM_RUNTIME_FALLBACK = '1'
    mockExecSync.mockReturnValue('/usr/local/bin/whisper-cli')
    const linkOrCopySpy = vi.spyOn(manager as never, 'linkOrCopy').mockResolvedValue(undefined)
    vi.spyOn(manager as never, 'downloadModel').mockResolvedValue(undefined)
    vi.spyOn(manager as never, 'isWhisperUsableWithRetry')
      .mockResolvedValueOnce('failed')
      .mockResolvedValueOnce('failed')
      .mockResolvedValueOnce('ready')

    await manager.ensureReady()

    expect(mockExecSync).toHaveBeenCalled()
    if (process.platform !== 'win32') {
      expect(linkOrCopySpy).toHaveBeenCalled()
    }
  })

  it('prefers the managed runtime in dev mode by default', async () => {
    mockExecSync.mockReturnValue('/usr/local/bin/whisper-cli')
    const resolveWhisperSpy = vi
      .spyOn(manager as never, 'resolveWhisper')
      .mockResolvedValue(undefined)
    vi.spyOn(manager as never, 'downloadModel').mockResolvedValue(undefined)
    vi.spyOn(manager as never, 'isWhisperUsableWithRetry')
      .mockResolvedValueOnce('failed')
      .mockResolvedValueOnce('failed')
      .mockResolvedValueOnce('ready')

    await manager.ensureReady()

    expect(resolveWhisperSpy).toHaveBeenCalled()
    expect(mockExecSync).not.toHaveBeenCalled()
  })

  it('uses the bundled ffmpeg binary in packaged builds', async () => {
    isPackaged = true
    manager = new WhisperManager()
    const installBundledBinarySpy = vi
      .spyOn(manager as never, 'installBundledBinary')
      .mockResolvedValue(undefined)

    await (manager as any).resolveFfmpeg()

    expect(installBundledBinarySpy).toHaveBeenCalledWith(
      '/mock/ffmpeg-static',
      manager.getFfmpegPath()
    )
    expect(mockExecSync).not.toHaveBeenCalled()
  })

  it('ignores system runtime fallback in packaged builds', async () => {
    isPackaged = true
    manager = new WhisperManager()
    mockExecSync.mockReturnValue('/usr/local/bin/whisper-cli')
    const resolveWhisperSpy = vi
      .spyOn(manager as never, 'resolveWhisper')
      .mockResolvedValue(undefined)
    vi.spyOn(manager as never, 'downloadModel').mockResolvedValue(undefined)
    vi.spyOn(manager as never, 'isWhisperUsableWithRetry')
      .mockResolvedValueOnce('failed')
      .mockResolvedValueOnce('failed')
      .mockResolvedValueOnce('ready')

    await manager.ensureReady()

    expect(resolveWhisperSpy).toHaveBeenCalled()
    expect(mockExecSync).not.toHaveBeenCalled()
  })

  it('uses fp32 and DirectML for the selected GPU profile', () => {
    ;(manager as any).selectedWindowsProfile = WINDOWS_TRANSCRIPTION_PROFILES['parakeet-gpu']

    expect(manager.getWorkerComputeType()).toBe('fp32')
    expect(manager.getTranscriptionBackend()).toBe('parakeet-gpu')
    expect(manager.getWorkerDevice()).toBe('dml')
  })

  it('reports estimated memory for the selected hardware profile', () => {
    if (process.platform !== 'win32') {
      return
    }

    ;(manager as any).selectedWindowsProfile = WINDOWS_TRANSCRIPTION_PROFILES['parakeet-gpu']
    ;(manager as any).windowsTranscriptionProfiles = WINDOWS_TRANSCRIPTION_PROFILES

    expect(manager.getSelectedWindowsProfileEstimatedMemoryGiB()).toBe(4)
    ;(manager as any).selectedWindowsProfile = WINDOWS_TRANSCRIPTION_PROFILES['parakeet-cpu']
    expect(manager.getWorkerComputeType()).toBe('int8')
    expect(manager.getWorkerDevice()).toBe('cpu')
    expect(manager.getSelectedWindowsProfileEstimatedMemoryGiB()).toBe(
      WINDOWS_TRANSCRIPTION_PROFILES['parakeet-cpu'].estimatedMemoryGiB
    )
  })

  it('records downgrade chain entries', () => {
    ;(manager as any).recordDowngrade('parakeet-gpu', 'parakeet-cpu')
    ;(manager as any).recordDowngrade('parakeet-cpu', 'whisper-cpp')

    expect(manager.getDowngradesTaken()).toEqual([
      'parakeet-gpu→parakeet-cpu',
      'parakeet-cpu→whisper-cpp'
    ])
  })

  it('resolves and broadcasts Windows transcription backend without asset setup', async () => {
    if (process.platform !== 'win32') {
      return
    }

    process.env.AUTODOC_WINDOWS_TRANSCRIPTION_BACKEND = 'parakeet-gpu'
    const ensureReadySpy = vi.spyOn(manager, 'ensureReady')
    const setupStatuses: Array<{ backend?: string }> = []
    manager.on('setup-status', (status) => setupStatuses.push(status))

    await manager.resolveWindowsTranscriptionBackend()

    expect(manager.getTranscriptionBackend()).toBe('parakeet-gpu')
    expect(setupStatuses.some((status) => status.backend === 'parakeet-gpu')).toBe(true)
    expect(ensureReadySpy).not.toHaveBeenCalled()
  })

  it('keeps English Windows backend assets identical after multilingual profiles were added', () => {
    expect(
      WINDOWS_TRANSCRIPTION_PROFILES['parakeet-gpu'].assets.map((asset) => asset.filename)
    ).toEqual([PARAKEET_RUNTIME_FILENAME, 'parakeet-tdt-0.6b-v3-fp32.zip'])
    expect(
      WINDOWS_TRANSCRIPTION_PROFILES['parakeet-cpu'].assets.map((asset) => asset.filename)
    ).toEqual([PARAKEET_RUNTIME_FILENAME, 'parakeet-tdt-0.6b-v3-int8.zip'])
    expect(WINDOWS_TRANSCRIPTION_PROFILES['faster-whisper-cuda'].modelName).toBe('distil-large-v3')
    expect(WINDOWS_TRANSCRIPTION_PROFILES['faster-whisper-cuda'].computeType).toBe('int8_float32')
    expect(WINDOWS_TRANSCRIPTION_PROFILES['faster-whisper-cpu'].modelName).toBe('small.en')
    expect(WINDOWS_TRANSCRIPTION_PROFILES['whisper-cpp'].assets).toEqual([])
  })

  it('keeps English Windows asset install directories unchanged', () => {
    const modelsDir = manager.getModelsDir()
    const expectedRoot = (
      profile: (typeof WINDOWS_TRANSCRIPTION_PROFILES)[keyof typeof WINDOWS_TRANSCRIPTION_PROFILES],
      assetId: 'runtime' | 'model'
    ): string => {
      if (profile.engine === 'parakeet') {
        return assetId === 'runtime'
          ? join(modelsDir, 'transcription-runtimes', 'parakeet')
          : join(modelsDir, 'parakeet-models', `${profile.modelName}-${profile.computeType}`)
      }
      return assetId === 'runtime'
        ? join(modelsDir, 'transcription-runtimes', profile.id)
        : join(modelsDir, 'faster-whisper-models', profile.modelName)
    }

    for (const id of [
      'faster-whisper-cuda',
      'faster-whisper-cpu',
      'parakeet-gpu',
      'parakeet-cpu'
    ] as const) {
      const profile = WINDOWS_TRANSCRIPTION_PROFILES[id]
      expect(profile.assets.length).toBeGreaterThan(0)
      for (const asset of profile.assets) {
        const actual = (manager as any).getWindowsTranscriptionAssetRoot(
          profile,
          asset.id,
          asset.filename
        )
        expect({ id, asset: asset.filename, dir: actual }).toEqual({
          id,
          asset: asset.filename,
          dir: expectedRoot(profile, asset.id)
        })
      }
    }
  })
})
