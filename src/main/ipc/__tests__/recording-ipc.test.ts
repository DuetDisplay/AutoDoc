import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as fsp from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { registerRecordingIpc } from '../recording-ipc'
import { matchCalendarEvent, readMetadata } from '../../services/calendar-matcher'
import type { CalendarEvent, MeetingMetadata } from '../../../shared/types'

const { handle, getSources, appGetPath, logAutodocEvent, logAutodocFailure, captureMessage } = vi.hoisted(() => ({
  handle: vi.fn(),
  getSources: vi.fn(),
  appGetPath: vi.fn(),
  logAutodocEvent: vi.fn(),
  logAutodocFailure: vi.fn(),
  captureMessage: vi.fn(),
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

vi.mock('../../services/sentry-reporter', () => ({
  captureMessage
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
    vi.mocked(readMetadata).mockResolvedValue(null)
    vi.mocked(matchCalendarEvent).mockReturnValue(null)
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

  it('reports rapid recording aborts that produce no media files', async () => {
    const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'autodoc-recording-ipc-'))
    const recordingsDir = path.join(userDataDir, 'recordings')
    const meetingDir = path.join(recordingsDir, 'meeting-rapid-abort')

    try {
      appGetPath.mockImplementation((name: string) => {
        if (name === 'userData') return userDataDir
        throw new Error(`unexpected app.getPath(${name})`)
      })
      await fsp.mkdir(meetingDir, { recursive: true })

      const { stopActiveRecording } = registerRecordingIpc(
        {
          stopRecording: vi.fn(() => ({
            meetingId: 'meeting-rapid-abort',
            startedAt: Date.now() - 2_000,
            sourceId: 'screen:0:0',
            sourceName: 'Entire screen',
            recordingIntent: 'general'
          })),
          getState: vi.fn(() => ({ isRecording: true })),
          getRecordingsBaseDir: vi.fn(() => recordingsDir),
          startRecording: vi.fn()
        } as any,
        {
          getStatus: vi.fn(),
          enqueue: vi.fn()
        } as any,
        {
          ensureReady: vi.fn(),
          getFfmpegPath: vi.fn(() => '/mock/ffmpeg'),
          getWhisperPath: vi.fn(() => '/mock/whisper'),
          getModelPath: vi.fn(() => '/mock/model')
        } as any,
        {
          isConnected: vi.fn(() => false),
          fetchAllRecentEvents: vi.fn().mockResolvedValue([])
        } as any
      )

      stopActiveRecording()

      await vi.waitFor(() => {
        expect(logAutodocEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            area: 'recording',
            level: 'warn',
            message: 'Recording stopped shortly after start with no captured media',
            meetingId: 'meeting-rapid-abort'
          })
        )
      })
      expect(captureMessage).toHaveBeenCalledWith(
        'Recording stopped shortly after start with no captured media',
        expect.objectContaining({
          area: 'recording',
          meetingId: 'meeting-rapid-abort',
          level: 'warning'
        })
      )
    } finally {
      await fsp.rm(userDataDir, { recursive: true, force: true })
    }
  })

  it('does not rename existing source-titled recordings from newly linked calendar matches', async () => {
    const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'autodoc-recording-ipc-'))
    const recordingsDir = path.join(userDataDir, 'recordings')
    const meetingId = 'meeting-before-calendar-link'
    const meetingDir = path.join(recordingsDir, meetingId)
    const startedAt = new Date(2026, 5, 15, 7, 49).getTime()
    const metadata: MeetingMetadata = {
      sourceName: 'Entire screen',
      startedAt,
      stoppedAt: startedAt + 60_000,
      durationSeconds: 60
    }
    const homeEvent: CalendarEvent = {
      id: 'google_home-all-day',
      externalId: 'home-all-day',
      accountId: 'google-account-1',
      provider: 'google',
      recurringEventId: null,
      title: 'Home',
      startTime: startedAt - 12 * 60 * 60_000,
      endTime: startedAt + 12 * 60 * 60_000,
      isAllDay: true,
      attendees: [],
      meetingUrl: null,
      autoRecord: 'off',
      syncedAt: startedAt
    }

    try {
      await fsp.mkdir(meetingDir, { recursive: true })
      await fsp.writeFile(path.join(meetingDir, 'mic.webm'), Buffer.alloc(8))
      vi.mocked(readMetadata).mockResolvedValue(metadata)
      vi.mocked(matchCalendarEvent).mockReturnValue(homeEvent)

      registerRecordingIpc(
        {
          stopRecording: vi.fn(),
          getState: vi.fn(() => ({ isRecording: false })),
          getRecordingsBaseDir: vi.fn(() => recordingsDir),
          startRecording: vi.fn()
        } as any,
        {
          getStatus: vi.fn().mockResolvedValue('complete'),
          enqueue: vi.fn()
        } as any,
        {
          ensureReady: vi.fn(),
          getFfmpegPath: vi.fn(() => '/mock/ffmpeg')
        } as any,
        {
          isConnected: vi.fn(() => true),
          fetchAllRecentEvents: vi.fn().mockResolvedValue([homeEvent])
        } as any
      )

      const listHandler = handle.mock.calls.find(
        ([channel]) => channel === 'recording:list'
      )?.[1] as (() => Promise<Array<{ meetingId: string; title: string }>>) | undefined

      expect(listHandler).toBeTypeOf('function')
      const entries = await listHandler?.()

      expect(entries).toEqual([
        expect.objectContaining({
          meetingId,
          title: expect.stringMatching(/^Entire screen /)
        })
      ])
    } finally {
      await fsp.rm(userDataDir, { recursive: true, force: true })
    }
  })

  it('still uses timed calendar matches as recording titles', async () => {
    const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'autodoc-recording-ipc-'))
    const recordingsDir = path.join(userDataDir, 'recordings')
    const meetingId = 'meeting-during-timed-event'
    const meetingDir = path.join(recordingsDir, meetingId)
    const startedAt = new Date(2026, 5, 15, 10, 0).getTime()
    const metadata: MeetingMetadata = {
      sourceName: 'Zoom Workplace',
      startedAt,
      stoppedAt: startedAt + 30 * 60_000,
      durationSeconds: 30 * 60
    }
    const designReviewEvent: CalendarEvent = {
      id: 'google_design-review',
      externalId: 'design-review',
      accountId: 'google-account-1',
      provider: 'google',
      recurringEventId: null,
      title: 'Design Review',
      startTime: startedAt - 5 * 60_000,
      endTime: startedAt + 55 * 60_000,
      isAllDay: false,
      attendees: [],
      meetingUrl: 'https://meet.google.com/abc-defg-hij',
      autoRecord: 'off',
      syncedAt: startedAt
    }

    try {
      await fsp.mkdir(meetingDir, { recursive: true })
      await fsp.writeFile(path.join(meetingDir, 'mic.webm'), Buffer.alloc(8))
      vi.mocked(readMetadata).mockResolvedValue(metadata)
      vi.mocked(matchCalendarEvent).mockReturnValue(designReviewEvent)

      registerRecordingIpc(
        {
          stopRecording: vi.fn(),
          getState: vi.fn(() => ({ isRecording: false })),
          getRecordingsBaseDir: vi.fn(() => recordingsDir),
          startRecording: vi.fn()
        } as any,
        {
          getStatus: vi.fn().mockResolvedValue('complete'),
          enqueue: vi.fn()
        } as any,
        {
          ensureReady: vi.fn(),
          getFfmpegPath: vi.fn(() => '/mock/ffmpeg')
        } as any,
        {
          isConnected: vi.fn(() => true),
          fetchAllRecentEvents: vi.fn().mockResolvedValue([designReviewEvent])
        } as any
      )

      const listHandler = handle.mock.calls.find(
        ([channel]) => channel === 'recording:list'
      )?.[1] as (() => Promise<Array<{ meetingId: string; title: string }>>) | undefined

      expect(listHandler).toBeTypeOf('function')
      const entries = await listHandler?.()

      expect(entries).toEqual([
        expect.objectContaining({
          meetingId,
          title: expect.stringMatching(/^Design Review /)
        })
      ])
    } finally {
      await fsp.rm(userDataDir, { recursive: true, force: true })
    }
  })

  it('preserves timed match precedence over persisted calendar titles', async () => {
    const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'autodoc-recording-ipc-'))
    const recordingsDir = path.join(userDataDir, 'recordings')
    const meetingId = 'meeting-with-live-timed-match'
    const meetingDir = path.join(recordingsDir, meetingId)
    const startedAt = new Date(2026, 5, 15, 11, 0).getTime()
    const metadata: MeetingMetadata = {
      sourceName: 'Zoom Workplace',
      calendarTitle: 'Persisted Planning',
      startedAt,
      stoppedAt: startedAt + 30 * 60_000,
      durationSeconds: 30 * 60
    }
    const currentTimedEvent: CalendarEvent = {
      id: 'google_current-review',
      externalId: 'current-review',
      accountId: 'google-account-1',
      provider: 'google',
      recurringEventId: null,
      title: 'Current Review',
      startTime: startedAt - 5 * 60_000,
      endTime: startedAt + 55 * 60_000,
      isAllDay: false,
      attendees: [],
      meetingUrl: 'https://meet.google.com/current-review',
      autoRecord: 'off',
      syncedAt: startedAt
    }

    try {
      await fsp.mkdir(meetingDir, { recursive: true })
      await fsp.writeFile(path.join(meetingDir, 'mic.webm'), Buffer.alloc(8))
      vi.mocked(readMetadata).mockResolvedValue(metadata)
      vi.mocked(matchCalendarEvent).mockReturnValue(currentTimedEvent)

      registerRecordingIpc(
        {
          stopRecording: vi.fn(),
          getState: vi.fn(() => ({ isRecording: false })),
          getRecordingsBaseDir: vi.fn(() => recordingsDir),
          startRecording: vi.fn()
        } as any,
        {
          getStatus: vi.fn().mockResolvedValue('complete'),
          enqueue: vi.fn()
        } as any,
        {
          ensureReady: vi.fn(),
          getFfmpegPath: vi.fn(() => '/mock/ffmpeg')
        } as any,
        {
          isConnected: vi.fn(() => true),
          fetchAllRecentEvents: vi.fn().mockResolvedValue([currentTimedEvent])
        } as any
      )

      const listHandler = handle.mock.calls.find(
        ([channel]) => channel === 'recording:list'
      )?.[1] as (() => Promise<Array<{ meetingId: string; title: string }>>) | undefined

      expect(listHandler).toBeTypeOf('function')
      const entries = await listHandler?.()

      expect(entries).toEqual([
        expect.objectContaining({
          meetingId,
          title: expect.stringMatching(/^Current Review /)
        })
      ])
    } finally {
      await fsp.rm(userDataDir, { recursive: true, force: true })
    }
  })

  it('preserves concurrent segment timing writes for recovered audio assembly', async () => {
    const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'autodoc-recording-ipc-'))
    const recordingsDir = path.join(userDataDir, 'recordings')
    const meetingDir = path.join(recordingsDir, 'meeting-timing')

    try {
      await fsp.mkdir(meetingDir, { recursive: true })

      registerRecordingIpc(
        {
          stopRecording: vi.fn(),
          getState: vi.fn(() => ({ isRecording: true, meetingId: 'meeting-timing' })),
          getRecordingsBaseDir: vi.fn(() => recordingsDir),
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

      const saveSegmentTimingHandler = handle.mock.calls.find(
        ([channel]) => channel === 'recording:save-segment-timing'
      )?.[1] as
        | ((
            event: unknown,
            meetingId: string,
            type: 'mic' | 'system',
            segmentIndex: number,
            offsetMs: number
          ) => Promise<void>)
        | undefined

      expect(saveSegmentTimingHandler).toBeTypeOf('function')
      await Promise.all([
        saveSegmentTimingHandler?.(null, 'meeting-timing', 'mic', 0, 0),
        saveSegmentTimingHandler?.(null, 'meeting-timing', 'system', 0, 0),
        saveSegmentTimingHandler?.(null, 'meeting-timing', 'mic', 1, 14_250)
      ])

      const raw = await fsp.readFile(path.join(meetingDir, 'segment-timings.json'), 'utf-8')
      const entries = JSON.parse(raw)

      expect(entries).toEqual(
        expect.arrayContaining([
          { type: 'mic', segmentIndex: 0, offsetMs: 0 },
          { type: 'system', segmentIndex: 0, offsetMs: 0 },
          { type: 'mic', segmentIndex: 1, offsetMs: 14250 }
        ])
      )
    } finally {
      await fsp.rm(userDataDir, { recursive: true, force: true })
    }
  })

})
