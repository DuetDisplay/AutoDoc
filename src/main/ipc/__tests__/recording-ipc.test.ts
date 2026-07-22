import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import * as fsp from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { spawn } from 'child_process'
import { registerRecordingIpc, spawnFfmpegWithStallDetection } from '../recording-ipc'
import { matchCalendarEvent, readMetadata } from '../../services/calendar-matcher'
import { decryptFileToTemp, encryptJSON, isEncrypted } from '../../services/crypto'
import type { CalendarEvent, MeetingMetadata } from '../../../shared/types'

const { handle, getSources, appGetPath, logAutodocEvent, logAutodocFailure, captureMessage, spawnBehavior } =
  vi.hoisted(() => ({
  handle: vi.fn(),
  getSources: vi.fn(),
  appGetPath: vi.fn(),
  logAutodocEvent: vi.fn(),
  logAutodocFailure: vi.fn(),
  captureMessage: vi.fn(),
  spawnBehavior: { current: 'success' as 'success' | 'stall' | 'fail' }
}))

class MockFfmpegProcess extends EventEmitter {
  pid = 1
  stderr = new EventEmitter()
  stdout = new EventEmitter()
  kill = vi.fn(() => {
    this.emit('close', null)
  })
}

vi.mock('child_process', () => ({
  spawn: vi.fn(() => {
    const proc = new MockFfmpegProcess()
    if (spawnBehavior.current === 'success') {
      setTimeout(() => {
        proc.stdout.emit('data', Buffer.from('progress=continue\n'))
        proc.emit('close', 0)
      }, 0)
    } else if (spawnBehavior.current === 'fail') {
      setTimeout(() => {
        proc.stderr.emit('data', Buffer.from('encode error'))
        proc.emit('close', 1)
      }, 0)
    }
    return proc
  })
}))

vi.mock('electron', () => ({
  app: { getPath: appGetPath },
  ipcMain: { handle },
  desktopCapturer: { getSources },
  BrowserWindow: { getAllWindows: vi.fn(() => []) }
}))

