import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as childProcess from 'child_process'
import * as fsPromises from 'fs/promises'
import { join } from 'path'
import { WhisperManager } from '../whisper-manager'

let isPackaged = false

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/home'),
    get isPackaged() {
      return isPackaged
    }
  }
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
        ? join('/mock/home', 'models', 'ggml-distil-large-v3.bin')
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
})
