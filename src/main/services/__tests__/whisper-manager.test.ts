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

  it('re-signs the rewritten macOS whisper runtime after patching load commands', async () => {
    if (process.platform === 'win32') {
      return
    }

    mockReaddir.mockResolvedValue([
      {
        name: 'libwhisper.1.8.4.dylib',
        isFile: () => true,
        isDirectory: () => false
      },
      {
        name: 'libggml.0.10.0.dylib',
        isFile: () => true,
        isDirectory: () => false
      },
      {
        name: 'libggml-base.0.10.0.dylib',
        isFile: () => true,
        isDirectory: () => false
      },
      {
        name: 'libomp.dylib',
        isFile: () => true,
        isDirectory: () => false
      },
      {
        name: 'libggml-metal.so',
        isFile: () => true,
        isDirectory: () => false
      },
      {
        name: 'libwhisper.1.dylib',
        isFile: () => false,
        isDirectory: () => false
      }
    ] as never)

    await (manager as any).resignMacWhisperRuntime()

    expect(mockExecFile).toHaveBeenCalledWith(
      'codesign',
      ['--sign', '-', '--force', join('/mock/home', 'models', 'libwhisper.1.8.4.dylib')],
      expect.any(Function)
    )
    expect(mockExecFile).toHaveBeenCalledWith(
      'codesign',
      ['--sign', '-', '--force', join('/mock/home', 'models', 'libggml.0.10.0.dylib')],
      expect.any(Function)
    )
    expect(mockExecFile).toHaveBeenCalledWith(
      'codesign',
      ['--sign', '-', '--force', join('/mock/home', 'models', 'libggml-base.0.10.0.dylib')],
      expect.any(Function)
    )
    expect(mockExecFile).toHaveBeenCalledWith(
      'codesign',
      ['--sign', '-', '--force', join('/mock/home', 'models', 'libomp.dylib')],
      expect.any(Function)
    )
    expect(mockExecFile).toHaveBeenCalledWith(
      'codesign',
      ['--sign', '-', '--force', join('/mock/home', 'models', 'libggml-metal.so')],
      expect.any(Function)
    )
    expect(mockExecFile).toHaveBeenCalledWith(
      'codesign',
      ['--sign', '-', '--force', manager.getWhisperPath()],
      expect.any(Function)
    )
  })

  it('rewrites copied ggml backend bundles to load local runtime dependencies', async () => {
    if (process.platform === 'win32') {
      return
    }

    mockReaddir.mockResolvedValue([
      {
        name: 'libwhisper.1.8.4.dylib',
        isFile: () => true,
        isDirectory: () => false
      },
      {
        name: 'libggml.0.10.0.dylib',
        isFile: () => true,
        isDirectory: () => false
      },
      {
        name: 'libggml-base.0.10.0.dylib',
        isFile: () => true,
        isDirectory: () => false
      },
      {
        name: 'libomp.dylib',
        isFile: () => true,
        isDirectory: () => false
      },
      {
        name: 'libggml-metal.so',
        isFile: () => true,
        isDirectory: () => false
      }
    ] as never)

    const listDepsSpy = vi
      .spyOn(manager as never, 'listMacDependencies')
      .mockResolvedValue(['@rpath/libggml-base.0.dylib', '/usr/lib/libSystem.B.dylib'])
    const setInstallNameSpy = vi
      .spyOn(manager as never, 'setMacInstallName')
      .mockResolvedValue(undefined)
    const rewriteSpy = vi
      .spyOn(manager as never, 'rewriteMacLoadCommands')
      .mockResolvedValue(undefined)

    await (manager as any).rewriteMacWhisperDependencies()

    expect(setInstallNameSpy).toHaveBeenCalledTimes(4)
    expect(rewriteSpy).toHaveBeenCalledWith(
      join('/mock/home', 'models', 'libggml-metal.so'),
      '@loader_path'
    )
    expect(rewriteSpy).toHaveBeenCalledWith(manager.getWhisperPath(), '@executable_path')
    expect(listDepsSpy).not.toHaveBeenCalled()
  })

  it('rewrites local libomp references inside copied ggml backend bundles', async () => {
    if (process.platform === 'win32') {
      return
    }

    const changeDependencySpy = vi
      .spyOn(manager as never, 'changeMacDependency')
      .mockResolvedValue(undefined)
    vi.spyOn(manager as never, 'listMacDependencies').mockResolvedValue([
      '@@HOMEBREW_PREFIX@@/opt/libomp/lib/libomp.dylib',
      '@rpath/libggml-base.0.dylib',
      '/usr/lib/libSystem.B.dylib'
    ])

    await (manager as any).rewriteMacLoadCommands(
      '/mock/home/models/libggml-cpu-apple_m4.so',
      '@loader_path'
    )

    expect(changeDependencySpy).toHaveBeenCalledWith(
      '/mock/home/models/libggml-cpu-apple_m4.so',
      '@@HOMEBREW_PREFIX@@/opt/libomp/lib/libomp.dylib',
      '@loader_path/libomp.dylib'
    )
  })
})
