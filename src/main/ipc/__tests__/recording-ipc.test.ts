import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as fsp from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { registerRecordingIpc } from '../recording-ipc'

const { handle, getSources, appGetPath, logAutodocEvent, logAutodocFailure } = vi.hoisted(() => ({
  handle: vi.fn(),
  getSources: vi.fn(),
  appGetPath: vi.fn(),
  logAutodocEvent: vi.fn(),
  logAutodocFailure: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getPath: appGetPath },
  ipcMain: { handle },
  desktopCapturer: { getSources },
  BrowserWindow: { getAllWindows: vi.fn(() => []) }
}))

vi.mock('../../services/crypto', () => ({
  encryptJSON: vi.fn()
}))

vi.mock('../../services/calendar-matcher', () => ({
  matchCalendarEvent: vi.fn(() => null),
  readMetadata: vi.fn().mockResolvedValue(null)
}))

vi.mock('../../services/autodoc-log', () => ({
  logAutodocEvent,
  logAutodocFailure
}))

vi.mock('../../services/tray', () => ({
  refreshTray: vi.fn()
}))

vi.mock('../../services/e2e-fixtures', () => ({
  getE2ERecordingSources: vi.fn(() => [])
}))

describe('recording IPC source handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.AUTODOC_E2E
    appGetPath.mockImplementation((name: string) => {
      if (name === 'userData') return '/mock/user-data'
      throw new Error(`unexpected app.getPath(${name})`)
    })
  })

  it('maps capture-source permission failures to a user-facing permission message', async () => {
    getSources.mockRejectedValue(new Error('Screen capture permission denied'))

    registerRecordingIpc(
      {
        stopRecording: vi.fn(),
        getState: vi.fn(() => ({ isRecording: false })),
        getRecordingsBaseDir: vi.fn(() => '/mock/recordings'),
        startRecording: vi.fn()
      } as any,
      {
        getStatus: vi.fn(),
        enqueue: vi.fn()
      } as any,
      {
        ensureReady: vi.fn(),
        getFfmpegPath: vi.fn(() => '/mock/ffmpeg')
      } as any,
      {
        isConnected: vi.fn(() => false),
        fetchAllRecentEvents: vi.fn().mockResolvedValue([])
      } as any
    )

    const getSourcesHandler = handle.mock.calls.find(
      ([channel]) => channel === 'recording:get-sources'
    )?.[1] as (() => Promise<unknown>) | undefined

    expect(getSourcesHandler).toBeTypeOf('function')
    await expect(getSourcesHandler?.()).rejects.toThrow(
      'AutoDoc could not list capture sources. Screen recording permission may be missing.'
    )
  })

  it('deletes only the selected recording directory and preserves managed models', async () => {
    const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'autodoc-recording-ipc-'))
    const recordingsDir = path.join(userDataDir, 'recordings')
    const meetingDir = path.join(recordingsDir, 'meeting-1')
    const modelsDir = path.join(userDataDir, 'models')
    const modelPath = path.join(modelsDir, 'ggml-large-v3.bin')
    const whisperBinaryPath = path.join(modelsDir, 'whisper-cpp')
    const ffmpegPath = path.join(modelsDir, 'ffmpeg')

    try {
      appGetPath.mockImplementation((name: string) => {
        if (name === 'userData') return userDataDir
        throw new Error(`unexpected app.getPath(${name})`)
      })
      await fsp.mkdir(meetingDir, { recursive: true })
      await fsp.mkdir(modelsDir, { recursive: true })
      await fsp.writeFile(path.join(meetingDir, 'audio.webm'), Buffer.alloc(8))
      await fsp.writeFile(modelPath, Buffer.alloc(8))
      await fsp.writeFile(whisperBinaryPath, Buffer.alloc(8))
      await fsp.writeFile(ffmpegPath, Buffer.alloc(8))

      registerRecordingIpc(
        {
          stopRecording: vi.fn(),
          getState: vi.fn(() => ({ isRecording: false })),
          getRecordingsBaseDir: vi.fn(() => recordingsDir),
          startRecording: vi.fn()
        } as any,
        {
          getStatus: vi.fn(),
          enqueue: vi.fn()
        } as any,
        {
          ensureReady: vi.fn(),
          getFfmpegPath: vi.fn(() => ffmpegPath),
          getWhisperPath: vi.fn(() => whisperBinaryPath),
          getModelPath: vi.fn(() => modelPath),
        } as any,
        {
          isConnected: vi.fn(() => false),
          fetchAllRecentEvents: vi.fn().mockResolvedValue([])
        } as any
      )

      const deleteHandler = handle.mock.calls.find(
        ([channel]) => channel === 'recording:delete'
      )?.[1] as ((_event: unknown, meetingId: string) => Promise<void>) | undefined

      expect(deleteHandler).toBeTypeOf('function')
      await deleteHandler?.(null, 'meeting-1')

      await expect(fsp.access(meetingDir)).rejects.toThrow()
      await expect(fsp.access(modelPath)).resolves.toBeUndefined()
      expect(logAutodocEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          area: 'recording',
          message: 'recording:delete requested',
          meetingId: 'meeting-1',
        }),
      )
      expect(logAutodocEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          area: 'recording',
          message: 'recording:delete completed',
          meetingId: 'meeting-1',
        }),
      )
    } finally {
      await fsp.rm(userDataDir, { recursive: true, force: true })
    }
  })
})
