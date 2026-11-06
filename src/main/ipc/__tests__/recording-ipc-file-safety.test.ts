import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fsp from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

const { handle, getAllWindows, logAutodocFailure, captureMessage } = vi.hoisted(() => ({
  handle: vi.fn(),
  getAllWindows: vi.fn(() => [] as unknown[]),
  logAutodocFailure: vi.fn(),
  captureMessage: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => os.tmpdir()) },
  ipcMain: { handle },
  desktopCapturer: { getSources: vi.fn() },
  BrowserWindow: { getAllWindows }
}))

vi.mock('../../services/crypto', () => ({
  // Like the real writer, this fails when the meeting folder is gone.
  encryptJSON: vi.fn(async (_value: unknown, filePath: string) => {
    await fsp.access(path.dirname(filePath))
  }),
  encryptFileInPlace: vi.fn().mockResolvedValue(undefined),
  isEncrypted: vi.fn().mockResolvedValue(false),
  decryptFileToTemp: vi.fn(async (filePath: string) => filePath)
}))

vi.mock('../../services/calendar-matcher', () => ({
  matchCalendarEvent: vi.fn(() => null),
  readMetadata: vi.fn().mockResolvedValue(null)
}))

vi.mock('../../services/autodoc-log', () => ({
  logAutodocEvent: vi.fn(),
  logAutodocFailure
}))

vi.mock('../../services/sentry-reporter', () => ({ captureMessage }))
vi.mock('../../services/tray', () => ({ refreshTray: vi.fn() }))
vi.mock('../../services/e2e-fixtures', () => ({ getE2ERecordingSources: vi.fn(() => []) }))

const MEETING = 'meeting-1'
const realPlatform = process.platform
let baseDir: string
let meetingDir: string

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value })
}

async function setup(
  platform: NodeJS.Platform,
  options: {
    isRecording?: boolean
    postProcessingHangs?: boolean
    transcribing?: string
    startRecording?: () => Promise<unknown>
    ranForMs?: number
  } = {}
) {
  setPlatform(platform)
  vi.resetModules()
  const { registerRecordingIpc } = await import('../recording-ipc')
  const state = { isRecording: options.isRecording ?? true, meetingId: MEETING as string | null }
  const completeProcessingHandoff = vi.fn()
  const enqueue = vi.fn()
  const tools = options.postProcessingHangs
    ? vi.fn(() => new Promise<void>(() => {}))
    : vi.fn().mockResolvedValue(undefined)
  const recording = registerRecordingIpc(
    {
      completeProcessingHandoff,
      stopRecording: vi.fn(() => {
        state.isRecording = false
        return {
          meetingId: MEETING,
          startedAt: Date.now() - (options.ranForMs ?? 2_000),
          sourceId: 'screen:0:0',
          sourceName: 'Screen',
          recordingIntent: 'general'
        }
      }),
      getState: vi.fn(() => state),
      getRecordingsBaseDir: vi.fn(() => baseDir),
      startRecording: vi.fn(options.startRecording)
    } as never,
    {
      getStatus: vi.fn(),
      enqueue,
      isActiveJob: vi.fn((meetingId: string) => meetingId === options.transcribing)
    } as never,
    {
      ensureReady: tools,
      ensureFfmpeg: tools,
      getFfmpegPath: vi.fn(() => '/mock/ffmpeg'),
      getWhisperPath: vi.fn(() => '/mock/whisper'),
      getModelPath: vi.fn(() => '/mock/model')
    } as never,
    {
      isConnected: vi.fn(() => false),
      fetchAllRecentEvents: vi.fn().mockResolvedValue([])
    } as never
  )
  const invoke = (channel: string, ...args: unknown[]): Promise<unknown> => {
    const call = handle.mock.calls.findLast(([registered]) => registered === channel)
    return (call?.[1] as (...handlerArgs: unknown[]) => Promise<unknown>)(null, ...args)
  }
  const saveChunk = (type: 'video' | 'mic' | 'system', meetingId = MEETING): Promise<unknown> =>
    invoke('recording:save-chunk', meetingId, type, new ArrayBuffer(4), 0)
  return { ...recording, state, invoke, saveChunk, enqueue, completeProcessingHandoff }
}

beforeEach(async () => {
  vi.clearAllMocks()
  baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'autodoc-file-safety-'))
  meetingDir = path.join(baseDir, MEETING)
  await fsp.mkdir(meetingDir)
  await fsp.writeFile(path.join(meetingDir, 'mic-0000.webm'), 'kept')
})

afterEach(async () => {
  setPlatform(realPlatform)
  await fsp.rm(baseDir, { recursive: true, force: true })
})

