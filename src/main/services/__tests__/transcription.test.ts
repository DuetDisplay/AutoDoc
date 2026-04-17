import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TranscriptionService } from '../transcription'
import type { WhisperManager } from '../whisper-manager'
import type { AudioConverter } from '../audio-converter'
import type { CalendarManager } from '../calendar-manager'
import { EventEmitter } from 'events'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/mock/home') },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}))

vi.mock('os', () => ({
  tmpdir: vi.fn(() => '/mock/tmp'),
  availableParallelism: vi.fn(() => 20),
  cpus: vi.fn(() => new Array(20).fill({})),
  setPriority: vi.fn(),
  constants: {
    priority: {
      PRIORITY_BELOW_NORMAL: 10,
    },
  },
}))

vi.mock('fs/promises', () => ({
  readdir: vi.fn(),
  stat: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  unlink: vi.fn(),
  access: vi.fn(),
}))

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}))

vi.mock('../crypto', () => ({
  isEncrypted: vi.fn().mockResolvedValue(false),
  decryptJSON: vi.fn(),
  decryptFileToTemp: vi.fn(),
  encryptJSON: vi.fn(),
  encryptFileInPlace: vi.fn().mockResolvedValue(undefined),
}))

const fsMock = vi.mocked(await import('fs/promises'))
const childProcessMock = vi.mocked(await import('child_process'))
const osMock = vi.mocked(await import('os'))
const cryptoMock = vi.mocked(await import('../crypto'))

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
    getModelsDir: vi.fn().mockReturnValue('/mock/home/AutoDoc/models'),
    emit: vi.fn(),
    on: vi.fn(),
  } as unknown as WhisperManager
}

function createMockAudioConverter(): AudioConverter {
  return {
    convert: vi.fn().mockResolvedValue(undefined),
    mergeAudio: vi.fn().mockResolvedValue(undefined),
    extractClip: vi.fn().mockResolvedValue(undefined),
    getDuration: vi.fn().mockResolvedValue(60),
  } as unknown as AudioConverter
}

function createMockCalendarManager(): CalendarManager {
  return {
    isConnected: vi.fn().mockReturnValue(false),
    fetchAllRecentEvents: vi.fn().mockResolvedValue([]),
  } as unknown as CalendarManager
}

