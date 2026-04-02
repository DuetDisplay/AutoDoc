import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as childProcess from 'child_process'
import * as fsPromises from 'fs/promises'
import { join } from 'path'
import { WhisperManager } from '../whisper-manager'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/home'),
  },
}))

vi.mock('fs/promises', () => ({
  access: vi.fn(),
  mkdir: vi.fn(),
  copyFile: vi.fn(),
  readdir: vi.fn(),
  rm: vi.fn(),
  symlink: vi.fn(),
}))

vi.mock('child_process', () => ({
  execFile: vi.fn(),
  execSync: vi.fn(() => ''),
}))

const mockAccess = vi.mocked(fsPromises.access)
const mockCopyFile = vi.mocked(fsPromises.copyFile)
const mockReaddir = vi.mocked(fsPromises.readdir)
const mockExecFile = vi.mocked(childProcess.execFile)

describe('WhisperManager', () => {
  let manager: WhisperManager

  beforeEach(() => {
    vi.clearAllMocks()
    manager = new WhisperManager()
    mockAccess.mockResolvedValue(undefined)
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
        : join('/mock/home', 'models', 'whisper-cpp'),
    )
  })

  it('returns correct ffmpeg binary path', () => {
    expect(manager.getFfmpegPath()).toBe(
      process.platform === 'win32'
        ? join('/mock/home', 'models', 'ffmpeg.exe')
        : join('/mock/home', 'models', 'ffmpeg'),
    )
  })

  it('returns correct model path', () => {
    expect(manager.getModelPath()).toBe(
      process.platform === 'win32'
        ? join('/mock/home', 'models', 'ggml-distil-large-v3.bin')
        : join('/mock/home', 'models', 'ggml-large-v3.bin'),
    )
  })

  it('reports ready when all files exist', async () => {
    const ready = await manager.isReady()
    expect(ready).toBe(true)
    expect(mockExecFile).toHaveBeenCalled()
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

  it('reports not ready when whisper exists but fails to launch', async () => {
    mockExecFile.mockImplementation((...args: any[]) => {
      const callback = args[args.length - 1]
      callback(new Error('loader failure'))
      return {} as never
    })

    const ready = await manager.isReady()
    expect(ready).toBe(false)
  })

  it('reinstalls whisper when the existing binary fails validation', async () => {
    mockExecFile
      .mockImplementationOnce((...args: any[]) => {
        const callback = args[args.length - 1]
        callback(new Error('loader failure'))
        return {} as never
      })
      .mockImplementation((...args: any[]) => {
        const callback = args[args.length - 1]
        callback(null)
        return {} as never
      })

    const resolveWhisperSpy = vi
      .spyOn(manager as never, 'resolveWhisper')
      .mockResolvedValue(undefined)

    await manager.ensureReady()

    expect(resolveWhisperSpy).toHaveBeenCalledTimes(1)
  })

  it('allows setup to run again after a successful startSetup call', async () => {
    const ensureReadySpy = vi
      .spyOn(manager, 'ensureReady')
      .mockResolvedValue(undefined)

    await manager.startSetup()
    await manager.startSetup()

    expect(ensureReadySpy).toHaveBeenCalledTimes(2)
  })

  it('copies whisper companion DLLs on Windows', async () => {
    mockReaddir.mockResolvedValue([
      {
        name: 'whisper.dll',
        isFile: () => true,
        isDirectory: () => false,
      },
      {
        name: 'ggml.dll',
        isFile: () => true,
        isDirectory: () => false,
      },
      {
        name: 'README.md',
        isFile: () => true,
        isDirectory: () => false,
      },
    ] as never)

    await (manager as any).copyWhisperBundle('C:\\tmp\\whisper-cli.exe', 'C:\\dest\\whisper-cli.exe')

    if (process.platform === 'win32') {
      expect(mockCopyFile).toHaveBeenCalledWith('C:\\tmp\\whisper-cli.exe', 'C:\\dest\\whisper-cli.exe')
      expect(mockCopyFile).toHaveBeenCalledWith('C:\\tmp\\whisper.dll', join('/mock/home', 'models', 'whisper.dll'))
      expect(mockCopyFile).toHaveBeenCalledWith('C:\\tmp\\ggml.dll', join('/mock/home', 'models', 'ggml.dll'))
    } else {
      expect(mockCopyFile).toHaveBeenCalledTimes(1)
    }
  })
})