vi.mock('../../services/crypto', () => ({
  encryptJSON: vi.fn(),
  encryptFileInPlace: vi.fn().mockResolvedValue(undefined),
  isEncrypted: vi.fn().mockResolvedValue(false),
  decryptFileToTemp: vi.fn().mockImplementation(async (filePath: string) => filePath)
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
    spawnBehavior.current = 'success'
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

describe.runIf(process.platform === 'win32')('recoverWindowsFinalizingMeetings', () => {
  const startedAt = Date.now() - 60_000
  const stoppedAt = Date.now() - 5_000

  function createFinalizingMetadata(): MeetingMetadata {
    return {
      sourceName: 'Entire screen',
      startedAt,
      stoppedAt,
      durationSeconds: 55,
      isFinalizing: true
    }
  }

  function createCompletedMetadata(): MeetingMetadata {
    return {
      sourceName: 'Entire screen',
      startedAt,
      stoppedAt,
      durationSeconds: 55,
      isFinalizing: false
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    spawnBehavior.current = 'success'
    vi.mocked(matchCalendarEvent).mockReturnValue(null)
    delete process.env.AUTODOC_E2E
  })

  it('re-runs post-processing for meetings stuck in finalizing state', async () => {
    const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'autodoc-recovery-'))
    const recordingsDir = path.join(userDataDir, 'recordings')
    const meetingId = 'meeting-finalizing'
    const meetingDir = path.join(recordingsDir, meetingId)
    const finalizingMetadata = createFinalizingMetadata()
    const enqueue = vi.fn()

    try {
      await fsp.mkdir(meetingDir, { recursive: true })
      await fsp.writeFile(path.join(meetingDir, 'mic-0000.webm'), Buffer.alloc(8))
      vi.mocked(readMetadata).mockImplementation(async (dir) => {
        if (path.basename(dir) === meetingId) return finalizingMetadata
        return null
      })

      const { recoverWindowsFinalizingMeetings } = registerRecordingIpc(
        {
          stopRecording: vi.fn(),
          getState: vi.fn(() => ({ isRecording: false, meetingId: null })),
          getRecordingsBaseDir: vi.fn(() => recordingsDir),
          startRecording: vi.fn()
        } as any,
        {
          getStatus: vi.fn(),
          enqueue
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

      await recoverWindowsFinalizingMeetings()

      await vi.waitFor(() => {
        expect(enqueue).toHaveBeenCalledWith(meetingId)
      })
      await vi.waitFor(() => {
        expect(encryptJSON).toHaveBeenCalledWith(
          expect.objectContaining({ isFinalizing: false }),
          expect.stringContaining('metadata.json')
        )
      })
      expect(logAutodocEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          area: 'recording',
          message: 'windows finalizing recovery: re-running post-processing',
          meetingId
        })
      )
    } finally {
      await fsp.rm(userDataDir, { recursive: true, force: true })
    }
  })

  it('does not recover meetings that are not finalizing', async () => {
    const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'autodoc-recovery-'))
    const recordingsDir = path.join(userDataDir, 'recordings')
    const meetingId = 'meeting-complete'
    const meetingDir = path.join(recordingsDir, meetingId)
    const enqueue = vi.fn()

    try {
      await fsp.mkdir(meetingDir, { recursive: true })
      await fsp.writeFile(path.join(meetingDir, 'mic.webm'), Buffer.alloc(8))
      vi.mocked(readMetadata).mockImplementation(async (dir) => {
        if (path.basename(dir) === meetingId) return createCompletedMetadata()
        return null
      })

      const { recoverWindowsFinalizingMeetings } = registerRecordingIpc(
        {
          stopRecording: vi.fn(),
          getState: vi.fn(() => ({ isRecording: false, meetingId: null })),
          getRecordingsBaseDir: vi.fn(() => recordingsDir),
          startRecording: vi.fn()
        } as any,
        {
          getStatus: vi.fn(),
          enqueue
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

      await recoverWindowsFinalizingMeetings()

      expect(enqueue).not.toHaveBeenCalled()
    } finally {
      await fsp.rm(userDataDir, { recursive: true, force: true })
    }
  })

  it('skips the actively recording meeting even if metadata says finalizing', async () => {
    const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'autodoc-recovery-'))
    const recordingsDir = path.join(userDataDir, 'recordings')
    const meetingId = 'meeting-active'
    const meetingDir = path.join(recordingsDir, meetingId)
    const enqueue = vi.fn()

    try {
      await fsp.mkdir(meetingDir, { recursive: true })
      await fsp.writeFile(path.join(meetingDir, 'mic-0000.webm'), Buffer.alloc(8))
      vi.mocked(readMetadata).mockImplementation(async (dir) => {
        if (path.basename(dir) === meetingId) return createFinalizingMetadata()
        return null
      })

      const { recoverWindowsFinalizingMeetings } = registerRecordingIpc(
        {
          stopRecording: vi.fn(),
          getState: vi.fn(() => ({ isRecording: true, meetingId })),
          getRecordingsBaseDir: vi.fn(() => recordingsDir),
          startRecording: vi.fn()
        } as any,
        {
          getStatus: vi.fn(),
          enqueue
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

      await recoverWindowsFinalizingMeetings()

      expect(enqueue).not.toHaveBeenCalled()
    } finally {
      await fsp.rm(userDataDir, { recursive: true, force: true })
    }
  })

  it('re-enqueues interrupted video jobs for videoStatus processing', async () => {
    const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'autodoc-recovery-video-'))
    const recordingsDir = path.join(userDataDir, 'recordings')
    const meetingId = 'meeting-video-processing'
    const meetingDir = path.join(recordingsDir, meetingId)

    try {
      await fsp.mkdir(meetingDir, { recursive: true })
      await fsp.writeFile(path.join(meetingDir, 'screen.webm'), Buffer.alloc(64))
      vi.mocked(readMetadata).mockImplementation(async (dir) => {
        if (path.basename(dir) === meetingId) {
          return {
            sourceName: 'Entire screen',
            startedAt,
            stoppedAt,
            durationSeconds: 55,
            isFinalizing: false,
            videoStatus: 'processing'
          }
        }
        return null
      })
      vi.mocked(encryptJSON).mockResolvedValue(undefined as never)

      const { recoverWindowsFinalizingMeetings } = registerRecordingIpc(
        {
          stopRecording: vi.fn(),
          getState: vi.fn(() => ({ isRecording: false, meetingId: null })),
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

      await recoverWindowsFinalizingMeetings()

      await vi.waitFor(() => {
        expect(encryptJSON).toHaveBeenCalledWith(
          expect.objectContaining({ videoStatus: 'ready' }),
          expect.stringContaining('metadata.json')
        )
      })
      expect(logAutodocEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'windows video recovery: re-enqueueing interrupted video job',
          meetingId
        })
      )
    } finally {
      vi.mocked(encryptJSON).mockReset()
      await fsp.rm(userDataDir, { recursive: true, force: true })
    }
  })

  it('does not auto-retry meetings with videoStatus failed', async () => {
    const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'autodoc-recovery-failed-'))
    const recordingsDir = path.join(userDataDir, 'recordings')
    const meetingId = 'meeting-video-failed'
    const meetingDir = path.join(recordingsDir, meetingId)

    try {
      await fsp.mkdir(meetingDir, { recursive: true })
      await fsp.writeFile(path.join(meetingDir, 'screen-0000.webm'), Buffer.alloc(8))
      await fsp.writeFile(path.join(meetingDir, 'screen-0001.webm'), Buffer.alloc(8))
      vi.mocked(readMetadata).mockImplementation(async (dir) => {
        if (path.basename(dir) === meetingId) {
          return {
            sourceName: 'Entire screen',
            startedAt,
            stoppedAt,
            durationSeconds: 55,
            isFinalizing: false,
            videoStatus: 'failed',
            videoProcessingFailed: true
          }
        }
        return null
      })

      const { recoverWindowsFinalizingMeetings } = registerRecordingIpc(
        {
          stopRecording: vi.fn(),
          getState: vi.fn(() => ({ isRecording: false, meetingId: null })),
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

      await recoverWindowsFinalizingMeetings()

      expect(encryptJSON).not.toHaveBeenCalled()
    } finally {
      await fsp.rm(userDataDir, { recursive: true, force: true })
    }
  })
})

