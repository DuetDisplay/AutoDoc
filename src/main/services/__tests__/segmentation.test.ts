import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join } from 'path'
import { SegmentationService } from '../segmentation'
import type { LLMProvider } from '../llm'
import type { OllamaManager } from '../ollama-manager'

const mocks = vi.hoisted(() => ({
  logAutodocFailure: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) }
}))

vi.mock('fs/promises', () => ({
  access: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  unlink: vi.fn(),
  stat: vi.fn()
}))

vi.mock('../crypto', () => ({
  isEncrypted: vi.fn().mockResolvedValue(false),
  decryptJSON: vi.fn(),
  encryptJSON: vi.fn()
}))

vi.mock('../autodoc-log', () => ({
  logAutodocFailure: mocks.logAutodocFailure
}))

const fsMock = vi.mocked(await import('fs/promises'))
const cryptoMock = vi.mocked(await import('../crypto'))

function createMockProvider(): LLMProvider {
  return {
    summarize: vi.fn().mockResolvedValue({
      decisions: [],
      actionItems: [],
      information: [],
      discussion: [],
      statusUpdates: []
    }),
    checkConnection: vi.fn().mockResolvedValue(true),
    abortActiveRequests: vi.fn(),
    setLowMemoryMode: vi.fn()
  }
}

