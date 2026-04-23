import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import { TranscriptionService } from '../transcription'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) }
}))

vi.mock('os', () => ({
  tmpdir: vi.fn(() => '/mock/tmp'),
  availableParallelism: vi.fn(() => 8),
  cpus: vi.fn(() => new Array(8).fill({})),
  setPriority: vi.fn(),
  constants: {
    priority: {
      PRIORITY_BELOW_NORMAL: 10
    }
  }
}))

vi.mock('fs/promises', () => ({
  access: vi.fn()
}))

vi.mock('child_process', () => ({
  spawn: vi.fn()
}))

vi.mock('../crypto', () => ({
  isEncrypted: vi.fn().mockResolvedValue(false),
  decryptJSON: vi.fn(),
  decryptFileToTemp: vi.fn(),
  encryptJSON: vi.fn(),
  encryptFileInPlace: vi.fn().mockResolvedValue(undefined)
}))

const childProcessMock = vi.mocked(await import('child_process'))

class MockChildProcess extends EventEmitter {
  pid = 1234
  stderr = new EventEmitter()
  stdout = new EventEmitter()
}

describe('Transcription crash diagnostics', () => {
  let service: TranscriptionService

  beforeEach(() => {
    vi.clearAllMocks()
    service = new TranscriptionService(
      {
        isReady: vi.fn().mockResolvedValue(true),
        ensureReady: vi.fn().mockResolvedValue(undefined),
        getWhisperPath: vi.fn().mockReturnValue('/mock/whisper'),
        getFfmpegPath: vi.fn().mockReturnValue('/mock/ffmpeg'),
        getModelPath: vi.fn().mockReturnValue('/mock/model.bin')
      } as any,
      {
        convert: vi.fn(),
        mergeAudio: vi.fn(),
        extractClip: vi.fn(),
        concatClips: vi.fn(),
        getDuration: vi.fn()
      } as any,
      '/mock/home/AutoDoc/recordings',
      {
        isConnected: vi.fn().mockReturnValue(false),
        fetchAllRecentEvents: vi.fn().mockResolvedValue([])
      } as any,
      () => false
    )
  })

  it('includes the terminating signal when whisper exits without a numeric code', async () => {
    const child = new MockChildProcess()
    childProcessMock.spawn.mockReturnValue(child as any)

    const promise = (service as any).runWhisperPass('/mock/tmp/audio.wav', 'meeting-123', 60)
    child.emit('close', null, 'SIGKILL')

    await expect(promise).rejects.toThrow('whisper.cpp exited with code null (signal SIGKILL)')
  })
})
