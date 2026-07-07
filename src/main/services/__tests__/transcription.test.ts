import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TranscriptionService } from '../transcription'
import type { WhisperManager } from '../whisper-manager'
import type { AudioConverter } from '../audio-converter'
import type { CalendarManager } from '../calendar-manager'
import { EventEmitter } from 'events'
import path from 'path'
import { classifyError } from '../error-classification'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/mock/home') },
  BrowserWindow: { getAllWindows: vi.fn(() => []) }
}))

vi.mock('os', () => ({
  tmpdir: vi.fn(() => '/mock/tmp'),
  availableParallelism: vi.fn(() => 20),
  cpus: vi.fn(() => new Array(20).fill({})),
  setPriority: vi.fn(),
  constants: {
    priority: {
      PRIORITY_BELOW_NORMAL: 10,
      PRIORITY_LOW: 19
    }
  }
}))

vi.mock('../autodoc-log', () => ({
  logAutodocEvent: vi.fn(),
  logAutodocFailure: vi.fn()
}))

vi.mock('fs/promises', () => ({
  readdir: vi.fn(),
  stat: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  unlink: vi.fn(),
  access: vi.fn()
}))

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execFile: vi.fn()
}))

const workerClientMock = vi.hoisted(() => ({
  isLoaded: false,
  load: vi.fn(),
  transcribe: vi.fn(),
  unload: vi.fn(),
  ping: vi.fn(),
  dispose: vi.fn(),
  lastOptions: null as Record<string, unknown> | null
}))

vi.mock('../transcription-worker-client', () => ({
  TranscriptionWorkerClient: vi.fn((options: Record<string, unknown>) => {
    workerClientMock.lastOptions = options
    return workerClientMock
  })
}))

vi.mock('../crypto', () => ({
  isEncrypted: vi.fn().mockResolvedValue(false),
  decryptJSON: vi.fn(),
  decryptFileToTemp: vi.fn(),
  encryptJSON: vi.fn(),
  encryptFileInPlace: vi.fn().mockResolvedValue(undefined)
}))

const fsMock = vi.mocked(await import('fs/promises'))
const childProcessMock = vi.mocked(await import('child_process'))
const osMock = vi.mocked(await import('os'))
const cryptoMock = vi.mocked(await import('../crypto'))
const autodocLogMock = vi.mocked(await import('../autodoc-log'))

class MockChildProcess extends EventEmitter {
  pid = 1234
  stderr = new EventEmitter()
  stdout = new EventEmitter()
}

function createMockWhisperManager(ready = true): WhisperManager {
  return {
    isReady: vi.fn().mockResolvedValue(ready),
    ensureReady: vi.fn().mockResolvedValue(undefined),
    getWhisperPath: vi.fn().mockReturnValue('/mock/whisper'),
    getFfmpegPath: vi.fn().mockReturnValue('/mock/ffmpeg'),
    getModelPath: vi.fn().mockReturnValue('/mock/model.bin'),
    getModelName: vi.fn().mockReturnValue('distil-large-v3'),
    getModelsDir: vi.fn().mockReturnValue('/mock/home/AutoDoc/models'),
    getTranscriptionBackend: vi.fn().mockReturnValue('whisper-cpp'),
    getTranscriptionBackendLabel: vi.fn().mockReturnValue('compatible transcription'),
    getDowngradesTaken: vi.fn().mockReturnValue([]),
    getMacProcessingProfile: vi.fn().mockReturnValue(null),
    isMlxWhisperSelected: vi.fn().mockReturnValue(false),
    isFasterWhisperSelected: vi.fn().mockReturnValue(false),
    isWorkerEngineSelected: vi.fn().mockReturnValue(false),
    getWorkerEngine: vi.fn().mockReturnValue('faster-whisper'),
    getWorkerPythonPath: vi.fn().mockReturnValue('/mock/python.exe'),
    getWorkerModelPath: vi.fn().mockReturnValue('/mock/faster-whisper-model'),
    getWorkerDevice: vi.fn().mockReturnValue('cpu'),
    getWorkerComputeType: vi.fn().mockReturnValue('int8'),
    getWorkerProcessEnv: vi.fn().mockReturnValue({ PATH: '/mock/path' }),
    getTranscriptionWorkerScriptPath: vi.fn().mockReturnValue('/mock/transcription-worker.py'),
    emit: vi.fn(),
    on: vi.fn()
  } as unknown as WhisperManager
}

function createMockAudioConverter(): AudioConverter {
  return {
    convert: vi.fn().mockResolvedValue(undefined),
    mergeAudio: vi.fn().mockResolvedValue(undefined),
    extractClip: vi.fn().mockResolvedValue(undefined),
    concatClips: vi.fn().mockResolvedValue(undefined),
    getDuration: vi.fn().mockResolvedValue(60)
  } as unknown as AudioConverter
}

function createMockCalendarManager(): CalendarManager {
  return {
    isConnected: vi.fn().mockReturnValue(false),
    fetchAllRecentEvents: vi.fn().mockResolvedValue([])
  } as unknown as CalendarManager
}

function createMockDiarizationService() {
  return {
    diarize: vi.fn()
  }
}

