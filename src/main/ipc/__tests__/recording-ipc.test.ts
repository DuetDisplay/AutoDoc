import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerRecordingIpc } from '../recording-ipc'

const { handle, getSources } = vi.hoisted(() => ({
  handle: vi.fn(),
  getSources: vi.fn()
}))

vi.mock('electron', () => ({
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
  logAutodocEvent: vi.fn(),
  logAutodocFailure: vi.fn()
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
})
