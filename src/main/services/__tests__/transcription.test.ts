import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TranscriptionService } from '../transcription'
import type { WhisperManager } from '../whisper-manager'
import type { AudioConverter } from '../audio-converter'
import type { CalendarService } from '../calendar'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/mock/home') },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
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
}))

const fsMock = vi.mocked(await import('fs/promises'))

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
    getDuration: vi.fn().mockResolvedValue(60),
  } as unknown as AudioConverter
}

function createMockCalendarService(): CalendarService {
  return {
    isConnected: vi.fn().mockReturnValue(false),
    fetchRecentEvents: vi.fn().mockResolvedValue([]),
  } as unknown as CalendarService
}

describe('TranscriptionService', () => {
  let service: TranscriptionService
  let mockWhisper: WhisperManager
  let mockConverter: AudioConverter
  let mockCalendar: CalendarService

  beforeEach(() => {
    vi.clearAllMocks()
    mockWhisper = createMockWhisperManager()
    mockConverter = createMockAudioConverter()
    mockCalendar = createMockCalendarService()
    service = new TranscriptionService(
      mockWhisper,
      mockConverter,
      '/mock/home/AutoDoc/recordings',
      mockCalendar,
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

  it('returns queued status after enqueue', async () => {
    vi.spyOn(service as any, 'processNext').mockResolvedValue(undefined)
    service.enqueue('meeting-123')

    fsMock.access.mockRejectedValue(new Error('ENOENT'))
    const status = await service.getStatus('meeting-123')
    expect(status).toBe('queued')
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
})