describe('TranscriptionService', () => {
  const originalPlatform = process.platform
  let service: TranscriptionService
  let mockWhisper: WhisperManager
  let mockConverter: AudioConverter
  let mockCalendar: CalendarManager

  const setPlatform = (platform: NodeJS.Platform) => {
    Object.defineProperty(process, 'platform', {
      value: platform,
      configurable: true
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    workerClientMock.isLoaded = false
    workerClientMock.lastOptions = null
    workerClientMock.load.mockImplementation(async () => {
      workerClientMock.isLoaded = true
    })
    workerClientMock.transcribe.mockResolvedValue({ transcription: [] })
    workerClientMock.unload.mockResolvedValue(undefined)
    workerClientMock.ping.mockResolvedValue(undefined)
    workerClientMock.dispose.mockImplementation(() => {
      workerClientMock.isLoaded = false
    })
    setPlatform(originalPlatform)
    fsMock.unlink.mockResolvedValue(undefined as any)
    fsMock.writeFile.mockResolvedValue(undefined as any)
    mockWhisper = createMockWhisperManager()
    mockConverter = createMockAudioConverter()
    mockCalendar = createMockCalendarManager()
    service = new TranscriptionService(
      mockWhisper,
      mockConverter,
      '/mock/home/AutoDoc/recordings',
      mockCalendar,
      () => false
    )
  })

  it('returns pending status for unknown meetingId when no files exist', async () => {
    fsMock.access.mockRejectedValue(new Error('ENOENT'))
    const status = await service.getStatus('unknown-id')
    expect(status).toBe('pending')
  })

  it('returns complete status when transcript.json exists', async () => {
    fsMock.access.mockImplementation(async (path) => {
      if (String(path).endsWith('transcript.json')) return undefined
      throw new Error('ENOENT')
    })
    const status = await service.getStatus('completed-meeting')
    expect(status).toBe('complete')
  })

  it('returns failed status when transcript.error exists', async () => {
    fsMock.access.mockImplementation(async (path) => {
      if (String(path).endsWith('transcript.error')) return undefined
      throw new Error('ENOENT')
    })
    const status = await service.getStatus('failed-meeting')
    expect(status).toBe('failed')
  })

  it('returns failed status when transcript.error is newer than transcript.json', async () => {
    fsMock.access.mockImplementation(async (path) => {
      if (String(path).endsWith('transcript.json') || String(path).endsWith('transcript.error'))
        return undefined
      throw new Error('ENOENT')
    })
    fsMock.stat.mockImplementation(
      async (path) =>
        ({
          isDirectory: () => false,
          mtimeMs: String(path).endsWith('transcript.error') ? 200 : 100
        }) as any
    )

    const status = await service.getStatus('reprocessed-meeting')
    expect(status).toBe('failed')
  })

  it('returns queued status after enqueue', async () => {
    vi.spyOn(service as any, 'processNext').mockResolvedValue(undefined)
    service.enqueue('meeting-123')

    fsMock.access.mockRejectedValue(new Error('ENOENT'))
    const status = await service.getStatus('meeting-123')
    expect(status).toBe('queued')
  })

  it('does not recover-scan an actively recording meeting', async () => {
    fsMock.readdir.mockResolvedValue(['meeting-active'] as any)
    fsMock.stat.mockResolvedValue({ isDirectory: () => true } as any)
    fsMock.access.mockImplementation(async (path) => {
      if (String(path).endsWith('mic.webm')) return undefined
      throw new Error('ENOENT')
    })

    service = new TranscriptionService(
      mockWhisper,
      mockConverter,
      '/mock/home/AutoDoc/recordings',
      mockCalendar,
      (meetingId) => meetingId === 'meeting-active'
    )

    const enqueueSpy = vi.spyOn(service, 'enqueue').mockImplementation(() => {})

    await service.scanAndEnqueuePending()

    expect(enqueueSpy).not.toHaveBeenCalled()
  })

  it('retry keeps the previous error marker until a new run succeeds', () => {
    vi.spyOn(service as any, 'processNext').mockResolvedValue(undefined)

    service.retry('meeting-123')

    expect(fsMock.unlink).not.toHaveBeenCalled()
  })

  it('does not throw when marking a deleted meeting as failed', async () => {
    fsMock.readFile.mockRejectedValue(new Error('ENOENT'))
    fsMock.writeFile.mockRejectedValue({ code: 'ENOENT' } as any)

    await expect(
      (service as any).markFailed('deleted-meeting', 'whisper.cpp timed out')
    ).resolves.toBeUndefined()
  })

  it('is idempotent - enqueuing same meetingId twice does not duplicate', () => {
    vi.spyOn(service as any, 'processNext').mockResolvedValue(undefined)

    service.enqueue('meeting-123')
    service.enqueue('meeting-123')

    const queue = (service as any).queue as string[]
    expect(queue.filter((id: string) => id === 'meeting-123')).toHaveLength(1)
  })

  it('getTranscript returns parsed transcript.json', async () => {
    const transcriptData = [
      {
        id: 'meeting-1-0',
        meetingId: 'meeting-1',
        speaker: 'Speaker',
        text: 'Hello',
        startMs: 0,
        endMs: 1000,
        confidence: -1
      }
    ]
    fsMock.readFile.mockResolvedValue(JSON.stringify(transcriptData) as any)

    const result = await service.getTranscript('meeting-1')
    expect(result).toEqual(transcriptData)
  })

  it('getTranscript returns empty array when file missing', async () => {
    fsMock.readFile.mockRejectedValue(new Error('ENOENT'))

    const result = await service.getTranscript('missing-meeting')
    expect(result).toEqual([])
  })

  it('recover-scan enqueues meetings with only system audio', async () => {
    fsMock.readdir.mockResolvedValue(['meeting-system-only'] as any)
    fsMock.stat.mockResolvedValue({ isDirectory: () => true } as any)
    fsMock.access.mockImplementation(async (path) => {
      if (String(path).endsWith('system.webm')) return undefined
      throw new Error('ENOENT')
    })

    const enqueueSpy = vi.spyOn(service, 'enqueue').mockImplementation(() => {})

    await service.scanAndEnqueuePending()

    expect(enqueueSpy).toHaveBeenCalledWith('meeting-system-only', 'recovery-scan')
  })

  it('transcribes from system audio when microphone capture is unavailable', async () => {
    fsMock.access.mockImplementation(async (path) => {
      if (String(path).endsWith('system.webm')) return undefined
      throw new Error('ENOENT')
    })
    ;(service as any).detectAudioActivity = vi.fn().mockResolvedValue([{ start: 0, end: 2 }])
    ;(service as any).transcribeWithFallback = vi.fn().mockResolvedValue({
      transcription: [{ offsets: { from: 0, to: 1000 }, text: 'Hello from speakers' }]
    })
    ;(service as any).mapToTranscripts = vi.fn().mockReturnValue([
      {
        id: 'meeting-system-only-0',
        meetingId: 'meeting-system-only',
        speaker: 'Speaker',
        text: 'Hello from speakers',
        startMs: 0,
        endMs: 1000,
        confidence: -1
      }
    ])

    await expect((service as any).processJob('meeting-system-only')).resolves.toBeUndefined()

    expect(mockConverter.convert).toHaveBeenCalledWith(
      path.join('/mock/home/AutoDoc/recordings', 'meeting-system-only', 'system.webm'),
      expect.stringContaining(path.join('/mock/tmp', 'autodoc-meeting-system-only-')),
      '/mock/ffmpeg'
    )
  })

  it('transcribes mic and system audio separately when both tracks exist', async () => {
    fsMock.access.mockImplementation(async (path) => {
      if (String(path).endsWith('mic.webm') || String(path).endsWith('system.webm'))
        return undefined
      throw new Error('ENOENT')
    })
    ;(service as any).detectAudioActivity = vi.fn().mockResolvedValue([{ start: 0, end: 2 }])
    ;(service as any).transcribeWithFallback = vi
      .fn()
      .mockResolvedValueOnce({
        transcription: [{ offsets: { from: 0, to: 1000 }, text: 'My microphone words' }]
      })
      .mockResolvedValueOnce({
        transcription: [{ offsets: { from: 500, to: 1500 }, text: 'Remote speaker words' }]
      })
    ;(service as any).mapToTranscripts = vi
      .fn()
      .mockReturnValueOnce([
        {
          id: 'meeting-dual-0',
          meetingId: 'meeting-dual',
          speaker: 'Speaker',
          text: 'My microphone words',
          startMs: 0,
          endMs: 1000,
          confidence: -1
        }
      ])
      .mockReturnValueOnce([
        {
          id: 'meeting-dual-1',
          meetingId: 'meeting-dual',
          speaker: 'Speaker',
          text: 'Remote speaker words',
          startMs: 500,
          endMs: 1500,
          confidence: -1
        }
      ])

    await expect((service as any).processJob('meeting-dual')).resolves.toBeUndefined()

    expect(mockConverter.convert).toHaveBeenCalledTimes(2)
    expect(mockConverter.mergeAudio).not.toHaveBeenCalled()
  })

  it('relabels remote system segments as speaker_1, speaker_2, etc. when diarization succeeds', async () => {
    const mockDiarization = createMockDiarizationService()
    mockDiarization.diarize.mockResolvedValue({
      speakers: [
        { id: 'SPEAKER_00', segments: [{ start: 0.4, end: 1.2 }] },
        { id: 'SPEAKER_01', segments: [{ start: 1.2, end: 2.4 }] }
      ]
    })

    service = new TranscriptionService(
      mockWhisper,
      mockConverter,
      '/mock/home/AutoDoc/recordings',
      mockCalendar,
      () => false,
      mockDiarization as any,
      () => true
    )

    fsMock.access.mockImplementation(async (path) => {
      if (String(path).endsWith('mic.webm') || String(path).endsWith('system.webm'))
        return undefined
      throw new Error('ENOENT')
    })
    ;(service as any).detectAudioActivity = vi.fn().mockResolvedValue([{ start: 0, end: 3 }])
    ;(service as any).transcribeWithFallback = vi
      .fn()
      .mockResolvedValueOnce({
        transcription: [{ offsets: { from: 0, to: 900 }, text: 'My microphone words' }]
      })
      .mockResolvedValueOnce({
        transcription: [
          { offsets: { from: 500, to: 1200 }, text: 'Remote speaker one' },
          { offsets: { from: 1200, to: 2200 }, text: 'Remote speaker two' }
        ]
      })
    ;(service as any).mapToTranscripts = vi
      .fn()
      .mockReturnValueOnce([
        {
          id: 'meeting-diarized-0',
          meetingId: 'meeting-diarized',
          speaker: 'Speaker',
          text: 'My microphone words',
          startMs: 0,
          endMs: 900,
          confidence: -1
        }
      ])
      .mockReturnValueOnce([
        {
          id: 'meeting-diarized-1',
          meetingId: 'meeting-diarized',
          speaker: 'Speaker',
          text: 'Remote speaker one',
          startMs: 500,
          endMs: 1200,
          confidence: -1
        },
        {
          id: 'meeting-diarized-2',
          meetingId: 'meeting-diarized',
          speaker: 'Speaker',
          text: 'Remote speaker two',
          startMs: 1200,
          endMs: 2200,
          confidence: -1
        }
      ])

    await expect((service as any).processJob('meeting-diarized')).resolves.toBeUndefined()

    const transcriptWrite = cryptoMock.encryptJSON.mock.calls.find(([, path]) =>
      String(path).endsWith('transcript.json')
    )
    const speakersWrite = cryptoMock.encryptJSON.mock.calls.find(([, path]) =>
      String(path).endsWith('speakers.json')
    )

    expect(mockDiarization.diarize).toHaveBeenCalledTimes(1)
    expect(transcriptWrite?.[0]).toEqual([
      expect.objectContaining({ speaker: 'me', text: 'My microphone words' }),
      expect.objectContaining({ speaker: 'speaker_1', text: 'Remote speaker one' }),
      expect.objectContaining({ speaker: 'speaker_2', text: 'Remote speaker two' })
    ])
    expect(speakersWrite?.[0]).toEqual({
      me: { label: 'Me' },
      speaker_1: { label: 'Speaker 1' },
      speaker_2: { label: 'Speaker 2' }
    })
  })

  it('keeps default Me and Them labels when experimental diarization is disabled', async () => {
    const mockDiarization = createMockDiarizationService()

    service = new TranscriptionService(
      mockWhisper,
      mockConverter,
      '/mock/home/AutoDoc/recordings',
      mockCalendar,
      () => false,
      mockDiarization as any,
      () => false
    )

    fsMock.access.mockImplementation(async (path) => {
      if (String(path).endsWith('mic.webm') || String(path).endsWith('system.webm'))
        return undefined
      throw new Error('ENOENT')
    })
    ;(service as any).detectAudioActivity = vi.fn().mockResolvedValue([{ start: 0, end: 3 }])
    ;(service as any).transcribeWithFallback = vi
      .fn()
      .mockResolvedValueOnce({
        transcription: [{ offsets: { from: 0, to: 900 }, text: 'My microphone words' }]
      })
      .mockResolvedValueOnce({
        transcription: [{ offsets: { from: 500, to: 1200 }, text: 'Remote speaker words' }]
      })
    ;(service as any).mapToTranscripts = vi
      .fn()
      .mockReturnValueOnce([
        {
          id: 'meeting-default-0',
          meetingId: 'meeting-default',
          speaker: 'Speaker',
          text: 'My microphone words',
          startMs: 0,
          endMs: 900,
          confidence: -1
        }
      ])
      .mockReturnValueOnce([
        {
          id: 'meeting-default-1',
          meetingId: 'meeting-default',
          speaker: 'Speaker',
          text: 'Remote speaker words',
          startMs: 500,
          endMs: 1200,
          confidence: -1
        }
      ])

    await expect((service as any).processJob('meeting-default')).resolves.toBeUndefined()

    const transcriptWrite = cryptoMock.encryptJSON.mock.calls.find(([, path]) =>
      String(path).endsWith('transcript.json')
    )
    const speakersWrite = cryptoMock.encryptJSON.mock.calls.find(([, path]) =>
      String(path).endsWith('speakers.json')
    )

    expect(mockDiarization.diarize).not.toHaveBeenCalled()
    expect(transcriptWrite?.[0]).toEqual([
      expect.objectContaining({ speaker: 'me', text: 'My microphone words' }),
      expect.objectContaining({ speaker: 'them', text: 'Remote speaker words' })
    ])
    expect(speakersWrite?.[0]).toEqual({
      me: { label: 'Me' },
      them: { label: 'Them' }
    })
  })

  it('compacts diarization audio to transcript windows and remaps speaker timings back to the original meeting', async () => {
    const mockDiarization = createMockDiarizationService()
    mockDiarization.diarize.mockResolvedValue({
      speakers: [
        { id: 'SPEAKER_00', segments: [{ start: 0.2, end: 4.2 }] },
        { id: 'SPEAKER_01', segments: [{ start: 4.2, end: 9.5 }] }
      ]
    })

    service = new TranscriptionService(
      mockWhisper,
      mockConverter,
      '/mock/home/AutoDoc/recordings',
      mockCalendar,
      () => false,
      mockDiarization as any,
      () => true
    )

    fsMock.access.mockImplementation(async (path) => {
      if (String(path).endsWith('system.webm')) return undefined
      throw new Error('ENOENT')
    })
    ;(mockConverter.getDuration as any).mockResolvedValue(900)
    ;(service as any).detectAudioActivity = vi.fn().mockResolvedValue([{ start: 0, end: 2 }])
    ;(service as any).transcribeWithFallback = vi.fn().mockResolvedValue({
      transcription: [
        { offsets: { from: 120000, to: 123000 }, text: 'First remote speaker' },
        { offsets: { from: 420000, to: 424000 }, text: 'Second remote speaker' }
      ]
    })
    ;(service as any).mapToTranscripts = vi.fn().mockReturnValue([
      {
        id: 'meeting-compact-0',
        meetingId: 'meeting-compact',
        speaker: 'Speaker',
        text: 'First remote speaker',
        startMs: 120000,
        endMs: 123000,
        confidence: -1
      },
      {
        id: 'meeting-compact-1',
        meetingId: 'meeting-compact',
        speaker: 'Speaker',
        text: 'Second remote speaker',
        startMs: 420000,
        endMs: 424000,
        confidence: -1
      }
    ])

    await expect((service as any).processJob('meeting-compact')).resolves.toBeUndefined()

    expect(mockConverter.extractClip).toHaveBeenCalledTimes(2)
    expect(mockConverter.concatClips).toHaveBeenCalledTimes(1)
    expect(mockDiarization.diarize).toHaveBeenCalledWith(expect.stringContaining('-compact.wav'))

    const transcriptWrite = cryptoMock.encryptJSON.mock.calls.find(([, path]) =>
      String(path).endsWith('transcript.json')
    )

    expect(transcriptWrite?.[0]).toEqual([
      expect.objectContaining({ speaker: 'speaker_1', text: 'First remote speaker' }),
      expect.objectContaining({ speaker: 'speaker_2', text: 'Second remote speaker' })
    ])
  })

  it('falls back to the existing speaker label when diarization fails', async () => {
    const mockDiarization = createMockDiarizationService()
    mockDiarization.diarize.mockRejectedValue(new Error('pyannote unavailable'))

    service = new TranscriptionService(
      mockWhisper,
      mockConverter,
      '/mock/home/AutoDoc/recordings',
      mockCalendar,
      () => false,
      mockDiarization as any,
      () => true
    )

    fsMock.access.mockImplementation(async (path) => {
      if (String(path).endsWith('system.webm')) return undefined
      throw new Error('ENOENT')
    })
    ;(service as any).detectAudioActivity = vi.fn().mockResolvedValue([{ start: 0, end: 2 }])
    ;(service as any).transcribeWithFallback = vi.fn().mockResolvedValue({
      transcription: [{ offsets: { from: 0, to: 1000 }, text: 'Hello from speakers' }]
    })
    ;(service as any).mapToTranscripts = vi.fn().mockReturnValue([
      {
        id: 'meeting-diarization-fallback-0',
        meetingId: 'meeting-diarization-fallback',
        speaker: 'Speaker',
        text: 'Hello from speakers',
        startMs: 0,
        endMs: 1000,
        confidence: -1
      }
    ])

    await expect(
      (service as any).processJob('meeting-diarization-fallback')
    ).resolves.toBeUndefined()

    const transcriptWrite = cryptoMock.encryptJSON.mock.calls.find(([, path]) =>
      String(path).endsWith('transcript.json')
    )
    const speakersWrite = cryptoMock.encryptJSON.mock.calls.find(([, path]) =>
      String(path).endsWith('speakers.json')
    )

    expect(mockDiarization.diarize).toHaveBeenCalledTimes(1)
    expect(transcriptWrite?.[0]).toEqual([
      expect.objectContaining({ speaker: 'them', text: 'Hello from speakers' })
    ])
    expect(speakersWrite?.[0]).toEqual({
      them: { label: 'Them' }
    })
  })

  it('collapses overlapping cross-speaker duplicates when dual-channel audio echoes the same utterance', () => {
    const merged = (service as any).mergeTranscriptStreams(
      'meeting-echo',
      [
        {
          id: 'me-1',
          meetingId: 'meeting-echo',
          speaker: 'me',
          text: 'Do we want to run this through QA?',
          startMs: 1200,
          endMs: 3400,
          confidence: -1
        }
      ],
      [
        {
          id: 'them-1',
          meetingId: 'meeting-echo',
          speaker: 'them',
          text: 'Do we want to run this through QA? I thought we had talked about that already.',
          startMs: 900,
          endMs: 4800,
          confidence: -1
        },
        {
          id: 'them-2',
          meetingId: 'meeting-echo',
          speaker: 'them',
          text: 'Let us make sure the release checklist is current.',
          startMs: 6000,
          endMs: 8600,
          confidence: -1
        }
      ]
    )

    expect(merged).toHaveLength(2)
    expect(merged[0].speaker).toBe('them')
    expect(merged[0].text).toContain('I thought we had talked about that already')
    expect(merged[1].text).toContain('release checklist')
  })

  it('suppresses mic echo when nearby system segments contain the same utterance with different chunking', () => {
    const filtered = (service as any).suppressAcousticEchoes(
      [
        {
          id: 'me-1',
          meetingId: 'meeting-echo-pass',
          speaker: 'me',
          text: 'Do we want to run this through QA? I thought we had talked about that already.',
          startMs: 7800,
          endMs: 11800,
          confidence: -1
        },
        {
          id: 'me-2',
          meetingId: 'meeting-echo-pass',
          speaker: 'me',
          text: 'I can take the release checklist after lunch.',
          startMs: 15000,
          endMs: 18500,
          confidence: -1
        }
      ],
      [
        {
          id: 'them-1',
          meetingId: 'meeting-echo-pass',
          speaker: 'them',
          text: 'Do we want to run this through QA?',
          startMs: 7600,
          endMs: 9100,
          confidence: -1
        },
        {
          id: 'them-2',
          meetingId: 'meeting-echo-pass',
          speaker: 'them',
          text: 'I thought we had talked about that already.',
          startMs: 9050,
          endMs: 11900,
          confidence: -1
        }
      ]
    )

    expect(filtered).toHaveLength(1)
    expect(filtered[0].text).toContain('release checklist')
  })

  it('preserves mic speech when nearby system text is on-topic but materially different', () => {
    const filtered = (service as any).suppressAcousticEchoes(
      [
        {
          id: 'me-1',
          meetingId: 'meeting-real-speech',
          speaker: 'me',
          text: 'I can own the Windows follow-up and send the email this afternoon.',
          startMs: 10000,
          endMs: 14200,
          confidence: -1
        }
      ],
      [
        {
          id: 'them-1',
          meetingId: 'meeting-real-speech',
          speaker: 'them',
          text: 'Can you send an update once the launch checklist is ready?',
          startMs: 9200,
          endMs: 12900,
          confidence: -1
        }
      ]
    )

    expect(filtered).toHaveLength(1)
    expect(filtered[0].speaker).toBe('me')
  })

  it('preserves distinct overlapping back-and-forth between speakers', () => {
    const merged = (service as any).mergeTranscriptStreams(
      'meeting-dialogue',
      [
        {
          id: 'me-1',
          meetingId: 'meeting-dialogue',
          speaker: 'me',
          text: 'Should we run a smoke test before launch?',
          startMs: 1000,
          endMs: 3200,
          confidence: -1
        }
      ],
      [
        {
          id: 'them-1',
          meetingId: 'meeting-dialogue',
          speaker: 'them',
          text: 'Yes, but I want QA involved as well.',
          startMs: 2600,
          endMs: 5100,
          confidence: -1
        }
      ]
    )

    expect(merged).toHaveLength(2)
    expect(merged.map((segment: any) => segment.speaker)).toEqual(['me', 'them'])
  })

  it('stitches adjacent same-speaker fragments into a more complete thought', () => {
    const stitched = (service as any).stitchAdjacentTranscriptFragments([
      {
        id: 'meeting-fragments-0',
        meetingId: 'meeting-fragments',
        speaker: 'them',
        text: 'I think the next step is',
        startMs: 1000,
        endMs: 2200,
        confidence: -1
      },
      {
        id: 'meeting-fragments-1',
        meetingId: 'meeting-fragments',
        speaker: 'them',
        text: 'to send the design review this afternoon',
        startMs: 2350,
        endMs: 4200,
        confidence: -1
      }
    ])

    expect(stitched).toHaveLength(1)
    expect(stitched[0].text).toBe(
      'I think the next step is to send the design review this afternoon'
    )
  })

  it('does not stitch clearly separate sentences that already end cleanly', () => {
    const stitched = (service as any).stitchAdjacentTranscriptFragments([
      {
        id: 'meeting-sentences-0',
        meetingId: 'meeting-sentences',
        speaker: 'them',
        text: 'I sent the update already.',
        startMs: 1000,
        endMs: 2200,
        confidence: -1
      },
      {
        id: 'meeting-sentences-1',
        meetingId: 'meeting-sentences',
        speaker: 'them',
        text: 'Can you take a look at the rollout plan?',
        startMs: 2350,
        endMs: 4300,
        confidence: -1
      }
    ])

    expect(stitched).toHaveLength(2)
  })

  it('chooses 10 whisper threads on a 20-thread machine', () => {
    setPlatform('win32')
    osMock.availableParallelism.mockReturnValue(20)

    expect((service as any).getWhisperThreadCount()).toBe(10)
  })

  it('chooses 2 whisper threads on a 4-core machine', () => {
    setPlatform('win32')
    osMock.availableParallelism.mockReturnValue(4)

    expect((service as any).getWhisperThreadCount()).toBe(2)
  })

  it('chooses 2 whisper threads on an 8-core machine', () => {
    setPlatform('win32')
    osMock.availableParallelism.mockReturnValue(8)

    expect((service as any).getWhisperThreadCount()).toBe(2)
  })

  it('splits whisper threads across concurrent Windows sources', () => {
    setPlatform('win32')
    osMock.availableParallelism.mockReturnValue(20)

    expect((service as any).getWhisperThreadCount(2)).toBe(7)
  })

  it('uses 5 whisper threads per source on a 16-core machine with 2 sources', () => {
    setPlatform('win32')
    osMock.availableParallelism.mockReturnValue(16)

    expect((service as any).getWhisperThreadCount(2)).toBe(5)
  })

  it('uses 4 whisper threads on a 4-core machine in fast mode', () => {
    setPlatform('win32')
    osMock.availableParallelism.mockReturnValue(4)
    service = new TranscriptionService(
      mockWhisper,
      mockConverter,
      '/mock/home/AutoDoc/recordings',
      mockCalendar,
      () => false,
      null,
      () => false,
      null,
      () => 'fast'
    )

    expect((service as any).getWhisperThreadCount()).toBe(4)
  })

  it('passes --no-eco to the transcription worker in fast mode', async () => {
    setPlatform('win32')
    mockWhisper = {
      ...mockWhisper,
      isWorkerEngineSelected: vi.fn().mockReturnValue(true),
      isFasterWhisperSelected: vi.fn().mockReturnValue(true),
      getTranscriptionWorkerScriptPath: vi.fn().mockReturnValue('/mock/transcription-worker.py'),
      getWorkerModelPath: vi.fn().mockReturnValue('/mock/faster-whisper-model'),
      getWorkerPythonPath: vi.fn().mockReturnValue('/mock/python.exe'),
      getWorkerDevice: vi.fn().mockReturnValue('cpu'),
      getWorkerComputeType: vi.fn().mockReturnValue('int8'),
      getWorkerProcessEnv: vi.fn().mockReturnValue({ PATH: '/mock/path' }),
      getWorkerEngine: vi.fn().mockReturnValue('faster-whisper'),
      getTranscriptionBackend: vi.fn().mockReturnValue('faster-whisper-cpu'),
      getSelectedWindowsProfileEstimatedMemoryGiB: vi.fn().mockReturnValue(1.5)
    } as unknown as WhisperManager
    service = new TranscriptionService(
      mockWhisper,
      mockConverter,
      '/mock/home/AutoDoc/recordings',
      mockCalendar,
      () => false,
      null,
      () => false,
      null,
      () => 'fast',
      () => 'balanced',
      async () => null,
      async () => undefined,
      () => ({ freeGiB: 16, totalGiB: 32 })
    )

    await expect(
      (service as any).runWhisperPass('/mock/tmp/audio.wav', 'meeting-123', 60)
    ).resolves.toBeUndefined()

    expect(workerClientMock.lastOptions?.extraArgs).toEqual(['--no-eco'])
    expect(workerClientMock.load).toHaveBeenCalled()
    expect(workerClientMock.transcribe).toHaveBeenCalled()
    expect(fsMock.writeFile).toHaveBeenCalledWith(
      '/mock/tmp/audio.wav.json',
      JSON.stringify({ transcription: [] }),
      'utf-8'
    )
  })

  it('does not pass --no-eco to the transcription worker in balanced mode', async () => {
    setPlatform('win32')
    mockWhisper = {
      ...mockWhisper,
      isWorkerEngineSelected: vi.fn().mockReturnValue(true),
      isFasterWhisperSelected: vi.fn().mockReturnValue(true),
      getTranscriptionWorkerScriptPath: vi.fn().mockReturnValue('/mock/transcription-worker.py'),
      getWorkerModelPath: vi.fn().mockReturnValue('/mock/faster-whisper-model'),
      getWorkerPythonPath: vi.fn().mockReturnValue('/mock/python.exe'),
      getWorkerDevice: vi.fn().mockReturnValue('cpu'),
      getWorkerComputeType: vi.fn().mockReturnValue('int8'),
      getWorkerProcessEnv: vi.fn().mockReturnValue({ PATH: '/mock/path' }),
      getWorkerEngine: vi.fn().mockReturnValue('faster-whisper'),
      getTranscriptionBackend: vi.fn().mockReturnValue('faster-whisper-cpu'),
      getSelectedWindowsProfileEstimatedMemoryGiB: vi.fn().mockReturnValue(1.5)
    } as unknown as WhisperManager
    service = new TranscriptionService(
      mockWhisper,
      mockConverter,
      '/mock/home/AutoDoc/recordings',
      mockCalendar,
      () => false,
      null,
      () => false,
      null,
      () => 'balanced',
      () => 'balanced',
      async () => null,
      async () => undefined,
      () => ({ freeGiB: 16, totalGiB: 32 })
    )

    await expect(
      (service as any).runWhisperPass('/mock/tmp/audio.wav', 'meeting-123', 60)
    ).resolves.toBeUndefined()

    expect(workerClientMock.lastOptions?.extraArgs).toEqual([])
  })

  it('disables EcoQoS and uses below-normal priority for the DML worker even in balanced mode', async () => {
    setPlatform('win32')
    mockWhisper = {
      ...mockWhisper,
      isWorkerEngineSelected: vi.fn().mockReturnValue(true),
      isFasterWhisperSelected: vi.fn().mockReturnValue(false),
      getTranscriptionWorkerScriptPath: vi.fn().mockReturnValue('/mock/transcription-worker.py'),
      getWorkerModelPath: vi.fn().mockReturnValue('/mock/parakeet-model'),
      getWorkerPythonPath: vi.fn().mockReturnValue('/mock/python.exe'),
      getWorkerDevice: vi.fn().mockReturnValue('dml'),
      getWorkerComputeType: vi.fn().mockReturnValue('fp32'),
      getWorkerProcessEnv: vi.fn().mockReturnValue({ PATH: '/mock/path' }),
      getWorkerEngine: vi.fn().mockReturnValue('parakeet'),
      getTranscriptionBackend: vi.fn().mockReturnValue('parakeet-gpu'),
      getSelectedWindowsProfileEstimatedMemoryGiB: vi.fn().mockReturnValue(4)
    } as unknown as WhisperManager
    service = new TranscriptionService(
      mockWhisper,
      mockConverter,
      '/mock/home/AutoDoc/recordings',
      mockCalendar,
      () => false,
      null,
      () => false,
      null,
      () => 'balanced',
      () => 'balanced',
      async () => null,
      async () => undefined,
      () => ({ freeGiB: 16, totalGiB: 32 })
    )

    await expect(
      (service as any).runWhisperPass('/mock/tmp/audio.wav', 'meeting-123', 60)
    ).resolves.toBeUndefined()

    expect(workerClientMock.lastOptions?.extraArgs).toEqual(['--no-eco'])
    ;(service as any).lowerWhisperPriority(1234, 'meeting-123')
    expect(osMock.setPriority).toHaveBeenCalledWith(1234, 10)
  })

  it('uses idle priority in balanced mode and below-normal in fast mode', async () => {
    setPlatform('win32')
    mockWhisper = {
      ...mockWhisper,
      getSelectedWindowsProfileEstimatedMemoryGiB: vi.fn().mockReturnValue(null)
    } as unknown as WhisperManager
    service = new TranscriptionService(
      mockWhisper,
      mockConverter,
      '/mock/home/AutoDoc/recordings',
      mockCalendar,
      () => false
    )
    const child = new MockChildProcess()
    childProcessMock.spawn.mockReturnValue(child as any)

    const balancedPromise = (service as any).runWhisperPass(
      '/mock/tmp/audio.wav',
      'meeting-balanced',
      60
    )
    child.emit('close', 0)
    await balancedPromise
    expect(osMock.setPriority).toHaveBeenCalledWith(1234, 19)

    osMock.setPriority.mockClear()
    service = new TranscriptionService(
      mockWhisper,
      mockConverter,
      '/mock/home/AutoDoc/recordings',
      mockCalendar,
      () => false,
      null,
      () => false,
      null,
      () => 'fast'
    )
    childProcessMock.spawn.mockReturnValue(child as any)

    const fastPromise = (service as any).runWhisperPass('/mock/tmp/audio.wav', 'meeting-fast', 60)
    child.emit('close', 0)
    await fastPromise
    expect(osMock.setPriority).toHaveBeenCalledWith(1234, 10)
  })

  it('waits for free memory before whisper pass then proceeds when memory frees', async () => {
    setPlatform('win32')
    vi.useFakeTimers()
    let freeGiB = 2
    mockWhisper = {
      ...mockWhisper,
      getSelectedWindowsProfileEstimatedMemoryGiB: vi.fn().mockReturnValue(2.5)
    } as unknown as WhisperManager
    service = new TranscriptionService(
      mockWhisper,
      mockConverter,
      '/mock/home/AutoDoc/recordings',
      mockCalendar,
      () => false,
      null,
      () => false,
      null,
      () => 'balanced',
      () => 'balanced',
      async () => null,
      async (ms) => {
        freeGiB = 16
        await vi.advanceTimersByTimeAsync(ms)
      },
      () => ({ freeGiB, totalGiB: 32 })
    )
    const child = new MockChildProcess()
    childProcessMock.spawn.mockReturnValue(child as any)
    fsMock.readFile.mockResolvedValue(JSON.stringify({ transcription: [] }) as any)

    const promise = (service as any).runWhisperPassAndRead(
      '/mock/tmp/audio.wav',
      'meeting-memory',
      60,
      []
    )
    await vi.runAllTimersAsync()
    child.emit('close', 0)
    await promise

    expect(autodocLogMock.logAutodocEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        area: 'transcription',
        message: 'Waiting for free memory before starting transcription pass',
        meetingId: 'meeting-memory'
      })
    )
    expect(childProcessMock.spawn).toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('proceeds after memory wait timeout when memory never frees', async () => {
    setPlatform('win32')
    vi.useFakeTimers()
    mockWhisper = {
      ...mockWhisper,
      getSelectedWindowsProfileEstimatedMemoryGiB: vi.fn().mockReturnValue(2.5)
    } as unknown as WhisperManager
    service = new TranscriptionService(
      mockWhisper,
      mockConverter,
      '/mock/home/AutoDoc/recordings',
      mockCalendar,
      () => false,
      null,
      () => false,
      null,
      () => 'balanced',
      () => 'balanced',
      async () => null,
      async (ms) => {
        await vi.advanceTimersByTimeAsync(ms)
      },
      () => ({ freeGiB: 2, totalGiB: 32 })
    )
    const child = new MockChildProcess()
    childProcessMock.spawn.mockReturnValue(child as any)
    fsMock.readFile.mockResolvedValue(JSON.stringify({ transcription: [] }) as any)

    const promise = (service as any).runWhisperPassAndRead(
      '/mock/tmp/audio.wav',
      'meeting-timeout',
      60,
      []
    )
    for (let i = 0; i < 13; i += 1) {
      await vi.advanceTimersByTimeAsync(5000)
    }
    child.emit('close', 0)
    await promise

    expect(autodocLogMock.logAutodocEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        area: 'transcription',
        message: 'Proceeding with transcription pass after memory wait timeout',
        meetingId: 'meeting-timeout'
      })
    )
    expect(childProcessMock.spawn).toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('skips the Windows memory gate on macOS', async () => {
    setPlatform('darwin')
    mockWhisper = {
      ...mockWhisper,
      getSelectedWindowsProfileEstimatedMemoryGiB: vi.fn().mockReturnValue(2.5)
    } as unknown as WhisperManager
    service = new TranscriptionService(
      mockWhisper,
      mockConverter,
      '/mock/home/AutoDoc/recordings',
      mockCalendar,
      () => false,
      null,
      () => false,
      null,
      () => 'balanced',
      () => 'balanced',
      async () => null,
      async () => {
        throw new Error('memory gate delay should not run on macOS')
      },
      () => ({ freeGiB: 2, totalGiB: 32 })
    )
    const child = new MockChildProcess()
    childProcessMock.spawn.mockReturnValue(child as any)
    fsMock.readFile.mockResolvedValue(JSON.stringify({ transcription: [] }) as any)

    const promise = (service as any).runWhisperPassAndRead(
      '/mock/tmp/audio.wav',
      'meeting-macos',
      60,
      []
    )
    child.emit('close', 0)
    await expect(promise).resolves.toEqual({ transcription: [] })
  })

  it('passes the computed thread count to whisper-cli', async () => {
    setPlatform('win32')
    osMock.availableParallelism.mockReturnValue(20)
    const child = new MockChildProcess()
    childProcessMock.spawn.mockReturnValue(child as any)

    const promise = (service as any).runWhisperPass('/mock/tmp/audio.wav', 'meeting-123', 60)
    child.emit('close', 0)

    await expect(promise).resolves.toBeUndefined()
    expect(childProcessMock.spawn).toHaveBeenCalledWith(
      '/mock/whisper',
      expect.arrayContaining(['-t', '10'])
    )
    expect(osMock.setPriority).toHaveBeenCalledWith(1234, 19)
  })

  it('passes short-segmentation flags when requested', async () => {
    const child = new MockChildProcess()
    childProcessMock.spawn.mockReturnValue(child as any)

    const promise = (service as any).runWhisperPass(
      '/mock/tmp/audio.wav',
      'meeting-123',
      60,
      undefined,
      ['-ml', '50', '-sow']
    )
    child.emit('close', 0)

    await expect(promise).resolves.toBeUndefined()
    expect(childProcessMock.spawn).toHaveBeenCalledWith(
      '/mock/whisper',
      expect.arrayContaining(['-ml', '50', '-sow'])
    )
  })

  it('maps transcription worker failures to faster-whisper exit errors', async () => {
    setPlatform('win32')
    mockWhisper = {
      ...mockWhisper,
      isWorkerEngineSelected: vi.fn().mockReturnValue(true),
      isFasterWhisperSelected: vi.fn().mockReturnValue(true),
      getTranscriptionWorkerScriptPath: vi.fn().mockReturnValue('/mock/transcription-worker.py'),
      getWorkerModelPath: vi.fn().mockReturnValue('/mock/faster-whisper-model'),
      getWorkerPythonPath: vi.fn().mockReturnValue('/mock/python.exe'),
      getWorkerDevice: vi.fn().mockReturnValue('cuda'),
      getWorkerComputeType: vi.fn().mockReturnValue('int8_float32'),
      getWorkerProcessEnv: vi.fn().mockReturnValue({ PATH: '/mock/path' }),
      getWorkerEngine: vi.fn().mockReturnValue('faster-whisper'),
      getTranscriptionBackend: vi.fn().mockReturnValue('faster-whisper-cuda')
    } as unknown as WhisperManager
    service = new TranscriptionService(
      mockWhisper,
      mockConverter,
      '/mock/home/AutoDoc/recordings',
      mockCalendar,
      () => false
    )
    workerClientMock.transcribe.mockRejectedValueOnce(
      new Error('Transcription worker crashed repeatedly: native crash')
    )

    await expect(
      (service as any).runWhisperPass('/mock/tmp/audio.wav', 'meeting-123', 60)
    ).rejects.toThrow(/faster-whisper exited with code 1/)
  })

  it('classifies Metal aborts as whisper-metal-crash', () => {
    expect(
      classifyError('whisper.cpp exited with code null (signal SIGABRT): ggml_metal_rsets_free')
    ).toBe('whisper-metal-crash')
  })

  it('classifies Ollama runner stops with resource-limit hints as insufficient memory', () => {
    expect(
      classifyError(
        'Ollama returned 500: {"error":"model runner has unexpectedly stopped, this may be due to resource limitations or an internal error"}'
      )
    ).toBe('ollama-insufficient-memory')
  })

  it('retries whisper on CPU after a macOS Metal abort', async () => {
    setPlatform('darwin')
    const first = new MockChildProcess()
    const second = new MockChildProcess()
    childProcessMock.spawn.mockReturnValueOnce(first as any).mockReturnValueOnce(second as any)

    const promise = (service as any).runWhisperPass('/mock/tmp/audio.wav', 'meeting-123', 60)

    first.stderr.emit('data', Buffer.from('ggml_metal_rsets_free\n'))
    first.emit('close', null, 'SIGABRT')
    await vi.waitFor(() => {
      expect(childProcessMock.spawn).toHaveBeenCalledTimes(2)
    })
    second.emit('close', 0)

    await expect(promise).resolves.toBeUndefined()
    expect(childProcessMock.spawn).toHaveBeenNthCalledWith(
      1,
      '/mock/whisper',
      expect.not.arrayContaining(['--no-gpu'])
    )
    expect(childProcessMock.spawn).toHaveBeenNthCalledWith(
      2,
      '/mock/whisper',
      expect.arrayContaining(['--no-gpu'])
    )
  })

  it('detects suspicious repetition loops', () => {
    const transcripts = Array.from({ length: 30 }, (_, index) => ({
      id: `meeting-1-${index}`,
      meetingId: 'meeting-1',
      speaker: 'Speaker',
      text: [
        'Yeah.',
        "So what your concern is, is that we're unfairly penalizing 4.x when the event applies to",
        'both 4.x?'
      ][index % 3],
      startMs: index * 1000,
      endMs: (index + 1) * 1000,
      confidence: -1
    }))

    expect((service as any).hasSuspiciousRepetition(transcripts)).toBe(true)
  })

  it('does not flag normal transcript diversity as repetition', () => {
    const transcripts = Array.from({ length: 30 }, (_, index) => ({
      id: `meeting-1-${index}`,
      meetingId: 'meeting-1',
      speaker: 'Speaker',
      text: `Unique segment ${index}`,
      startMs: index * 1000,
      endMs: (index + 1) * 1000,
      confidence: -1
    }))

    expect((service as any).hasSuspiciousRepetition(transcripts)).toBe(false)
  })

  it('uses chunked transcription for long recordings', async () => {
    const chunkedOutput = { transcription: [{ offsets: { from: 0, to: 1000 }, text: 'chunked' }] }
    const chunkedSpy = vi
      .spyOn(service as any, 'runWhisperChunked')
      .mockResolvedValue(chunkedOutput)
    const singlePassSpy = vi.spyOn(service as any, 'runWhisperPassAndRead')

    const result = await (service as any).transcribeWithFallback(
      '/mock/tmp/audio.wav',
      'meeting-123',
      1300,
      '/mock/tmp/audio',
      []
    )

    expect(result).toEqual(chunkedOutput)
    expect(chunkedSpy).toHaveBeenCalled()
    expect(singlePassSpy).not.toHaveBeenCalled()
  })

  it('tries a single CUDA faster-whisper pass before chunking long Windows recordings', async () => {
    setPlatform('win32')
    mockWhisper = {
      ...mockWhisper,
      isWorkerEngineSelected: vi.fn().mockReturnValue(true),
      isFasterWhisperSelected: vi.fn().mockReturnValue(true),
      getWorkerDevice: vi.fn().mockReturnValue('cuda')
    } as unknown as WhisperManager
    service = new TranscriptionService(
      mockWhisper,
      mockConverter,
      '/mock/home/AutoDoc/recordings',
      mockCalendar,
      () => false
    )

    const singlePassOutput = {
      transcription: [{ offsets: { from: 0, to: 1000 }, text: 'single pass' }]
    }
    const chunkedSpy = vi.spyOn(service as any, 'runWhisperChunked')
    const singlePassSpy = vi
      .spyOn(service as any, 'runWhisperPassAndRead')
      .mockResolvedValue(singlePassOutput)

    const result = await (service as any).transcribeWithFallback(
      '/mock/tmp/audio.wav',
      'meeting-cuda',
      30 * 60,
      '/mock/tmp/audio',
      []
    )

    expect(result).toEqual(singlePassOutput)
    expect(singlePassSpy).toHaveBeenCalled()
    expect(chunkedSpy).not.toHaveBeenCalled()
  })

  it('uses a single whole-file pass for long recordings on parakeet (any device)', async () => {
    setPlatform('win32')
    mockWhisper = {
      ...mockWhisper,
      isWorkerEngineSelected: vi.fn().mockReturnValue(true),
      isFasterWhisperSelected: vi.fn().mockReturnValue(false),
      getWorkerEngine: vi.fn().mockReturnValue('parakeet'),
      getWorkerDevice: vi.fn().mockReturnValue('cpu')
    } as unknown as WhisperManager
    service = new TranscriptionService(
      mockWhisper,
      mockConverter,
      '/mock/home/AutoDoc/recordings',
      mockCalendar,
      () => false
    )

    const singlePassOutput = {
      transcription: [{ offsets: { from: 0, to: 1000 }, text: 'parakeet single pass' }]
    }
    const chunkedSpy = vi.spyOn(service as any, 'runWhisperChunked')
    const singlePassSpy = vi
      .spyOn(service as any, 'runWhisperPassAndRead')
      .mockResolvedValue(singlePassOutput)

    const result = await (service as any).transcribeWithFallback(
      '/mock/tmp/audio.wav',
      'meeting-parakeet',
      60 * 60,
      '/mock/tmp/audio',
      []
    )

    expect(result).toEqual(singlePassOutput)
    expect(singlePassSpy).toHaveBeenCalled()
    expect(chunkedSpy).not.toHaveBeenCalled()
  })

  it('keeps transcription progress monotonic when concurrent sources report out of order', () => {
    ;(service as any).activeJobId = 'meeting-123'
    ;(service as any).broadcastStatus('meeting-123', 'transcribing', 50)
    ;(service as any).broadcastStatus('meeting-123', 'transcribing', 3)
    ;(service as any).broadcastStatus('meeting-123', 'transcribing', 57)

    expect(service.getProgress('meeting-123')).toBe(57)
  })

  it('runs acoustic echo suppression before merging dual-channel transcripts', async () => {
    fsMock.access.mockImplementation(async (path) => {
      if (String(path).endsWith('mic.webm') || String(path).endsWith('system.webm'))
        return undefined
      throw new Error('ENOENT')
    })
    ;(service as any).detectAudioActivity = vi.fn().mockResolvedValue([{ start: 0, end: 2 }])
    ;(service as any).transcribeWithFallback = vi
      .fn()
      .mockResolvedValueOnce({
        transcription: [{ offsets: { from: 0, to: 1000 }, text: 'echoed sentence' }]
      })
      .mockResolvedValueOnce({
        transcription: [{ offsets: { from: 0, to: 1000 }, text: 'echoed sentence' }]
      })
    ;(service as any).mapToTranscripts = vi
      .fn()
      .mockReturnValueOnce([
        {
          id: 'meeting-dual-echo-0',
          meetingId: 'meeting-dual-echo',
          speaker: 'Speaker',
          text: 'echoed sentence',
          startMs: 1000,
          endMs: 3000,
          confidence: -1
        }
      ])
      .mockReturnValueOnce([
        {
          id: 'meeting-dual-echo-1',
          meetingId: 'meeting-dual-echo',
          speaker: 'Speaker',
          text: 'echoed sentence',
          startMs: 1000,
          endMs: 3000,
          confidence: -1
        }
      ])

    const suppressSpy = vi.spyOn(service as any, 'suppressAcousticEchoes')
    const mergeSpy = vi.spyOn(service as any, 'mergeTranscriptStreams')

    await expect((service as any).processJob('meeting-dual-echo')).resolves.toBeUndefined()

    expect(suppressSpy).toHaveBeenCalledTimes(1)
    expect(mergeSpy).toHaveBeenCalledWith(
      'meeting-dual-echo',
      suppressSpy.mock.results[0]?.value,
      expect.any(Array)
    )
  })

  it('uses sequential dual-source transcription on low-spec Apple Silicon Macs', async () => {
    setPlatform('darwin')
    ;(mockWhisper as any).isMlxWhisperSelected = vi.fn().mockReturnValue(true)
    ;(mockWhisper as any).getMacProcessingProfile = vi.fn().mockReturnValue({
      id: 'mac-low-spec',
      reason: 'totalMemoryGiB <= 8.5',
      hardware: {
        platform: 'darwin',
        arch: 'arm64',
        isAppleSilicon: true,
        chip: 'Apple M1',
        logicalProcessors: 8,
        totalMemoryGiB: 8,
        freeMemoryGiB: 2.5,
        memoryPressure: 'green',
        swapUsedGiB: 0
      },
      transcriptionBackend: 'mlx-whisper',
      transcriptionModel: 'distil-large-v3',
      notesModel: 'llama3.2:3b',
      dualSourceMode: 'sequential',
      notesAfterTranscriptionOnly: true,
      serializeLocalProcessing: true
    })
    fsMock.access.mockImplementation(async (path) => {
      if (String(path).endsWith('mic.webm') || String(path).endsWith('system.webm')) {
        return undefined
      }
      throw new Error('ENOENT')
    })
    ;(service as any).detectAudioActivity = vi.fn().mockResolvedValue([{ start: 0, end: 2 }])
    const order: string[] = []
    ;(service as any).transcribeWithFallback = vi.fn(async (_wav: string, _meeting: string) => {
      order.push(order.length === 0 ? 'first-complete' : 'second-complete')
      return { transcription: [{ offsets: { from: 0, to: 1000 }, text: 'words' }] }
    })
    ;(service as any).mapToTranscripts = vi.fn().mockReturnValue([
      {
        id: 'meeting-low-spec-0',
        meetingId: 'meeting-low-spec',
        speaker: 'Speaker',
        text: 'words',
        startMs: 0,
        endMs: 1000,
        confidence: -1
      }
    ])

    await expect((service as any).processJob('meeting-low-spec')).resolves.toBeUndefined()

    expect((service as any).transcribeWithFallback).toHaveBeenCalledTimes(2)
    expect(order).toEqual(['first-complete', 'second-complete'])
  })
})