describe.runIf(process.platform === 'win32')('windows finalize-stop robustness', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    spawnBehavior.current = 'success'
    vi.mocked(matchCalendarEvent).mockReturnValue(null)
    delete process.env.AUTODOC_E2E
  })

  function register(options: { recordingsDir: string; stopResult?: Record<string, unknown> }) {
    return registerRecordingIpc(
      {
        stopRecording: vi.fn(() => options.stopResult),
        getState: vi.fn(() => ({ isRecording: false, meetingId: null })),
        getRecordingsBaseDir: vi.fn(() => options.recordingsDir),
        startRecording: vi.fn()
      } as any,
      {
        getStatus: vi.fn(),
        enqueue: enqueueMock
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
  }

  const enqueueMock = vi.fn()

  it('runs post-processing even when persisting finalizing metadata fails', async () => {
    const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'autodoc-finalize-'))
    const recordingsDir = path.join(userDataDir, 'recordings')
    const meetingId = 'meeting-persist-fails'
    const meetingDir = path.join(recordingsDir, meetingId)

    try {
      await fsp.mkdir(meetingDir, { recursive: true })
      vi.mocked(readMetadata).mockImplementation(async (dir) => {
        if (path.basename(dir) === meetingId) {
          return {
            sourceName: 'Entire screen',
            startedAt: Date.now() - 30_000,
            stoppedAt: Date.now() - 1_000,
            durationSeconds: 29,
            isFinalizing: true
          }
        }
        return null
      })
      vi.mocked(encryptJSON).mockRejectedValue(new Error('EPERM: rename collision'))

      register({ recordingsDir })

      const finalizeHandler = handle.mock.calls.find(
        ([channel]) => channel === 'recording:finalize-stop'
      )?.[1] as ((event: unknown, meetingId: string) => Promise<void>) | undefined
      expect(finalizeHandler).toBeTypeOf('function')

      await finalizeHandler?.(null, meetingId)

      await vi.waitFor(() => {
        expect(enqueueMock).toHaveBeenCalledWith(meetingId)
      })
      expect(logAutodocFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Failed to persist finalizing metadata during finalize-stop; continuing',
          meetingId
        })
      )
    } finally {
      vi.mocked(encryptJSON).mockReset()
      await fsp.rm(userDataDir, { recursive: true, force: true })
    }
  })

  it('watchdog finalizes a stopped recording when finalize-stop never arrives', async () => {
    const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'autodoc-watchdog-'))
    const recordingsDir = path.join(userDataDir, 'recordings')
    const meetingId = 'meeting-no-finalize'
    const meetingDir = path.join(recordingsDir, meetingId)

    try {
      await fsp.mkdir(meetingDir, { recursive: true })
      vi.mocked(encryptJSON).mockResolvedValue(undefined as never)

      const { stopActiveRecording } = register({
        recordingsDir,
        stopResult: {
          meetingId,
          startedAt: Date.now() - 10_000,
          sourceId: 'window:1:0',
          sourceName: null,
          recordingIntent: 'general'
        }
      })

      vi.useFakeTimers()
      try {
        stopActiveRecording()
        expect(enqueueMock).not.toHaveBeenCalled()

        // Fire the watchdog (60s) and the post-processing startup delay (100ms).
        await vi.advanceTimersByTimeAsync(61_000)
      } finally {
        vi.useRealTimers()
      }

      // The rest of post-processing does real file I/O, so poll with real timers.
      await vi.waitFor(() => {
        expect(enqueueMock).toHaveBeenCalledWith(meetingId)
      })
    } finally {
      vi.mocked(encryptJSON).mockReset()
      await fsp.rm(userDataDir, { recursive: true, force: true })
    }
  })

  it('kills stalled ffmpeg processes when no progress is received', async () => {
    spawnBehavior.current = 'stall'

    vi.useFakeTimers()
    try {
      const promise = spawnFfmpegWithStallDetection('video concat', '/mock/ffmpeg', ['-i', 'input.webm'], {
        meetingId: 'meeting-stall',
        stallTimeoutMs: 1_000
      })
      const assertion = expect(promise).rejects.toThrow('ffmpeg video concat stalled after 1000ms')
      await vi.advanceTimersByTimeAsync(1_001)
      await assertion
    } finally {
      spawnBehavior.current = 'success'
      vi.useRealTimers()
    }
  })

  it('clears finalizing in Phase 1 and sets videoStatus failed when video concat fails', async () => {
    const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'autodoc-video-fail-'))
    const recordingsDir = path.join(userDataDir, 'recordings')
    const meetingId = 'meeting-video-fail'
    const meetingDir = path.join(recordingsDir, meetingId)

    try {
      await fsp.mkdir(meetingDir, { recursive: true })
      await fsp.writeFile(path.join(meetingDir, 'screen-0000.webm'), Buffer.alloc(8))
      await fsp.writeFile(path.join(meetingDir, 'screen-0001.webm'), Buffer.alloc(8))
      vi.mocked(readMetadata).mockImplementation(async (dir) => {
        if (path.basename(dir) === meetingId) {
          return {
            sourceName: 'Entire screen',
            startedAt: Date.now() - 30_000,
            stoppedAt: Date.now() - 1_000,
            durationSeconds: 29,
            isFinalizing: true
          }
        }
        return null
      })
      vi.mocked(encryptJSON).mockResolvedValue(undefined as never)
      spawnBehavior.current = 'fail'

      register({ recordingsDir })

      const finalizeHandler = handle.mock.calls.find(
        ([channel]) => channel === 'recording:finalize-stop'
      )?.[1] as ((event: unknown, meetingId: string) => Promise<void>) | undefined
      expect(finalizeHandler).toBeTypeOf('function')

      await finalizeHandler?.(null, meetingId)

      await vi.waitFor(() => {
        expect(encryptJSON).toHaveBeenCalledWith(
          expect.objectContaining({
            isFinalizing: false,
            videoStatus: 'processing'
          }),
          expect.stringContaining('metadata.json')
        )
      })

      await vi.waitFor(() => {
        expect(encryptJSON).toHaveBeenCalledWith(
          expect.objectContaining({
            videoStatus: 'failed',
            videoProcessingFailed: true
          }),
          expect.stringContaining('metadata.json')
        )
      })
      expect(logAutodocFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Failed to assemble segmented recording video',
          meetingId
        })
      )
      await expect(fsp.access(path.join(meetingDir, 'screen-0000.webm'))).resolves.toBeUndefined()
      await expect(fsp.access(path.join(meetingDir, 'screen-0001.webm'))).resolves.toBeUndefined()
    } finally {
      spawnBehavior.current = 'success'
      vi.mocked(encryptJSON).mockReset()
      await fsp.rm(userDataDir, { recursive: true, force: true })
    }
  })

  it('attempts stream-copy concat before VP9 re-encode for multi-segment video', async () => {
    const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'autodoc-video-copy-'))
    const recordingsDir = path.join(userDataDir, 'recordings')
    const meetingId = 'meeting-video-copy'
    const meetingDir = path.join(recordingsDir, meetingId)
    const spawnCalls: string[][] = []
    const spawnMock = vi.mocked(spawn)

    try {
      await fsp.mkdir(meetingDir, { recursive: true })
      await fsp.writeFile(path.join(meetingDir, 'screen-0000.webm'), Buffer.alloc(64))
      await fsp.writeFile(path.join(meetingDir, 'screen-0001.webm'), Buffer.alloc(64))
      vi.mocked(readMetadata).mockImplementation(async (dir) => {
        if (path.basename(dir) === meetingId) {
          return {
            sourceName: 'Entire screen',
            startedAt: Date.now() - 30_000,
            stoppedAt: Date.now() - 1_000,
            durationSeconds: 29,
            isFinalizing: true
          }
        }
        return null
      })
      vi.mocked(encryptJSON).mockResolvedValue(undefined as never)

      spawnMock.mockImplementation(((...spawnArgs: unknown[]) => {
        const args = (spawnArgs[1] as string[] | undefined) ?? []
        spawnCalls.push(args)
        const proc = new MockFfmpegProcess()
        setTimeout(() => {
          proc.stdout.emit('data', Buffer.from('progress=continue\n'))
          proc.emit('close', 0)
        }, 0)
        return proc as never
      }) as typeof spawn)

      register({ recordingsDir })

      const finalizeHandler = handle.mock.calls.find(
        ([channel]) => channel === 'recording:finalize-stop'
      )?.[1] as ((event: unknown, meetingId: string) => Promise<void>) | undefined
      await finalizeHandler?.(null, meetingId)

      await vi.waitFor(() => {
        expect(
          spawnCalls.some((args) => args.includes('copy') && args.includes('concat'))
        ).toBe(true)
      })

      await vi.waitFor(() => {
        expect(encryptJSON).toHaveBeenCalledWith(
          expect.objectContaining({ videoStatus: 'ready' }),
          expect.stringContaining('metadata.json')
        )
      })
    } finally {
      spawnMock.mockReset()
      vi.mocked(encryptJSON).mockReset()
      await fsp.rm(userDataDir, { recursive: true, force: true })
    }
  })

  it('decrypts encrypted audio inputs before muxing', async () => {
    const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'autodoc-video-mux-decrypt-'))
    const recordingsDir = path.join(userDataDir, 'recordings')
    const meetingId = 'meeting-mux-decrypt'
    const meetingDir = path.join(recordingsDir, meetingId)

    try {
      await fsp.mkdir(meetingDir, { recursive: true })
      await fsp.writeFile(path.join(meetingDir, 'screen.webm'), Buffer.alloc(64))
      await fsp.writeFile(path.join(meetingDir, 'mic.webm'), Buffer.alloc(64))
      vi.mocked(readMetadata).mockImplementation(async (dir) => {
        if (path.basename(dir) === meetingId) {
          return {
            sourceName: 'Entire screen',
            startedAt: Date.now() - 30_000,
            stoppedAt: Date.now() - 1_000,
            durationSeconds: 29,
            isFinalizing: true
          }
        }
        return null
      })
      vi.mocked(encryptJSON).mockResolvedValue(undefined as never)
      vi.mocked(isEncrypted).mockImplementation(async (filePath) => filePath.endsWith('mic.webm'))
      vi.mocked(decryptFileToTemp).mockImplementation(async (filePath) => `${filePath}.decrypted`)

      register({ recordingsDir })

      const finalizeHandler = handle.mock.calls.find(
        ([channel]) => channel === 'recording:finalize-stop'
      )?.[1] as ((event: unknown, meetingId: string) => Promise<void>) | undefined
      await finalizeHandler?.(null, meetingId)

      await vi.waitFor(() => {
        expect(decryptFileToTemp).toHaveBeenCalledWith(expect.stringContaining('mic.webm'))
      })
      await vi.waitFor(() => {
        expect(encryptJSON).toHaveBeenCalledWith(
          expect.objectContaining({ videoStatus: 'ready' }),
          expect.stringContaining('metadata.json')
        )
      })
    } finally {
      vi.mocked(isEncrypted).mockResolvedValue(false)
      vi.mocked(decryptFileToTemp).mockReset()
      vi.mocked(encryptJSON).mockReset()
      await fsp.rm(userDataDir, { recursive: true, force: true })
    }
  })

  it('recording:retry-video resets status and enqueues video processing', async () => {
    const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'autodoc-retry-video-'))
    const recordingsDir = path.join(userDataDir, 'recordings')
    const meetingId = 'meeting-retry-video'
    const meetingDir = path.join(recordingsDir, meetingId)

    try {
      await fsp.mkdir(meetingDir, { recursive: true })
      await fsp.writeFile(path.join(meetingDir, 'screen.webm'), Buffer.alloc(64))
      vi.mocked(readMetadata).mockResolvedValue({
        sourceName: 'Entire screen',
        startedAt: Date.now() - 30_000,
        stoppedAt: Date.now() - 1_000,
        durationSeconds: 29,
        videoStatus: 'failed',
        videoProcessingFailed: true
      })
      vi.mocked(encryptJSON).mockResolvedValue(undefined as never)

      register({ recordingsDir })

      const retryHandler = handle.mock.calls.find(
        ([channel]) => channel === 'recording:retry-video'
      )?.[1] as ((event: unknown, meetingId: string) => Promise<void>) | undefined
      expect(retryHandler).toBeTypeOf('function')

      await retryHandler?.(null, meetingId)

      expect(encryptJSON).toHaveBeenCalledWith(
        expect.objectContaining({
          videoStatus: 'processing',
          videoProcessingFailed: undefined
        }),
        expect.stringContaining('metadata.json')
      )
      await vi.waitFor(() => {
        expect(encryptJSON).toHaveBeenCalledWith(
          expect.objectContaining({ videoStatus: 'ready' }),
          expect.stringContaining('metadata.json')
        )
      })
    } finally {
      vi.mocked(readMetadata).mockReset()
      vi.mocked(encryptJSON).mockReset()
      await fsp.rm(userDataDir, { recursive: true, force: true })
    }
  })
})