function createMockDiarizationService() {
  return {
    diarize: vi.fn(),
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
      configurable: true,
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    setPlatform(originalPlatform)
    fsMock.unlink.mockResolvedValue(undefined as any)
    mockWhisper = createMockWhisperManager()
    mockConverter = createMockAudioConverter()
    mockCalendar = createMockCalendarManager()
    service = new TranscriptionService(
      mockWhisper,
      mockConverter,
      '/mock/home/AutoDoc/recordings',
      mockCalendar,
      () => false,
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
      if (String(path).endsWith('transcript.json') || String(path).endsWith('transcript.error')) return undefined
      throw new Error('ENOENT')
    })
    fsMock.stat.mockImplementation(async (path) => ({
      isDirectory: () => false,
      mtimeMs: String(path).endsWith('transcript.error') ? 200 : 100,
    }) as any)

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
      (meetingId) => meetingId === 'meeting-active',
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

    await expect((service as any).markFailed('deleted-meeting', 'whisper.cpp timed out')).resolves.toBeUndefined()
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
      { id: 'meeting-1-0', meetingId: 'meeting-1', speaker: 'Speaker', text: 'Hello', startMs: 0, endMs: 1000, confidence: -1 }
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
      transcription: [{ offsets: { from: 0, to: 1000 }, text: 'Hello from speakers' }],
    })
    ;(service as any).mapToTranscripts = vi.fn().mockReturnValue([
      {
        id: 'meeting-system-only-0',
        meetingId: 'meeting-system-only',
        speaker: 'Speaker',
        text: 'Hello from speakers',
        startMs: 0,
        endMs: 1000,
        confidence: -1,
      },
    ])

    await expect((service as any).processJob('meeting-system-only')).resolves.toBeUndefined()

    expect(mockConverter.convert).toHaveBeenCalledWith(
      '/mock/home/AutoDoc/recordings/meeting-system-only/system.webm',
      expect.stringContaining('/mock/tmp/autodoc-meeting-system-only-'),
      '/mock/ffmpeg',
    )
  })

  it('transcribes mic and system audio separately when both tracks exist', async () => {
    fsMock.access.mockImplementation(async (path) => {
      if (String(path).endsWith('mic.webm') || String(path).endsWith('system.webm')) return undefined
      throw new Error('ENOENT')
    })
    ;(service as any).detectAudioActivity = vi.fn().mockResolvedValue([{ start: 0, end: 2 }])
    ;(service as any).transcribeWithFallback = vi
      .fn()
      .mockResolvedValueOnce({
        transcription: [{ offsets: { from: 0, to: 1000 }, text: 'My microphone words' }],
      })
      .mockResolvedValueOnce({
        transcription: [{ offsets: { from: 500, to: 1500 }, text: 'Remote speaker words' }],
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
          confidence: -1,
        },
      ])
      .mockReturnValueOnce([
        {
          id: 'meeting-dual-1',
          meetingId: 'meeting-dual',
          speaker: 'Speaker',
          text: 'Remote speaker words',
          startMs: 500,
          endMs: 1500,
          confidence: -1,
        },
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
        { id: 'SPEAKER_01', segments: [{ start: 1.2, end: 2.4 }] },
      ],
    })

    service = new TranscriptionService(
      mockWhisper,
      mockConverter,
      '/mock/home/AutoDoc/recordings',
      mockCalendar,
      () => false,
      mockDiarization as any,
    )

    fsMock.access.mockImplementation(async (path) => {
      if (String(path).endsWith('mic.webm') || String(path).endsWith('system.webm')) return undefined
      throw new Error('ENOENT')
    })
    ;(service as any).detectAudioActivity = vi.fn().mockResolvedValue([{ start: 0, end: 3 }])
    ;(service as any).transcribeWithFallback = vi
      .fn()
      .mockResolvedValueOnce({
        transcription: [{ offsets: { from: 0, to: 900 }, text: 'My microphone words' }],
      })
      .mockResolvedValueOnce({
        transcription: [
          { offsets: { from: 500, to: 1200 }, text: 'Remote speaker one' },
          { offsets: { from: 1200, to: 2200 }, text: 'Remote speaker two' },
        ],
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
          confidence: -1,
        },
      ])
      .mockReturnValueOnce([
        {
          id: 'meeting-diarized-1',
          meetingId: 'meeting-diarized',
          speaker: 'Speaker',
          text: 'Remote speaker one',
          startMs: 500,
          endMs: 1200,
          confidence: -1,
        },
        {
          id: 'meeting-diarized-2',
          meetingId: 'meeting-diarized',
          speaker: 'Speaker',
          text: 'Remote speaker two',
          startMs: 1200,
          endMs: 2200,
          confidence: -1,
        },
      ])

    await expect((service as any).processJob('meeting-diarized')).resolves.toBeUndefined()

    const transcriptWrite = cryptoMock.encryptJSON.mock.calls.find(([, path]) =>
      String(path).endsWith('transcript.json'),
    )
    const speakersWrite = cryptoMock.encryptJSON.mock.calls.find(([, path]) =>
      String(path).endsWith('speakers.json'),
    )

    expect(mockDiarization.diarize).toHaveBeenCalledTimes(1)
    expect(transcriptWrite?.[0]).toEqual([
      expect.objectContaining({ speaker: 'me', text: 'My microphone words' }),
      expect.objectContaining({ speaker: 'speaker_1', text: 'Remote speaker one' }),
      expect.objectContaining({ speaker: 'speaker_2', text: 'Remote speaker two' }),
    ])
    expect(speakersWrite?.[0]).toEqual({
      me: { label: 'Me' },
      speaker_1: { label: 'Speaker 1' },
      speaker_2: { label: 'Speaker 2' },
    })
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
    )

    fsMock.access.mockImplementation(async (path) => {
      if (String(path).endsWith('system.webm')) return undefined
      throw new Error('ENOENT')
    })
    ;(service as any).detectAudioActivity = vi.fn().mockResolvedValue([{ start: 0, end: 2 }])
    ;(service as any).transcribeWithFallback = vi.fn().mockResolvedValue({
      transcription: [{ offsets: { from: 0, to: 1000 }, text: 'Hello from speakers' }],
    })
    ;(service as any).mapToTranscripts = vi.fn().mockReturnValue([
      {
        id: 'meeting-diarization-fallback-0',
        meetingId: 'meeting-diarization-fallback',
        speaker: 'Speaker',
        text: 'Hello from speakers',
        startMs: 0,
        endMs: 1000,
        confidence: -1,
      },
    ])

    await expect((service as any).processJob('meeting-diarization-fallback')).resolves.toBeUndefined()

    const transcriptWrite = cryptoMock.encryptJSON.mock.calls.find(([, path]) =>
      String(path).endsWith('transcript.json'),
    )

    expect(mockDiarization.diarize).toHaveBeenCalledTimes(1)
    expect(transcriptWrite?.[0]).toEqual([
      expect.objectContaining({ speaker: 'them', text: 'Hello from speakers' }),
    ])
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
          confidence: -1,
        },
      ],
      [
        {
          id: 'them-1',
          meetingId: 'meeting-echo',
          speaker: 'them',
          text: 'Do we want to run this through QA? I thought we had talked about that already.',
          startMs: 900,
          endMs: 4800,
          confidence: -1,
        },
        {
          id: 'them-2',
          meetingId: 'meeting-echo',
          speaker: 'them',
          text: 'Let us make sure the release checklist is current.',
          startMs: 6000,
          endMs: 8600,
          confidence: -1,
        },
      ],
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
          confidence: -1,
        },
        {
          id: 'me-2',
          meetingId: 'meeting-echo-pass',
          speaker: 'me',
          text: 'I can take the release checklist after lunch.',
          startMs: 15000,
          endMs: 18500,
          confidence: -1,
        },
      ],
      [
        {
          id: 'them-1',
          meetingId: 'meeting-echo-pass',
          speaker: 'them',
          text: 'Do we want to run this through QA?',
          startMs: 7600,
          endMs: 9100,
          confidence: -1,
        },
        {
          id: 'them-2',
          meetingId: 'meeting-echo-pass',
          speaker: 'them',
          text: 'I thought we had talked about that already.',
          startMs: 9050,
          endMs: 11900,
          confidence: -1,
        },
      ],
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
          confidence: -1,
        },
      ],
      [
        {
          id: 'them-1',
          meetingId: 'meeting-real-speech',
          speaker: 'them',
          text: 'Can you send an update once the launch checklist is ready?',
          startMs: 9200,
          endMs: 12900,
          confidence: -1,
        },
      ],
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
          confidence: -1,
        },
      ],
      [
        {
          id: 'them-1',
          meetingId: 'meeting-dialogue',
          speaker: 'them',
          text: 'Yes, but I want QA involved as well.',
          startMs: 2600,
          endMs: 5100,
          confidence: -1,
        },
      ],
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
        confidence: -1,
      },
      {
        id: 'meeting-fragments-1',
        meetingId: 'meeting-fragments',
        speaker: 'them',
        text: 'to send the design review this afternoon',
        startMs: 2350,
        endMs: 4200,
        confidence: -1,
      },
    ])

    expect(stitched).toHaveLength(1)
    expect(stitched[0].text).toBe('I think the next step is to send the design review this afternoon')
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
        confidence: -1,
      },
      {
        id: 'meeting-sentences-1',
        meetingId: 'meeting-sentences',
        speaker: 'them',
        text: 'Can you take a look at the rollout plan?',
        startMs: 2350,
        endMs: 4300,
        confidence: -1,
      },
    ])

    expect(stitched).toHaveLength(2)
  })

  it('chooses 10 whisper threads on a 20-thread machine', () => {
    setPlatform('win32')
    osMock.availableParallelism.mockReturnValue(20)

    expect((service as any).getWhisperThreadCount()).toBe(10)
  })

  it('passes the computed thread count to whisper-cli', async () => {
    setPlatform('win32')
    const child = new MockChildProcess()
    childProcessMock.spawn.mockReturnValue(child as any)

    const promise = (service as any).runWhisperPass('/mock/tmp/audio.wav', 'meeting-123', 60)
    child.emit('close', 0)

    await expect(promise).resolves.toBeUndefined()
    expect(childProcessMock.spawn).toHaveBeenCalledWith(
      '/mock/whisper',
      expect.arrayContaining(['-t', '10']),
    )
    expect(osMock.setPriority).toHaveBeenCalledWith(1234, 10)
  })

  it('passes short-segmentation flags when requested', async () => {
    const child = new MockChildProcess()
    childProcessMock.spawn.mockReturnValue(child as any)

    const promise = (service as any).runWhisperPass(
      '/mock/tmp/audio.wav',
      'meeting-123',
      60,
      undefined,
      ['-ml', '50', '-sow'],
    )
    child.emit('close', 0)

    await expect(promise).resolves.toBeUndefined()
    expect(childProcessMock.spawn).toHaveBeenCalledWith(
      '/mock/whisper',
      expect.arrayContaining(['-ml', '50', '-sow']),
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
        'both 4.x?',
      ][index % 3],
      startMs: index * 1000,
      endMs: (index + 1) * 1000,
      confidence: -1,
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
      confidence: -1,
    }))

    expect((service as any).hasSuspiciousRepetition(transcripts)).toBe(false)
  })

  it('uses chunked transcription for long recordings', async () => {
    const chunkedOutput = { transcription: [{ offsets: { from: 0, to: 1000 }, text: 'chunked' }] }
    const chunkedSpy = vi.spyOn(service as any, 'runWhisperChunked').mockResolvedValue(chunkedOutput)
    const singlePassSpy = vi.spyOn(service as any, 'runWhisperPassAndRead')

    const result = await (service as any).transcribeWithFallback(
      '/mock/tmp/audio.wav',
      'meeting-123',
      240,
      '/mock/tmp/audio',
      [],
    )

    expect(result).toEqual(chunkedOutput)
    expect(chunkedSpy).toHaveBeenCalled()
    expect(singlePassSpy).not.toHaveBeenCalled()
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
      if (String(path).endsWith('mic.webm') || String(path).endsWith('system.webm')) return undefined
      throw new Error('ENOENT')
    })
    ;(service as any).detectAudioActivity = vi.fn().mockResolvedValue([{ start: 0, end: 2 }])
    ;(service as any).transcribeWithFallback = vi
      .fn()
      .mockResolvedValueOnce({
        transcription: [{ offsets: { from: 0, to: 1000 }, text: 'echoed sentence' }],
      })
      .mockResolvedValueOnce({
        transcription: [{ offsets: { from: 0, to: 1000 }, text: 'echoed sentence' }],
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
          confidence: -1,
        },
      ])
      .mockReturnValueOnce([
        {
          id: 'meeting-dual-echo-1',
          meetingId: 'meeting-dual-echo',
          speaker: 'Speaker',
          text: 'echoed sentence',
          startMs: 1000,
          endMs: 3000,
          confidence: -1,
        },
      ])

    const suppressSpy = vi.spyOn(service as any, 'suppressAcousticEchoes')
    const mergeSpy = vi.spyOn(service as any, 'mergeTranscriptStreams')

    await expect((service as any).processJob('meeting-dual-echo')).resolves.toBeUndefined()

    expect(suppressSpy).toHaveBeenCalledTimes(1)
    expect(mergeSpy).toHaveBeenCalledWith(
      'meeting-dual-echo',
      suppressSpy.mock.results[0]?.value,
      expect.any(Array),
    )
  })
})