function createMockOllamaManager(): OllamaManager {
  return {
    waitUntilReady: vi.fn().mockResolvedValue(undefined)
  } as unknown as OllamaManager
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('SegmentationService', () => {
  let service: SegmentationService
  let provider: LLMProvider

  beforeEach(() => {
    vi.clearAllMocks()
    fsMock.unlink.mockResolvedValue(undefined as any)
    provider = createMockProvider()
    service = new SegmentationService(
      provider,
      createMockOllamaManager(),
      '/mock/home/AutoDoc/recordings'
    )
  })

  it('returns pending status when no files exist', async () => {
    fsMock.access.mockRejectedValue(new Error('ENOENT'))

    const status = await service.getStatus('meeting-123')
    expect(status).toBe('pending')
  })

  it('returns failed status when segments.error is newer than segments.json', async () => {
    fsMock.access.mockImplementation(async (path) => {
      if (String(path).endsWith('segments.json') || String(path).endsWith('segments.error'))
        return undefined
      throw new Error('ENOENT')
    })
    fsMock.stat.mockImplementation(
      async (path) =>
        ({
          isDirectory: () => false,
          mtimeMs: String(path).endsWith('segments.error') ? 200 : 100
        }) as any
    )

    const status = await service.getStatus('meeting-123')
    expect(status).toBe('failed')
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
      (service as any).markFailed('deleted-meeting', 'This operation was aborted')
    ).resolves.toBeUndefined()
  })

  it('skips LLM summarization when transcript only contains low-signal boilerplate', async () => {
    fsMock.access.mockImplementation(async (path) => {
      if (String(path).endsWith('transcript.json')) return undefined
      throw new Error('ENOENT')
    })
    fsMock.readFile.mockResolvedValue(
      JSON.stringify([
        {
          id: 'm1-0',
          meetingId: 'm1',
          speaker: 'Speaker',
          text: 'Subtitles by the Amara.org community',
          startMs: 0,
          endMs: 1000,
          confidence: -1
        },
        {
          id: 'm1-1',
          meetingId: 'm1',
          speaker: 'Speaker',
          text: 'Thank you.',
          startMs: 1000,
          endMs: 2000,
          confidence: -1
        }
      ]) as any
    )

    await (service as any).processJob('m1')

    expect(provider.summarize).not.toHaveBeenCalled()
    expect(cryptoMock.encryptJSON).toHaveBeenCalledWith(
      {
        decisions: [],
        actionItems: [],
        information: [],
        discussion: [],
        statusUpdates: []
      },
      join('/mock/home/AutoDoc/recordings', 'm1', 'segments.json')
    )
  })

  it('accepts empty segmentation output for short low-information transcripts', async () => {
    fsMock.access.mockImplementation(async (path) => {
      if (String(path).endsWith('transcript.json')) return undefined
      throw new Error('ENOENT')
    })
    fsMock.readFile.mockResolvedValue(
      JSON.stringify([
        {
          id: 'm1-0',
          meetingId: 'm1',
          speaker: 'Chris',
          text: 'We should probably follow up with them next week.',
          startMs: 0,
          endMs: 15_000,
          confidence: 0.8
        },
        {
          id: 'm1-1',
          meetingId: 'm1',
          speaker: 'Pat',
          text: 'Okay, let us regroup after we hear back.',
          startMs: 20_000,
          endMs: 55_000,
          confidence: 0.8
        }
      ]) as any
    )

    await expect((service as any).processJob('m1')).resolves.toBeUndefined()

    expect(provider.summarize).toHaveBeenCalled()
    expect(cryptoMock.encryptJSON).toHaveBeenCalledWith(
      {
        decisions: [],
        actionItems: [],
        information: [],
        discussion: [],
        statusUpdates: []
      },
      join('/mock/home/AutoDoc/recordings', 'm1', 'segments.json')
    )
  })

  it('invokes onComplete when segmentation finishes successfully', async () => {
    fsMock.access.mockImplementation(async (path) => {
      if (String(path).endsWith('transcript.json')) return undefined
      throw new Error('ENOENT')
    })
    fsMock.readFile.mockResolvedValue(
      Buffer.from(
        JSON.stringify([
          {
            id: 'm1-0',
            meetingId: 'm1',
            speaker: 'Chris',
            text: 'We confirmed the rollout plan.',
            startMs: 0,
            endMs: 65_000,
            confidence: 0.9
          }
        ])
      )
    )
    vi.mocked(provider.summarize).mockResolvedValue({
      decisions: [],
      actionItems: [],
      information: [
        {
          id: 'seg-1',
          meetingId: 'm1',
          category: 'information',
          topic: 'Rollout',
          title: 'Plan confirmed',
          content: 'The rollout plan was confirmed.',
          assignee: null,
          deadline: null,
          sourceStartMs: 0,
          sourceEndMs: 65_000
        }
      ],
      discussion: [],
      statusUpdates: []
    })
    const onComplete = vi.fn()
    service.onComplete(onComplete)

    await (service as any).processJob('m1')

    expect(onComplete).toHaveBeenCalledWith('m1')
  })

  it('logs onComplete callback failures without failing completed segmentation', async () => {
    fsMock.access.mockImplementation(async (path) => {
      if (String(path).endsWith('transcript.json')) return undefined
      throw new Error('ENOENT')
    })
    fsMock.readFile.mockResolvedValue(
      JSON.stringify([
        {
          id: 'm1-0',
          meetingId: 'm1',
          speaker: 'Chris',
          text: 'We confirmed the rollout plan.',
          startMs: 0,
          endMs: 65_000,
          confidence: 0.9
        }
      ]) as any
    )
    vi.mocked(provider.summarize).mockResolvedValue({
      decisions: [],
      actionItems: [],
      information: [
        {
          id: 'seg-1',
          meetingId: 'm1',
          category: 'information',
          topic: 'Rollout',
          title: 'Plan confirmed',
          content: 'The rollout plan was confirmed.',
          assignee: null,
          deadline: null,
          sourceStartMs: 0,
          sourceEndMs: 65_000
        }
      ],
      discussion: [],
      statusUpdates: []
    })
    const error = new Error('callback failed')
    service.onComplete(() => {
      throw error
    })

    const serviceTestApi = service as unknown as {
      processJob(meetingId: string): Promise<void>
    }

    await expect(serviceTestApi.processJob('m1')).resolves.toBeUndefined()

    expect(mocks.logAutodocFailure).toHaveBeenCalledWith({
      area: 'segmentation',
      message: 'Segmentation completion callback failed',
      error,
      meetingId: 'm1'
    })
  })

  it('does not invoke onComplete when segmentation fails', async () => {
    fsMock.access.mockImplementation(async (path) => {
      if (String(path).endsWith('transcript.json')) return undefined
      throw new Error('ENOENT')
    })
    fsMock.readFile.mockResolvedValue(
      JSON.stringify([
        {
          id: 'm1-0',
          meetingId: 'm1',
          speaker: 'Chris',
          text: 'We confirmed the rollout plan.',
          startMs: 0,
          endMs: 65_000,
          confidence: 0.9
        }
      ]) as any
    )
    vi.mocked(provider.summarize).mockRejectedValue(new Error('Ollama unavailable'))
    const onComplete = vi.fn()
    service.onComplete(onComplete)

    await expect((service as any).processJob('m1')).rejects.toThrow('Ollama unavailable')
    expect(onComplete).not.toHaveBeenCalled()
  })

  it('marks substantive empty segmentation output as transcript-only instead of retry-failed', async () => {
    fsMock.access.mockImplementation(async (path) => {
      if (String(path).endsWith('transcript.json')) return undefined
      throw new Error('ENOENT')
    })
    fsMock.readFile.mockResolvedValue(
      JSON.stringify([
        {
          id: 'm2-0',
          meetingId: 'm2',
          speaker: 'Chris',
          text: 'We reviewed the onboarding funnel metrics and conversion dropped from 42 percent to 31 percent after the pricing page update went live on Monday.',
          startMs: 0,
          endMs: 30_000,
          confidence: 0.8
        },
        {
          id: 'm2-1',
          meetingId: 'm2',
          speaker: 'Pat',
          text: 'The team agreed we need an experiment plan, a rollback option, and a written owner list for engineering, design, and growth before next Tuesday.',
          startMs: 45_000,
          endMs: 85_000,
          confidence: 0.8
        },
        {
          id: 'm2-2',
          meetingId: 'm2',
          speaker: 'Chris',
          text: 'Finance also confirmed the current acquisition budget is capped at fifty thousand dollars for the quarter, so any campaign changes need approval this week.',
          startMs: 95_000,
          endMs: 130_000,
          confidence: 0.8
        },
        {
          id: 'm2-3',
          meetingId: 'm2',
          speaker: 'Pat',
          text: 'We also discussed support volume, launch timing, customer messaging, and the dependency on the billing migration that is still in progress.',
          startMs: 135_000,
          endMs: 170_000,
          confidence: 0.8
        }
      ]) as any
    )

    await expect((service as any).processJob('m2')).resolves.toBeUndefined()

    expect(cryptoMock.encryptJSON).not.toHaveBeenCalled()
    expect(fsMock.writeFile).toHaveBeenCalledWith(
      join('/mock/home/AutoDoc/recordings', 'm2', 'segments.error'),
      JSON.stringify({
        error:
          'LLM returned empty segments for non-trivial transcript — likely context overflow or model issue',
        retries: 0,
        status: 'no-notes'
      })
    )
  })

  it('waits for shared Ollama setup instead of failing notes while setup is still running', async () => {
    const setup = deferred()
    const waitingOllama = {
      waitUntilReady: vi.fn(() => setup.promise)
    } as unknown as OllamaManager
    provider = createMockProvider()
    ;(provider.summarize as ReturnType<typeof vi.fn>).mockResolvedValue({
      decisions: [
        {
          topic: 'Planning',
          title: 'Follow-up planned',
          content: 'The team agreed to follow up next week.',
          assignee: null,
          deadline: null,
          sourceStartMs: 0,
          sourceEndMs: 15_000
        }
      ],
      actionItems: [],
      information: [],
      discussion: [],
      statusUpdates: []
    })
    service = new SegmentationService(provider, waitingOllama, '/mock/home/AutoDoc/recordings')
    fsMock.access.mockImplementation(async (path) => {
      if (String(path).endsWith('transcript.json')) return undefined
      throw new Error('ENOENT')
    })
    fsMock.readFile.mockResolvedValue(
      JSON.stringify([
        {
          id: 'm3-0',
          meetingId: 'm3',
          speaker: 'Chris',
          text: 'We should follow up next week.',
          startMs: 0,
          endMs: 15_000,
          confidence: 0.8
        }
      ]) as any
    )

    const processing = (service as any).processJob('m3')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(waitingOllama.waitUntilReady).toHaveBeenCalledOnce()
    expect(provider.summarize).not.toHaveBeenCalled()
    expect(fsMock.writeFile).not.toHaveBeenCalled()

    setup.resolve()
    await expect(processing).resolves.toBeUndefined()

    expect(provider.summarize).toHaveBeenCalledOnce()
    expect(cryptoMock.encryptJSON).toHaveBeenCalledWith(
      {
        decisions: [
          {
            topic: 'Planning',
            title: 'Follow-up planned',
            content: 'The team agreed to follow up next week.',
            assignee: null,
            deadline: null,
            sourceStartMs: 0,
            sourceEndMs: 15_000
          }
        ],
        actionItems: [],
        information: [],
        discussion: [],
        statusUpdates: []
      },
      join('/mock/home/AutoDoc/recordings', 'm3', 'segments.json')
    )
  })

  it('prioritizes direct jobs ahead of recovery-scan jobs', () => {
    vi.spyOn(service as any, 'processNext').mockResolvedValue(undefined)

    service.enqueue('recovery-1', 'recovery-scan')
    service.enqueue('direct-1', 'direct')

    expect((service as any).queue).toEqual(['direct-1', 'recovery-1'])
  })

  it('preempts an active recovery-scan job when a direct job arrives', () => {
    vi.spyOn(service as any, 'processNext').mockResolvedValue(undefined)
    ;(service as any).activeJobId = 'recovery-active'
    ;(service as any).activeJobSource = 'recovery-scan'
    ;(service as any).processing = true

    service.enqueue('direct-1', 'direct')

    expect(provider.abortActiveRequests as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      'SEGMENTATION_PREEMPTED'
    )
    expect((service as any).queue).toEqual(['direct-1', 'recovery-active'])
  })

  it('enables low-memory LLM mode for low-spec Mac profiles', async () => {
    provider = createMockProvider()
    ;(provider.summarize as ReturnType<typeof vi.fn>).mockResolvedValue({
      decisions: [
        {
          topic: 'Planning',
          title: 'Follow-up planned',
          content: 'The team agreed to follow up next week.',
          assignee: null,
          deadline: null,
          sourceStartMs: 0,
          sourceEndMs: 15_000
        }
      ],
      actionItems: [],
      information: [],
      discussion: [],
      statusUpdates: []
    })
    service = new SegmentationService(
      provider,
      createMockOllamaManager(),
      '/mock/home/AutoDoc/recordings',
      null,
      () => ({
        id: 'mac-low-spec',
        label: 'Low-spec Apple Silicon Mac',
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
        dualSourceMode: 'sequential',
        notesAfterTranscriptionOnly: true,
        serializeLocalProcessing: true
      })
    )
    fsMock.access.mockImplementation(async (path) => {
      if (String(path).endsWith('transcript.json')) return undefined
      throw new Error('ENOENT')
    })
    fsMock.readFile.mockResolvedValue(
      JSON.stringify([
        {
          id: 'm-low-0',
          meetingId: 'm-low',
          speaker: 'Chris',
          text: 'We should follow up next week.',
          startMs: 0,
          endMs: 15_000,
          confidence: 0.8
        }
      ]) as any
    )

    await (service as any).processJob('m-low')

    expect(provider.setLowMemoryMode).toHaveBeenCalledWith(true)
    expect(provider.summarize).toHaveBeenCalledOnce()
  })
})