describe.each(['darwin', 'win32'] as const)('recording file safety on %s', (platform) => {
  describe('recording:delete', () => {
    it('refuses to delete the recording being captured', async () => {
      const { invoke } = await setup(platform)

      await expect(invoke('recording:delete', MEETING)).resolves.toEqual({ status: 'busy' })

      await expect(fsp.readFile(path.join(meetingDir, 'mic-0000.webm'), 'utf8')).resolves.toBe(
        'kept'
      )
    })

    it('refuses to delete a stopped recording that is still finishing', async () => {
      const { invoke, stopActiveRecording } = await setup(platform, { postProcessingHangs: true })
      stopActiveRecording()

      await expect(invoke('recording:delete', MEETING)).resolves.toEqual({ status: 'busy' })

      await expect(fsp.access(meetingDir)).resolves.toBeUndefined()
    })

    it('refuses to delete a recording that is being transcribed', async () => {
      const { invoke } = await setup(platform, { isRecording: false, transcribing: MEETING })

      await expect(invoke('recording:delete', MEETING)).resolves.toEqual({ status: 'busy' })

      await expect(fsp.readFile(path.join(meetingDir, 'mic-0000.webm'), 'utf8')).resolves.toBe(
        'kept'
      )
    })

    it('still deletes a recording while a different one is being transcribed', async () => {
      const { invoke } = await setup(platform, { isRecording: false, transcribing: 'other' })

      await expect(invoke('recording:delete', MEETING)).resolves.toEqual({ status: 'deleted' })
    })

    it('deletes a recording with no active work', async () => {
      const { invoke } = await setup(platform, { isRecording: false })

      await expect(invoke('recording:delete', MEETING)).resolves.toEqual({ status: 'deleted' })

      await expect(fsp.access(meetingDir)).rejects.toThrow()
    })

    it('reports whether Delete is available in the recording detail', async () => {
      const { invoke, state } = await setup(platform)
      await expect(invoke('recording:get-detail', MEETING)).resolves.toMatchObject({
        deleteBlocked: true
      })

      state.isRecording = false
      await expect(invoke('recording:get-detail', MEETING)).resolves.toMatchObject({
        deleteBlocked: false
      })
    })
  })

  describe('recording:save-chunk', () => {
    it('reports a written chunk', async () => {
      const { saveChunk } = await setup(platform)

      await expect(saveChunk('mic')).resolves.toEqual({ status: 'written' })
    })

    it('ignores chunks for a recording that is no longer capturing', async () => {
      const { saveChunk } = await setup(platform)

      await expect(saveChunk('mic', 'stale-meeting')).resolves.toEqual({ status: 'ignored' })
    })

    it('reports a deleted folder once across every track instead of once per chunk', async () => {
      const { saveChunk } = await setup(platform)
      await fsp.rm(meetingDir, { recursive: true })

      const results = await Promise.all([
        saveChunk('video'),
        saveChunk('mic'),
        saveChunk('system'),
        saveChunk('video'),
        saveChunk('mic'),
        saveChunk('system')
      ])

      for (const result of results) expect(result).toEqual({ status: 'failed', code: 'ENOENT' })
      expect(logAutodocFailure).toHaveBeenCalledTimes(1)
      expect(logAutodocFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Failed to write recording chunk',
          meetingId: MEETING,
          fingerprint: ['recording-chunk-write', 'ENOENT']
        })
      )
    })

    it('does not write again after the first failure, keeping what was already saved', async () => {
      const { saveChunk } = await setup(platform)
      // A directory at the track's path makes the append fail with a non-ENOENT error.
      await fsp.mkdir(path.join(meetingDir, 'system-0000.webm'))

      await expect(saveChunk('system')).resolves.toEqual({ status: 'failed', code: 'EISDIR' })
      await expect(saveChunk('mic')).resolves.toEqual({ status: 'failed', code: 'EISDIR' })

      await expect(fsp.readFile(path.join(meetingDir, 'mic-0000.webm'), 'utf8')).resolves.toBe(
        'kept'
      )
      expect(logAutodocFailure).toHaveBeenCalledTimes(1)
    })

    it('does not let one failed recording affect the next one', async () => {
      const { saveChunk, state } = await setup(platform)
      await fsp.rm(meetingDir, { recursive: true })
      await saveChunk('mic')

      state.meetingId = 'meeting-2'
      await fsp.mkdir(path.join(baseDir, 'meeting-2'))

      await expect(saveChunk('mic', 'meeting-2')).resolves.toEqual({ status: 'written' })
    })
  })

  it('tells the page once a stopped recording is no longer busy', async () => {
    const events: string[] = []
    getAllWindows.mockReturnValue([{ webContents: { send: () => events.push('broadcast') } }])
    const { invoke, stopActiveRecording, completeProcessingHandoff } = await setup(platform)
    completeProcessingHandoff.mockImplementation(() => events.push('handoff'))

    stopActiveRecording()
    if (platform === 'win32') await invoke('recording:finalize-stop', MEETING)
    await vi.waitFor(async () =>
      expect(await invoke('recording:get-detail', MEETING)).toMatchObject({ deleteBlocked: false })
    )

    expect(events.at(-1)).toBe('broadcast')
    getAllWindows.mockReturnValue([])
  })

  describe('stopping after the folder was removed', () => {
    async function stopWithoutFolder() {
      const recording = await setup(platform)
      await fsp.rm(meetingDir, { recursive: true })
      recording.stopActiveRecording()
      if (platform === 'win32') await recording.invoke('recording:finalize-stop', MEETING)
      await vi.waitFor(() => expect(recording.completeProcessingHandoff).toHaveBeenCalled())
      return recording
    }

    it('skips post-processing and reports nothing', async () => {
      const { enqueue } = await stopWithoutFolder()

      expect(enqueue).not.toHaveBeenCalled()
      expect(logAutodocFailure).not.toHaveBeenCalled()
      expect(captureMessage).not.toHaveBeenCalled()
    })

    it('clears the busy state', async () => {
      const { invoke } = await stopWithoutFolder()

      await vi.waitFor(() =>
        expect(invoke('recording:get-detail', MEETING)).resolves.toMatchObject({
          deleteBlocked: false
        })
      )
    })
  })
})

