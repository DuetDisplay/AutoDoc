import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { SegmentationService } from '../segmentation'
import { TranscriptionService } from '../transcription'

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [],
  },
}))

describe('startup scan', () => {
  let baseDir: string

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'autodoc-startup-scan-'))
  })

  it('auto-retries failed segmentation jobs on startup when retries remain', async () => {
    const meetingId = 'meeting-seg-failed'
    const meetingDir = join(baseDir, meetingId)
    await mkdir(meetingDir, { recursive: true })
    await writeFile(join(meetingDir, 'transcript.json'), '[]')
    await writeFile(join(meetingDir, 'segments.error'), JSON.stringify({ error: 'boom', retries: 1 }))

    const service = new SegmentationService(
      { summarize: vi.fn(), checkConnection: vi.fn() } as any,
      { waitUntilReady: vi.fn() } as any,
      baseDir,
    )

    const enqueueSpy = vi.spyOn(service, 'enqueue')

    await service.scanAndEnqueuePending()

    expect(enqueueSpy).toHaveBeenCalledWith(meetingId, 'recovery-scan')
  })

  it('does not auto-retry failed segmentation jobs on startup after max retries', async () => {
    const meetingId = 'meeting-seg-exhausted'
    const meetingDir = join(baseDir, meetingId)
    await mkdir(meetingDir, { recursive: true })
    await writeFile(join(meetingDir, 'transcript.json'), '[]')
    await writeFile(join(meetingDir, 'segments.error'), JSON.stringify({ error: 'boom', retries: 3 }))

    const service = new SegmentationService(
      { summarize: vi.fn(), checkConnection: vi.fn() } as any,
      { waitUntilReady: vi.fn() } as any,
      baseDir,
    )

    const enqueueSpy = vi.spyOn(service, 'enqueue')

    await service.scanAndEnqueuePending()

    expect(enqueueSpy).not.toHaveBeenCalled()
    await expect(service.getStatus(meetingId)).resolves.toBe('failed')
  })

  it('auto-retries failed transcription jobs on startup when retries remain', async () => {
    const meetingId = 'meeting-tr-failed'
    const meetingDir = join(baseDir, meetingId)
    await mkdir(meetingDir, { recursive: true })
    await writeFile(join(meetingDir, 'audio.webm'), 'audio')
    await writeFile(join(meetingDir, 'transcript.error'), JSON.stringify({ error: 'boom', retries: 1 }))

    const service = new TranscriptionService(
      { ensureReady: vi.fn(), getWhisperPath: vi.fn(), getFfmpegPath: vi.fn(), getModelPath: vi.fn() } as any,
      { convert: vi.fn(), mergeAudio: vi.fn(), getDuration: vi.fn() } as any,
      baseDir,
      { fetchAllRecentEvents: vi.fn(), isConnected: vi.fn() } as any,
    )

    const enqueueSpy = vi.spyOn(service, 'enqueue')

    await service.scanAndEnqueuePending()

    expect(enqueueSpy).toHaveBeenCalledWith(meetingId, 'recovery-scan')
  })

  it('does not auto-retry failed transcription jobs on startup after max retries', async () => {
    const meetingId = 'meeting-tr-exhausted'
    const meetingDir = join(baseDir, meetingId)
    await mkdir(meetingDir, { recursive: true })
    await writeFile(join(meetingDir, 'audio.webm'), 'audio')
    await writeFile(join(meetingDir, 'transcript.error'), JSON.stringify({ error: 'boom', retries: 3 }))

    const service = new TranscriptionService(
      { ensureReady: vi.fn(), getWhisperPath: vi.fn(), getFfmpegPath: vi.fn(), getModelPath: vi.fn() } as any,
      { convert: vi.fn(), mergeAudio: vi.fn(), getDuration: vi.fn() } as any,
      baseDir,
      { fetchAllRecentEvents: vi.fn(), isConnected: vi.fn() } as any,
    )

    const enqueueSpy = vi.spyOn(service, 'enqueue')

    await service.scanAndEnqueuePending()

    expect(enqueueSpy).not.toHaveBeenCalled()
    await expect(service.getStatus(meetingId)).resolves.toBe('failed')
  })
})