describe('isMeetingDirMissing', () => {
  it('treats ENOENT as missing and an existing folder as present', async () => {
    const { isMeetingDirMissing } = await import('../../services/meeting-dir')

    await expect(isMeetingDirMissing(path.join(baseDir, 'gone'))).resolves.toBe(true)
    await expect(isMeetingDirMissing(meetingDir)).resolves.toBe(false)
  })

  it('does not read any other error as a deleted recording', async () => {
    vi.resetModules()
    vi.doMock('fs/promises', async (importOriginal) => ({
      ...(await importOriginal<typeof import('fs/promises')>()),
      stat: vi.fn().mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }))
    }))
    try {
      const { isMeetingDirMissing } = await import('../../services/meeting-dir')

      await expect(isMeetingDirMissing(meetingDir)).resolves.toBe(false)
    } finally {
      vi.doUnmock('fs/promises')
    }
  })
})

describe('starting a recording', () => {
  it('does not report a start refused because AutoDoc is quitting', async () => {
    const { invoke } = await setup('darwin', {
      startRecording: async () => {
        const { RecordingShutdownError } = await import('../../services/recording')
        throw new RecordingShutdownError()
      }
    })

    await expect(invoke('recording:start', 'window:1', 'Zoom', null)).rejects.toThrow(
      'finishing your recording'
    )

    expect(logAutodocFailure).not.toHaveBeenCalled()
  })

  it('still reports any other failed start', async () => {
    const { invoke } = await setup('darwin', {
      startRecording: () => Promise.reject(new Error('disk failed'))
    })

    await expect(invoke('recording:start', 'window:1', 'Zoom', null)).rejects.toThrow('disk failed')

    expect(logAutodocFailure).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Failed to start recording' })
    )
  })
})

describe('a short Windows recording', () => {
  const NO_MEDIA = 'Recording stopped shortly after start with no captured media'

  it('is not called empty before the renderer has saved its last chunks', async () => {
    const { stopActiveRecording, invoke } = await setup('win32', { ranForMs: 4_000 })
    await fsp.rm(path.join(meetingDir, 'mic-0000.webm'))

    stopActiveRecording()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(captureMessage).not.toHaveBeenCalled()

    await fsp.writeFile(path.join(meetingDir, 'mic-0000.webm'), 'audio')
    await invoke('recording:finalize-stop', MEETING)
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(captureMessage).not.toHaveBeenCalledWith(NO_MEDIA, expect.anything())
  })

  it('is reported when nothing was saved by the time it finished stopping', async () => {
    const { stopActiveRecording, invoke } = await setup('win32', { ranForMs: 4_000 })
    await fsp.rm(path.join(meetingDir, 'mic-0000.webm'))

    stopActiveRecording()
    await invoke('recording:finalize-stop', MEETING)

    await vi.waitFor(() => expect(captureMessage).toHaveBeenCalledWith(NO_MEDIA, expect.anything()))
  })
})
