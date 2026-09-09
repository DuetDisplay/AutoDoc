import { createHash } from 'node:crypto'
import { afterEach, describe, it, expect, vi } from 'vitest'
import type { MeetingSegments, Segment } from '../../../shared/types'
import {
  computeWriterWeightedEvalTokPerSec,
  extractWriterCategoryObject,
  inspectCompactWriterPayload,
  parseWriterJsonRecord,
  salvageWriterTimestampMs,
  alternateClockTimestampMs,
  extractProseClockMs,
  isTransientOllamaRuntimeError,
  LOW_MEMORY_CONTEXT_TOKENS,
  MAC_CONTEXT_TOKENS,
  MAC_MAX_OUTPUT_TOKENS,
  OllamaProvider,
  STANDARD_CONTEXT_TOKENS,
  WINDOWS_CONTEXT_TOKENS,
  WINDOWS_TIGHT_MAX_OUTPUT_TOKENS,
  encodeMacNotesLineReferences,
  formatNotesWriterTranscript,
  isNotesWriterBackchannelOnly,
  macActionCandidateGuidance,
  macActionCandidateLineIds,
  macHighSignalCandidateGuidance,
  macHighSignalCandidateLineIds,
  macRolloutGateCandidateGuidance,
  macRolloutGateCandidateLineIds,
  packTranscriptChunks,
  shouldOmitWindowsTightSpeakerLabels,
  shouldSanitizeWindowsWriterRecords,
  shouldStripWindowsTightBackchannel,
  shouldSkipWindowsTightScanRewrites,
  countCompleteMacWriterItems,
  countCompleteTightWriterItems,
  shouldStopMacWriterStream,
  shouldStopWindowsTightWriterStream,
  shouldOmitWindowsTightResponseFormat,
  shouldAbsorbWindowsTightShortTail,
  WRITER_PARSE_ERROR_CODE,
  writerProgressPercent
} from '../llm'

const originalPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform
  })
}

function makeSegment(
  overrides: Partial<Segment> & Pick<Segment, 'id' | 'category' | 'title' | 'content'>
): Segment {
  return {
    meetingId: 'meeting-1',
    topic: 'General',
    assignee: null,
    deadline: null,
    sourceStartMs: 0,
    sourceEndMs: 0,
    ...overrides
  }
}

function makeSegments(items: {
  decisions?: Segment[]
  actionItems?: Segment[]
  information?: Segment[]
  discussion?: Segment[]
  statusUpdates?: Segment[]
}): MeetingSegments {
  return {
    decisions: items.decisions ?? [],
    actionItems: items.actionItems ?? [],
    information: items.information ?? [],
    discussion: items.discussion ?? [],
    statusUpdates: items.statusUpdates ?? []
  }
}

function makeSuccessfulOllamaChunk(): Uint8Array {
  const content = JSON.stringify({
    decisions: [],
    action_items: [],
    information: [
      {
        topic: 'Recovery',
        title: 'Windows notes retry completed',
        content: 'The Windows notes retry completed after the stalled request was cancelled.',
        sourceStartMs: 1,
        sourceEndMs: 1
      }
    ],
    discussion: [],
    status_updates: []
  })

  return new TextEncoder().encode(`${JSON.stringify({ message: { content } })}\n`)
}

function makeSuccessfulOllamaResponse(): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(makeSuccessfulOllamaChunk())
        controller.close()
      }
    }),
    { status: 200 }
  )
}

function makeOllamaContentResponse(content: string, doneReason = 'stop'): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`${JSON.stringify({ message: { content } })}\n`))
        controller.enqueue(
          encoder.encode(
            `${JSON.stringify({
              done: true,
              done_reason: doneReason,
              eval_count: 12,
              eval_duration: 1_000_000_000
            })}\n`
          )
        )
        controller.close()
      }
    }),
    { status: 200 }
  )
}

function makeIrreparableJsonResponse(): Response {
  return makeOllamaContentResponse(
    `{"decisions":[{"topic":"Hold Music","title":"Song","content":"${'na '.repeat(200)}`
  )
}

function makeValidChunkResponse(title: string, content: string): Response {
  return makeOllamaContentResponse(
    JSON.stringify({
      decisions: [],
      action_items: [],
      information: [
        {
          topic: 'Recovery',
          title,
          content,
          sourceStartMs: 0,
          sourceEndMs: 1_000
        }
      ],
      discussion: [],
      status_updates: []
    })
  )
}

function makeLongChunkLine(marker: string, phrase: string): string {
  return `[00:00] [Chris] ${marker} ${phrase} ${'na '.repeat(900)}`
}

function makeThreeChunkTranscript(): string {
  return [
    makeLongChunkLine('CHUNK_ONE_LYRICS', 'hold music and repeated chorus lines'),
    makeLongChunkLine('CHUNK_TWO_BILLING', 'the billing API migration was confirmed'),
    makeLongChunkLine('CHUNK_THREE_FLAGS', 'the feature flag rollout was approved')
  ].join('\n')
}

function requestUserContent(init?: RequestInit): string {
  const body = JSON.parse(String(init?.body ?? '{}')) as {
    messages?: Array<{ role: string; content: string }>
  }
  return body.messages?.find((message) => message.role === 'user')?.content ?? ''
}

const mocks = vi.hoisted(() => ({
  logAutodocEvent: vi.fn(),
  captureMessage: vi.fn()
}))

vi.mock('../autodoc-log', () => ({
  logAutodocEvent: mocks.logAutodocEvent
}))

vi.mock('../sentry-reporter', () => ({
  captureMessage: mocks.captureMessage
}))

describe('OllamaProvider grounding', () => {
  const provider = new OllamaProvider('http://localhost:11434', 'test-model')

  afterEach(() => {
    setPlatform(originalPlatform)
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('cancels a timed-out Windows stream before starting its retry', async () => {
    setPlatform('win32')
    vi.useFakeTimers()
    const cancelFirstStream = vi.fn()
    let firstSignal: AbortSignal | null = null
    let retrySawAbortedSignal = false

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (fetchMock.mock.calls.length === 1) {
        firstSignal = init?.signal as AbortSignal
        return new Response(
          new ReadableStream({
            cancel: cancelFirstStream
          }),
          { status: 200 }
        )
      }

      retrySawAbortedSignal = firstSignal?.aborted ?? false
      return makeSuccessfulOllamaResponse()
    })
    vi.stubGlobal('fetch', fetchMock)

    const summarizing = new OllamaProvider('http://localhost:11434', 'test-model').summarize(
      'meeting-stream-timeout-windows',
      '[00:00] [Chris] The Windows notes retry completed after the stalled request was cancelled.',
      undefined,
      5
    )

    await vi.advanceTimersByTimeAsync(120_000)
    const result = await summarizing

    expect(result.information).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(retrySawAbortedSignal).toBe(true)
    expect(cancelFirstStream).toHaveBeenCalledOnce()
  })

  it('fails the writer when fetch failed retries never recover the serve', async () => {
    setPlatform('win32')
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      new OllamaProvider('http://localhost:11434', 'test-model').summarize(
        'meeting-dead-runner',
        '[00:00] [Chris] The rollout plan was confirmed after the runner was recycled.',
        undefined,
        5
      )
    ).rejects.toThrow('fetch failed')
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(mocks.logAutodocEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: 'notes llm chunk skipped' })
    )
  })

  it('recovers the serve once after fetch failed and finishes the writer chunk', async () => {
    setPlatform('win32')
    const recoverRuntimeOnce = vi.fn().mockResolvedValue(undefined)
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValue(makeSuccessfulOllamaResponse())
    vi.stubGlobal('fetch', fetchMock)

    const result = await new OllamaProvider('http://localhost:11434', 'test-model', {
      recoverRuntimeOnce
    }).summarize(
      'meeting-recovered-runner',
      '[00:00] [Chris] The Windows notes retry completed after the stalled request was cancelled.',
      undefined,
      5
    )

    expect(result.information).toHaveLength(1)
    expect(recoverRuntimeOnce).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('keeps the existing macOS stream-timeout retry behavior', async () => {
    setPlatform('darwin')
    vi.useFakeTimers()
    const cancelFirstStream = vi.fn()
    let firstSignal: AbortSignal | null = null
    let retrySawAbortedSignal = true

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (fetchMock.mock.calls.length === 1) {
        firstSignal = init?.signal as AbortSignal
        return new Response(
          new ReadableStream({
            start(controller) {
              setTimeout(() => {
                controller.enqueue(makeSuccessfulOllamaChunk())
                controller.close()
              }, 121_000)
            },
            cancel: cancelFirstStream
          }),
          { status: 200 }
        )
      }

      retrySawAbortedSignal = firstSignal?.aborted ?? false
      return makeSuccessfulOllamaResponse()
    })
    vi.stubGlobal('fetch', fetchMock)

    const summarizing = new OllamaProvider('http://localhost:11434', 'test-model').summarize(
      'meeting-stream-timeout-macos',
      '[00:00] [Chris] The Windows notes retry completed after the stalled request was cancelled.',
      undefined,
      5
    )

    await vi.advanceTimersByTimeAsync(121_000)
    await expect(summarizing).resolves.toBeDefined()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(retrySawAbortedSignal).toBe(false)
    expect(cancelFirstStream).not.toHaveBeenCalled()
  })

  it('reports a slow Windows stream at 60 seconds and clears it when content arrives', async () => {
    setPlatform('win32')
    vi.useFakeTimers()
    const onActivity = vi.fn()

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                setTimeout(() => {
                  controller.enqueue(makeSuccessfulOllamaChunk())
                  controller.close()
                }, 61_000)
              }
            }),
            { status: 200 }
          )
      )
    )

    const summarizing = new OllamaProvider('http://localhost:11434', 'test-model').summarize(
      'meeting-slow-windows',
      '[00:00] [Chris] The Windows notes retry completed after the stalled request was cancelled.',
      undefined,
      5,
      onActivity
    )

    await vi.advanceTimersByTimeAsync(59_999)
    expect(onActivity).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(onActivity).toHaveBeenCalledTimes(1)
    expect(onActivity).toHaveBeenLastCalledWith('waiting-for-local-ai')

    await vi.advanceTimersByTimeAsync(1_000)
    await expect(summarizing).resolves.toBeDefined()
    expect(onActivity.mock.calls).toEqual([['waiting-for-local-ai'], [null]])
  })

  it('does not report slow-stream activity on macOS', async () => {
    setPlatform('darwin')
    vi.useFakeTimers()
    const onActivity = vi.fn()

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                setTimeout(() => {
                  controller.enqueue(makeSuccessfulOllamaChunk())
                  controller.close()
                }, 61_000)
              }
            }),
            { status: 200 }
          )
      )
    )

    const summarizing = new OllamaProvider('http://localhost:11434', 'test-model').summarize(
      'meeting-slow-macos',
      '[00:00] [Chris] The Windows notes retry completed after the stalled request was cancelled.',
      undefined,
      5,
      onActivity
    )

    await vi.advanceTimersByTimeAsync(61_000)
    await expect(summarizing).resolves.toBeDefined()
    expect(onActivity).not.toHaveBeenCalled()
  })

  it('keeps slow activity through Windows retries and clears it after the final failure', async () => {
    setPlatform('win32')
    vi.useFakeTimers()
    const onActivity = vi.fn()
    // An empty underlying source keeps each read pending until the existing timeout fires.
    const fetchMock = vi.fn(async () => new Response(new ReadableStream({}), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const outcome = new OllamaProvider('http://localhost:11434', 'test-model')
      .summarize(
        'meeting-slow-retries',
        '[00:00] [Chris] Notes generation remains silent.',
        undefined,
        5,
        onActivity
      )
      .then(
        () => null,
        (error: unknown) => error
      )

    await vi.advanceTimersByTimeAsync(60_000)
    expect(onActivity.mock.calls).toEqual([['waiting-for-local-ai']])

    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(onActivity.mock.calls).toEqual([['waiting-for-local-ai']])

    await vi.advanceTimersByTimeAsync(120_000)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(onActivity.mock.calls).toEqual([['waiting-for-local-ai']])

    await vi.advanceTimersByTimeAsync(120_000)
    const error = await outcome
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('timed out after 120s')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(onActivity.mock.calls).toEqual([['waiting-for-local-ai'], [null]])
  })

  it('clears slow activity when Windows segmentation is preempted', async () => {
    setPlatform('win32')
    vi.useFakeTimers()
    const onActivity = vi.fn()
    const provider = new OllamaProvider('http://localhost:11434', 'test-model')

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_url: string, init?: RequestInit) =>
          new Response(
            new ReadableStream({
              start(controller) {
                init?.signal?.addEventListener('abort', () => {
                  controller.error(init.signal?.reason)
                })
              }
            }),
            { status: 200 }
          )
      )
    )

    const outcome = provider
      .summarize(
        'meeting-slow-preempted',
        '[00:00] [Chris] Notes generation remains silent.',
        undefined,
        5,
        onActivity
      )
      .then(
        () => null,
        (error: unknown) => error
      )

    await vi.advanceTimersByTimeAsync(60_000)
    expect(onActivity.mock.calls).toEqual([['waiting-for-local-ai']])

    provider.abortActiveRequests()
    const error = await outcome
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('SEGMENTATION_PREEMPTED')
    expect(onActivity.mock.calls).toEqual([['waiting-for-local-ai'], [null]])
    expect(mocks.logAutodocEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: 'notes llm chunk skipped' })
    )
    expect(provider.getLastWriterSkips()).toEqual([])
  })

  it('ignores activity callback errors during Windows notes generation', async () => {
    setPlatform('win32')
    vi.useFakeTimers()
    const onActivity = vi.fn(() => {
      throw new Error('renderer unavailable')
    })

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                setTimeout(() => {
                  controller.enqueue(makeSuccessfulOllamaChunk())
                  controller.close()
                }, 61_000)
              }
            }),
            { status: 200 }
          )
      )
    )

    const summarizing = new OllamaProvider('http://localhost:11434', 'test-model').summarize(
      'meeting-slow-callback-error',
      '[00:00] [Chris] The Windows notes retry completed after the stalled request was cancelled.',
      undefined,
      5,
      onActivity
    )

    await vi.advanceTimersByTimeAsync(61_000)
    await expect(summarizing).resolves.toBeDefined()
    expect(onActivity.mock.calls).toEqual([['waiting-for-local-ai'], [null]])
  })

  it('drops hallucinated notes whose numbers are not supported by the cited transcript span', () => {
    const transcript = [
      '[00:00] [Speaker] Latest Windows desktop installs are 73 for this build.',
      '[00:05] [Speaker] We are still rolling 30% to rewrite and 70% to legacy Windows.'
    ].join('\n')

    const result = (provider as any).parseResponse(
      'meeting-1',
      JSON.stringify({
        decisions: [],
        action_items: [],
        information: [
          {
            topic: 'Pricing',
            title: 'Annual fee confirmed',
            content: 'The team agreed on the $50 annual fee for all customer segments.',
            sourceStartMs: 5000,
            sourceEndMs: 5000
          }
        ],
        discussion: [],
        status_updates: []
      }),
      undefined,
      60_000,
      (provider as any).extractTimestampsMs(transcript),
      (provider as any).parseTranscriptLines(transcript)
    )

    expect(result.information).toEqual([])
  })

  it('keeps grounded items that match the cited transcript span', () => {
    setPlatform('darwin')
    const transcript = [
      '[00:00] [Speaker] Latest Windows desktop installs are 73 for this build.',
      '[00:05] [Speaker] We are still rolling 30% to rewrite and 70% to legacy Windows.'
    ].join('\n')

    const result = (provider as any).parseResponse(
      'meeting-1',
      JSON.stringify({
        decisions: [],
        action_items: [],
        information: [
          {
            topic: 'Windows rollout',
            title: 'Windows rollout split remains 30% and 70%',
            content: 'Rewrite stays at 30% while legacy Windows remains at 70%.',
            sourceStartMs: 5000,
            sourceEndMs: 5000
          }
        ],
        discussion: [],
        status_updates: []
      }),
      undefined,
      60_000,
      (provider as any).extractTimestampsMs(transcript),
      (provider as any).parseTranscriptLines(transcript)
    )

    expect(result.information).toHaveLength(1)
    expect(result.information[0].title).toContain('30%')
  })

  it('snaps timestamps within the current transcript chunk to avoid cross-chunk jumps', () => {
    const fullTranscript = [
      '[00:00] [Speaker] Team introductions and agenda review.',
      '[10:00] [Speaker] We should migrate the billing API before launch.',
      '[10:05] [Speaker] Chris will own the billing API migration plan.'
    ].join('\n')
    const chunkTranscript = [
      '[10:00] [Speaker] We should migrate the billing API before launch.',
      '[10:05] [Speaker] Chris will own the billing API migration plan.'
    ].join('\n')

    const result = (provider as any).parseResponse(
      'meeting-1',
      JSON.stringify({
        decisions: [],
        action_items: [
          {
            topic: 'Billing API',
            title: 'Prepare billing API migration',
            content: 'Chris will own the billing API migration plan before launch.',
            sourceStartMs: 1000,
            sourceEndMs: 1000
          }
        ],
        information: [],
        discussion: [],
        status_updates: []
      }),
      undefined,
      605_000,
      (provider as any).extractTimestampsMs(fullTranscript),
      (provider as any).parseTranscriptLines(chunkTranscript)
    )

    expect(result.actionItems).toHaveLength(1)
    expect(result.actionItems[0].sourceStartMs).toBe(
      process.platform === 'darwin' || process.platform === 'win32' ? 605_000 : 600_000
    )
    expect(result.actionItems[0].sourceEndMs).toBe(
      process.platform === 'darwin' || process.platform === 'win32' ? 605_000 : 600_000
    )
  })

  it('anchors macOS note timestamps to the strongest matching transcript evidence', () => {
    setPlatform('darwin')
    const transcript = [
      '[10:00] [Speaker] We are going to switch topics after the release discussion.',
      '[10:20] [Speaker] Chris will enable the feature flag after QA signs off.',
      '[10:40] [Speaker] Then we can talk about unrelated pricing details.'
    ].join('\n')

    const result = (provider as any).parseResponse(
      'meeting-1',
      JSON.stringify({
        decisions: [],
        action_items: [
          {
            topic: 'Release Planning',
            title: 'Enable the feature flag after QA',
            content: 'Chris will enable the feature flag once QA signs off.',
            sourceStartMs: 600_000,
            sourceEndMs: 600_000
          }
        ],
        information: [],
        discussion: [],
        status_updates: []
      }),
      undefined,
      650_000,
      (provider as any).extractTimestampsMs(transcript),
      (provider as any).parseTranscriptLines(transcript)
    )

    expect(result.actionItems).toHaveLength(1)
    expect(result.actionItems[0].sourceStartMs).toBe(
      process.platform === 'darwin' || process.platform === 'win32' ? 620_000 : 600_000
    )
  })

  it('normalizes overly specific topics into a smaller set of broad themes after chunk merge', () => {
    const segments = {
      decisions: [],
      actionItems: [],
      information: [
        {
          id: 'i1',
          meetingId: 'meeting-1',
          category: 'information',
          topic: 'Build Testing',
          title: 'Mac build under test',
          content: 'QA is validating the latest Mac build and tracking failures.',
          assignee: null,
          deadline: null,
          sourceStartMs: 0,
          sourceEndMs: 0
        },
        {
          id: 'i2',
          meetingId: 'meeting-1',
          category: 'information',
          topic: 'Nightly Build Tests',
          title: 'Nightly jobs need more coverage',
          content: 'The team discussed build dashboards, nightly jobs, and automated test health.',
          assignee: null,
          deadline: null,
          sourceStartMs: 0,
          sourceEndMs: 0
        },
        {
          id: 'i3',
          meetingId: 'meeting-1',
          category: 'information',
          topic: 'Build Validation',
          title: 'Release validation gaps remain',
          content: 'Build validation still needs more QA automation before release.',
          assignee: null,
          deadline: null,
          sourceStartMs: 0,
          sourceEndMs: 0
        },
        {
          id: 'i4',
          meetingId: 'meeting-1',
          category: 'information',
          topic: 'Mixpanel Reporting',
          title: 'Mixpanel events are noisy',
          content:
            'Reporting in Mixpanel is noisy because event tracking includes too many plan switches.',
          assignee: null,
          deadline: null,
          sourceStartMs: 0,
          sourceEndMs: 0
        },
        {
          id: 'i5',
          meetingId: 'meeting-1',
          category: 'information',
          topic: 'Mixpanel Configuration',
          title: 'Current Mixpanel setup has limitations',
          content: 'The current Mixpanel configuration makes event analysis less precise.',
          assignee: null,
          deadline: null,
          sourceStartMs: 0,
          sourceEndMs: 0
        },
        {
          id: 'i6',
          meetingId: 'meeting-1',
          category: 'information',
          topic: 'Mixpanel Event Quality',
          title: 'Event-based workflows are hard to measure',
          content:
            'Mixpanel cannot cleanly represent some event-based workflows, which hurts reporting quality.',
          assignee: null,
          deadline: null,
          sourceStartMs: 0,
          sourceEndMs: 0
        },
        {
          id: 'i7',
          meetingId: 'meeting-1',
          category: 'information',
          topic: 'Open Source Packaging',
          title: 'Open source user groups differ',
          content: 'Some users customize the code while a larger group mainly values transparency.',
          assignee: null,
          deadline: null,
          sourceStartMs: 0,
          sourceEndMs: 0
        }
      ],
      discussion: [],
      statusUpdates: []
    }

    ;(provider as any).normalizeMergedTopics(segments)

    const uniqueTopics = new Set(segments.information.map((item) => item.topic))
    expect(uniqueTopics.size).toBeLessThanOrEqual(3)
    expect(segments.information[0].topic).toBe(segments.information[1].topic)
    expect(segments.information[1].topic).toBe(segments.information[2].topic)
    expect(segments.information[3].topic).toBe(segments.information[4].topic)
    expect(segments.information[4].topic).toBe(segments.information[5].topic)
    expect(segments.information[6].topic).toBe('Open Source Packaging')
  })

  it('uses macOS notes tuning with quality-preserving chunking', () => {
    const tunedProvider = new OllamaProvider('http://localhost:11434', 'test-model')
    const longTranscript = Array.from(
      { length: 9 },
      (_, index) => `[0${index}:00] [Speaker] ${'planning '.repeat(110)}`
    ).join('\n')

    const chunks = (tunedProvider as any).chunkTranscript(longTranscript) as string[]
    const systemPrompt = (tunedProvider as any).getSystemPrompt() as string

    if (process.platform === 'darwin') {
      expect(chunks).toHaveLength(3)
      expect(systemPrompt).toContain('You extract high-signal meeting notes')
      expect(systemPrompt).toContain('Spoken digit sequences are plain labels or numbers')

      tunedProvider.setLowMemoryMode(true)
      expect((tunedProvider as any).chunkTranscript(longTranscript)).toHaveLength(3)
      return
    }

    if (process.platform === 'win32') {
      expect(chunks).toHaveLength(3)
      expect(systemPrompt).toContain('[title, content, s, e]')
      expect(systemPrompt).not.toContain('MAC QUALITY TUNING OVERRIDE')

      tunedProvider.setLowMemoryMode(true)
      expect((tunedProvider as any).chunkTranscript(longTranscript)).toHaveLength(3)
      return
    }

    expect(chunks).toHaveLength(3)
    expect(systemPrompt).not.toContain('You extract high-signal meeting notes')
  })

  it('caps the writer context for small-VRAM Vulkan GPUs and restores it after', () => {
    setPlatform('win32')
    const vramProvider = new OllamaProvider('http://localhost:11434', 'test-model')
    ;(vramProvider as any).contextProfile = 'windows-balanced'
    ;(vramProvider as any).contextTokens = 8192

    vramProvider.setVramConstrainedContext(true)
    expect((vramProvider as any).contextProfile).toBe('windows-vulkan')
    expect((vramProvider as any).contextTokens).toBe(4096)

    vramProvider.setVramConstrainedContext(true)
    expect((vramProvider as any).contextTokens).toBe(4096)

    vramProvider.setVramConstrainedContext(false)
    expect((vramProvider as any).contextProfile).not.toBe('windows-vulkan')
  })

  it('caps the writer context on Windows CPU and does not change macOS', () => {
    const cpuProvider = new OllamaProvider('http://localhost:11434', 'test-model')
    ;(cpuProvider as any).contextProfile = 'windows-balanced'
    ;(cpuProvider as any).contextTokens = 8192

    setPlatform('win32')
    cpuProvider.setVramConstrainedContext(true, 'windows-cpu')
    expect((cpuProvider as any).contextProfile).toBe('windows-cpu')
    expect((cpuProvider as any).contextTokens).toBe(4096)

    setPlatform('darwin')
    const macProvider = new OllamaProvider('http://localhost:11434', 'test-model')
    macProvider.setVramConstrainedContext(true, 'windows-cpu')
    expect((macProvider as any).contextProfile).toBe('mac-balanced')
    expect((macProvider as any).contextTokens).toBe(MAC_CONTEXT_TOKENS)
  })

  it('does not override an existing low-memory context when VRAM-constrained', () => {
    const vramProvider = new OllamaProvider('http://localhost:11434', 'test-model')
    vramProvider.setLowMemoryMode(true)

    vramProvider.setVramConstrainedContext(true)
    expect((vramProvider as any).contextProfile).toBe('low-memory')
    expect((vramProvider as any).contextTokens).toBe(4096)

    vramProvider.setVramConstrainedContext(false)
    expect((vramProvider as any).contextProfile).toBe('low-memory')
  })

  it('can request Ollama to unload the resident model after local notes work', async () => {
    const releaseProvider = new OllamaProvider('http://localhost:11434', 'test-model')
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await releaseProvider.releaseResources('meeting-1')

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:11434/api/generate',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ model: 'test-model', keep_alive: 0 })
      })
    )
    expect(mocks.logAutodocEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        area: 'segmentation',
        message: 'ollama model unload requested',
        meetingId: 'meeting-1'
      })
    )
  })

  it('keeps the majority organic topic instead of rewriting it onto a canned family', () => {
    const tunedProvider = new OllamaProvider('http://localhost:11434', 'test-model')
    const canonical = (tunedProvider as any).pickCanonicalTopic({
      segments: [
        {
          topic: 'Nordic Keyboard',
          title: 'Accent keys fail in KMS',
          content: 'Circumflex and tilde do not work on the host PC during KMS.'
        },
        {
          topic: 'Nordic Keyboard',
          title: 'On-screen keyboard is the fallback',
          content: 'Sergio will try an emulator if the OSK is not enough.'
        },
        {
          topic: 'Feature Flag Audit',
          title: 'LaunchDarkly replacement spike',
          content: 'Several flags reverted after the 10% rollout.'
        }
      ],
      labelCounts: new Map([
        ['Nordic Keyboard', 2],
        ['Feature Flag Audit', 1]
      ])
    })

    expect(canonical).toBe('Nordic Keyboard')
  })

  it('does not teach the writer a canned topic taxonomy', () => {
    setPlatform('win32')
    const windowsPrompt = new OllamaProvider('http://localhost:11434', 'test-model') as any
    expect(windowsPrompt.getSystemPrompt()).not.toContain('GOOD topics')
    expect(windowsPrompt.getSystemPrompt()).not.toContain('Pricing & Costs')
    expect(windowsPrompt.getSystemPrompt()).not.toContain('Technical Architecture')

    setPlatform('darwin')
    const systemPrompt = (
      new OllamaProvider('http://localhost:11434', 'test-model') as any
    ).getSystemPrompt() as string
    expect(systemPrompt).not.toContain('GOOD topics')
    expect(systemPrompt).not.toContain('Pricing & Costs')
    expect(systemPrompt).not.toContain('Technical Architecture')
    expect(systemPrompt).not.toContain('Windows Tickets')
    expect(systemPrompt).toContain('broad meeting-specific topics')
  })

  it('encodes Mac writer clocks as local line IDs without losing their millisecond mapping', () => {
    const encoded = encodeMacNotesLineReferences(
      [
        '[00:49.858] [me] Build 443 is barely behind on Mac.',
        '[01:04.898] [me] Trial starts are better on 443 than 435.',
        'un-timestamped context'
      ].join('\n')
    )

    expect(encoded.promptTranscript).toBe(
      [
        '[L1] [me] Build 443 is barely behind on Mac.',
        '[L2] [me] Trial starts are better on 443 than 435.',
        'un-timestamped context'
      ].join('\n')
    )
    expect([...encoded.startMsByLineId]).toEqual([
      [1, 49_858],
      [2, 64_898]
    ])
  })

  it('maps Mac line-ID citations back to transcript milliseconds', async () => {
    setPlatform('darwin')
    const requestBodies: Array<{ messages?: Array<{ role: string; content: string }> }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init?: RequestInit) => {
        requestBodies.push(JSON.parse(String(init?.body ?? '{}')))
        return makeOllamaContentResponse(
          JSON.stringify({
            decisions: [],
            action_items: [],
            information: [
              {
                t: 'Release',
                h: 'Feature flag ready',
                c: 'The feature flag is ready.',
                s: 1,
                e: 1
              },
              {
                t: 'Release',
                h: 'Feature flag ships after QA',
                c: 'The feature flag will ship after QA.',
                s: 2,
                e: 2
              }
            ],
            discussion: [],
            status_updates: []
          })
        )
      })
    )

    const macProvider = new OllamaProvider('http://localhost:11434', 'test-model')
    const result = await macProvider.summarize(
      'meeting-mac-line-refs',
      ['[10:00] [them] The feature flag is ready.', '[10:05] [them] It will ship after QA.'].join(
        '\n'
      ),
      undefined,
      11
    )

    expect(requestBodies[0].messages?.[1]?.content).toContain('[L1] [them]')
    expect(requestBodies[0].messages?.[1]?.content).not.toContain('[10:00]')
    expect(requestBodies[0].messages?.[0]?.content).toContain('"information"')
    expect(result.information[0]).toMatchObject({
      sourceStartMs: 600_000,
      sourceEndMs: 600_000
    })
    expect(result.information[1]).toMatchObject({
      sourceStartMs: 600_000,
      sourceEndMs: 605_000
    })
  })

  it('carries grounded action-title context through Mac parsing without replacing the canonical record', () => {
    setPlatform('darwin')
    const provider = new OllamaProvider('http://localhost:11434', 'test-model')
    const transcript = [
      '[00:01] [them] The authentication API contract needs a review.',
      "[00:05] [me] I'll review it tomorrow."
    ].join('\n')
    const references = encodeMacNotesLineReferences(transcript)
    const parsed = (provider as any).parseResponseWithStats(
      'meeting-context',
      JSON.stringify({ action_items: [{ h: 'Review the authentication API contract',
        c: "I'll review it tomorrow.", s: 1, e: 2 }] }),
      undefined, 60_000,
      (provider as any).extractTimestampsMs(transcript),
      (provider as any).parseTranscriptLines(transcript), references.startMsByLineId
    )
    const saved = JSON.parse(JSON.stringify(parsed.segments))
    expect(saved.actionItems).toHaveLength(1)
    expect(saved.actionItems[0]).toMatchObject({
      title: "I'll review it tomorrow.", content: "I'll review it tomorrow.",
      sourceStartMs: 5000, sourceEndMs: 5000,
      actionContext: { title: 'Review the authentication API contract', sourceStartMs: 1000, sourceEndMs: 5000 }
    })
  })

  it('does not retain rejected action drafts while Next Steps are hidden', () => {
    const provider = new OllamaProvider('http://localhost:11434', 'test-model')
    const transcript = [
      '[00:01] [them] Mac testing is still in progress.',
      "[00:05] [them] I will ping Jordan to see where we're at."
    ].join('\n')
    const references = encodeMacNotesLineReferences(transcript)
    const parse = () => (provider as any).parseResponseWithStats(
      'meeting-draft',
      JSON.stringify({ action_items: [{ h: 'Check Mac testing',
        c: 'I will ping Jordan to see where Mac testing is at.', s: 2, e: 2 }] }),
      undefined, 60_000,
      (provider as any).extractTimestampsMs(transcript),
      (provider as any).parseTranscriptLines(transcript), references.startMsByLineId
    )
    setPlatform('darwin')
    const mac = parse()
    expect(mac.segments.actionItems).toEqual([])
    expect(mac.segments.nextStepCandidates).toBeUndefined()
    expect(mac.acceptedItemCount).toBe(0)
    setPlatform('win32')
    const windows = parse()
    expect(windows.segments.actionItems).toEqual([])
    expect(windows.segments.nextStepCandidates).toBeUndefined()
  })

  it('drops unknown or malformed Mac line-ID citations instead of snapping them', () => {
    setPlatform('darwin')
    const provider = new OllamaProvider('http://localhost:11434', 'test-model')
    const transcript = '[10:00] [them] The feature flag is ready.'
    const references = encodeMacNotesLineReferences(transcript)
    const parsed = (provider as any).parseResponseWithStats(
      'meeting-invalid-line-refs',
      JSON.stringify({
        decisions: [],
        action_items: [],
        information: [
          {
            t: 'Release',
            h: 'Unknown citation',
            c: 'The feature flag is ready.',
            s: 999,
            e: 999
          },
          {
            t: 'Release',
            h: 'Malformed citation',
            c: 'The feature flag is ready.',
            s: 'L1',
            e: 'L1'
          }
        ],
        discussion: [],
        status_updates: []
      }),
      undefined,
      660_000,
      (provider as any).extractTimestampsMs(transcript),
      (provider as any).parseTranscriptLines(transcript),
      references.startMsByLineId
    )

    expect(parsed.segments.information).toEqual([])
    expect(
      parsed.drops.filter((drop: { reason: string }) => drop.reason === 'invalid_citation')
    ).toHaveLength(2)
  })

  it("keeps grounded clauses and rejects the exported meeting writer's false metric bindings", () => {
    setPlatform('darwin')
    const fixtureProvider = new OllamaProvider('http://localhost:11434', 'test-model')
    const transcript = [
      '[00:49] [me] win windows, it is just barely. With Mac, four four three is behind, but just barely. The numbers are coming together.',
      '[01:04] [me] Trial starts on four four are better than 435 on both.',
      '[01:43] [them] Especially on Mac, yesterday there was twelve.',
      '[01:52] [them] On the new version.',
      '[01:54] [them] Windows converged more today, but yesterday was five percent more.',
      '[02:03] [them] I think that had an effect on the cancellation rate.',
      '[02:11] [them] The higher cancel rate is going to be.',
      '[02:14] [them] But still a gain in the long run.',
      '[04:15] [them] You can see here it is like a twenty-five percent increase.',
      '[04:23] [me] Money overall is good.',
      '[04:35] [me] You want that country.',
      '[04:54] [me] We do not want lifetime to cannibalize one to feed the other.',
      '[05:04] [them] The North Star is the revenue of the company.',
      '[05:14] [them] Move one subscriber to lifetime if they would not stick around.',
      '[05:20] [them] We want to do that because we will make more.'
    ].join('\n')
    const lineMap = new Map([
      [4, 49_000],
      [6, 72_000],
      [9, 86_000],
      [14, 103_000],
      [18, 114_000],
      [22, 127_000],
      [25, 134_000],
      [55, 255_000],
      [61, 275_000],
      [67, 294_000],
      [71, 320_000]
    ])
    const raw = JSON.stringify({
      information: [
        {
          t: 'trial_start_trend',
          h: 'Windows vs Mac trial starts',
          c: 'Trial starts on 443 are better than 435 on Blues, with Mac showing a slight gap closing',
          s: 4,
          e: 6
        },
        {
          t: 'cancellation_behavior',
          h: 'version-specific cancellation patterns',
          c: 'Cancellation rates are higher on the older version, with new version showing reduced cancellation and a 25% increase in converted trial numbers',
          s: 14,
          e: 25
        },
        {
          t: 'platform_performance',
          h: 'Mac and Windows performance comparison',
          c: 'On Mac, 443 is behind but only barely; on Windows, trial start trend is stronger and converging',
          s: 4,
          e: 9
        },
        {
          t: 'conversion_trend',
          h: 'long-term trial conversion impact',
          c: 'Long-term trial start numbers are increasing, with a 25% increase in converted trial numbers observed on the new version',
          s: 55,
          e: 61
        },
        {
          t: 'revenue_strategy',
          h: 'lifetime vs subscription balance',
          c: 'The goal is to maximize revenue without cannibalizing between lifetime and subscription models',
          s: 67,
          e: 71
        },
        {
          t: 'version_stability',
          h: 'Wtenant and AU performance',
          c: 'AU performance is converged today, with a 5% higher performance yesterday',
          s: 18,
          e: 22
        }
      ],
      action_items: [],
      decisions: [],
      discussion: [],
      status_updates: []
    })

    const parsed = (fixtureProvider as any).parseResponseWithStats(
      'fixture-meeting',
      raw,
      undefined,
      330_000,
      (fixtureProvider as any).extractTimestampsMs(transcript),
      (fixtureProvider as any).parseTranscriptLines(transcript),
      lineMap
    )

    expect(parsed.segments.information.map((item: Segment) => item.content)).toEqual([
      'On Mac, 443 is behind but only barely',
      'The goal is to maximize revenue without cannibalizing between lifetime and subscription models'
    ])
    const rendered = JSON.stringify(parsed.segments)
    expect(rendered).not.toMatch(/5%|25%|reduced cancellation|older version/i)
  })

  it('leaves meeting-specific topics alone after merge', () => {
    const tunedProvider = new OllamaProvider('http://localhost:11434', 'test-model')
    const segments = {
      decisions: [
        {
          id: 'd1',
          meetingId: 'm1',
          category: 'decision',
          topic: 'Nordic Keyboard',
          title: 'Try on-screen keyboard first',
          content: 'Reproduce the missing accent keys without extra hardware.',
          assignee: null,
          deadline: null,
          sourceStartMs: 0,
          sourceEndMs: 0
        }
      ],
      actionItems: [],
      information: [],
      discussion: [],
      statusUpdates: []
    }

    ;(tunedProvider as any).normalizeMergedTopics(segments)

    expect(segments.decisions[0].topic).toBe('Nordic Keyboard')
    expect(typeof (tunedProvider as any).consolidateMacTopicFamilies).toBe('undefined')
  })

  it('stores ordered timestamp ranges for macOS notes', () => {
    setPlatform('darwin')
    const tunedProvider = new OllamaProvider('http://localhost:11434', 'test-model')
    const transcript = [
      '[10:00] [Speaker] The team discussed the release plan.',
      '[10:05] [Speaker] QA should finish testing today.'
    ].join('\n')

    const result = (tunedProvider as any).parseResponse(
      'meeting-1',
      JSON.stringify({
        decisions: [
          {
            topic: 'Release Planning',
            title: 'Release plan confirmed',
            content: 'The team discussed the release plan and testing status.',
            sourceStartMs: 605_000,
            sourceEndMs: 600_000
          }
        ],
        action_items: [],
        information: [],
        discussion: [],
        status_updates: []
      }),
      undefined,
      700_000,
      (tunedProvider as any).extractTimestampsMs(transcript),
      (tunedProvider as any).parseTranscriptLines(transcript)
    )

    if (process.platform === 'darwin' || process.platform === 'win32') {
      expect(result.decisions[0].sourceStartMs).toBe(600_000)
      expect(result.decisions[0].sourceEndMs).toBe(605_000)
      return
    }

    expect(result.decisions[0].sourceStartMs).toBe(605_000)
    expect(result.decisions[0].sourceEndMs).toBe(600_000)
  })

  it('falls back to a smaller Ollama context after an insufficient RAM response', async () => {
    const telemetry = vi.fn()
    const adaptiveProvider = new OllamaProvider('http://localhost:11434', 'test-model', {
      onTelemetry: telemetry
    })
    const requestContextTokens: number[] = []

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { options?: { num_ctx?: number } }
        requestContextTokens.push(body.options?.num_ctx ?? 0)

        if (requestContextTokens.length === 1) {
          return new Response(
            JSON.stringify({
              error: 'model requires more system memory (8.3 GiB) than is available (5.5 GiB)'
            }),
            { status: 500 }
          )
        }

        return new Response(
          new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder()
              controller.enqueue(
                encoder.encode(
                  `${JSON.stringify({
                    message: {
                      content: JSON.stringify({
                        decisions: [],
                        action_items: [],
                        information: [
                          {
                            topic: 'Planning',
                            title: 'Launch plan confirmed',
                            content: 'The launch plan was confirmed for next week.',
                            sourceStartMs: 1,
                            sourceEndMs: 1
                          }
                        ],
                        discussion: [],
                        status_updates: []
                      })
                    }
                  })}\n`
                )
              )
              controller.close()
            }
          }),
          { status: 200 }
        )
      })
    )

    const result = await adaptiveProvider.summarize(
      'meeting-low-ram',
      '[00:00] [Chris] The launch plan was confirmed for next week.',
      undefined,
      5
    )

    expect(result.information).toHaveLength(1)
    const initialContextTokens =
      process.platform === 'win32'
        ? WINDOWS_CONTEXT_TOKENS
        : process.platform === 'darwin'
          ? MAC_CONTEXT_TOKENS
          : STANDARD_CONTEXT_TOKENS
    if (initialContextTokens > LOW_MEMORY_CONTEXT_TOKENS) {
      expect(requestContextTokens).toEqual([initialContextTokens, LOW_MEMORY_CONTEXT_TOKENS])
      expect(telemetry).toHaveBeenCalledWith(
        expect.objectContaining({
          meetingId: 'meeting-low-ram',
          event: 'ollama_low_memory_fallback_triggered',
          properties: expect.objectContaining({
            ollamaRequiredSystemMemoryGiB: 8.3,
            ollamaAvailableSystemMemoryGiB: 5.5
          })
        })
      )
      expect(telemetry).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'ollama_low_memory_fallback_succeeded'
        })
      )
    } else {
      expect(requestContextTokens).toEqual([initialContextTokens, initialContextTokens])
      expect(telemetry).not.toHaveBeenCalled()
    }
    expect(mocks.logAutodocEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: 'notes llm chunk skipped' })
    )
    expect(adaptiveProvider.getLastWriterSkips()).toEqual([])
  })

  it('falls back to a smaller Ollama context after a runner-stop 500 on a low-memory host', async () => {
    const telemetry = vi.fn()
    const adaptiveProvider = new OllamaProvider('http://localhost:11434', 'test-model', {
      onTelemetry: telemetry
    })
    const requestContextTokens: number[] = []
    ;(adaptiveProvider as any).getHostMemorySnapshot = () => ({ freeGiB: 0.66, totalGiB: 8 })

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { options?: { num_ctx?: number } }
        requestContextTokens.push(body.options?.num_ctx ?? 0)

        if (requestContextTokens.length === 1) {
          return new Response('{"error":"model runner has unexpectedly stopped"}', { status: 500 })
        }

        return new Response(
          new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder()
              controller.enqueue(
                encoder.encode(
                  `${JSON.stringify({
                    message: {
                      content: JSON.stringify({
                        decisions: [],
                        action_items: [],
                        information: [
                          {
                            topic: 'Planning',
                            title: 'Launch plan confirmed',
                            content: 'The launch plan was confirmed for next week.',
                            sourceStartMs: 1,
                            sourceEndMs: 1
                          }
                        ],
                        discussion: [],
                        status_updates: []
                      })
                    }
                  })}\n`
                )
              )
              controller.close()
            }
          }),
          { status: 200 }
        )
      })
    )

    const result = await adaptiveProvider.summarize(
      'meeting-low-ram-generic-500',
      '[00:00] [Chris] The launch plan was confirmed for next week.',
      undefined,
      5
    )

    expect(result.information).toHaveLength(1)
    const initialContextTokens =
      process.platform === 'win32'
        ? WINDOWS_CONTEXT_TOKENS
        : process.platform === 'darwin'
          ? MAC_CONTEXT_TOKENS
          : STANDARD_CONTEXT_TOKENS
    if (initialContextTokens > LOW_MEMORY_CONTEXT_TOKENS) {
      expect(requestContextTokens).toEqual([initialContextTokens, LOW_MEMORY_CONTEXT_TOKENS])
      expect(telemetry).toHaveBeenCalledWith(
        expect.objectContaining({
          meetingId: 'meeting-low-ram-generic-500',
          event: 'ollama_low_memory_fallback_triggered',
          properties: expect.objectContaining({
            hostFreeMemoryGiB: 0.66,
            hostTotalMemoryGiB: 8
          })
        })
      )
      expect(telemetry).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'ollama_low_memory_fallback_succeeded'
        })
      )
    } else {
      expect(requestContextTokens).toEqual([initialContextTokens, initialContextTokens])
      expect(telemetry).not.toHaveBeenCalled()
    }
    expect(mocks.logAutodocEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: 'notes llm chunk skipped' })
    )
    expect(adaptiveProvider.getLastWriterSkips()).toEqual([])
  })

  it('does not force low-memory fallback for a runner-stop 500 on a healthy host', async () => {
    const telemetry = vi.fn()
    const adaptiveProvider = new OllamaProvider('http://localhost:11434', 'test-model', {
      onTelemetry: telemetry
    })
    const requestContextTokens: number[] = []
    ;(adaptiveProvider as any).getHostMemorySnapshot = () => ({ freeGiB: 12, totalGiB: 32 })

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { options?: { num_ctx?: number } }
        requestContextTokens.push(body.options?.num_ctx ?? 0)
        return new Response('{"error":"model runner has unexpectedly stopped"}', { status: 500 })
      })
    )

    await expect(
      adaptiveProvider.summarize(
        'meeting-healthy-host-generic-500',
        '[00:00] [Chris] The launch plan was confirmed for next week.',
        undefined,
        5
      )
    ).rejects.toThrow('model runner has unexpectedly stopped')

    expect(requestContextTokens).toEqual([
      process.platform === 'win32'
        ? WINDOWS_CONTEXT_TOKENS
        : process.platform === 'darwin'
          ? MAC_CONTEXT_TOKENS
          : STANDARD_CONTEXT_TOKENS,
      process.platform === 'win32'
        ? WINDOWS_CONTEXT_TOKENS
        : process.platform === 'darwin'
          ? MAC_CONTEXT_TOKENS
          : STANDARD_CONTEXT_TOKENS,
      process.platform === 'win32'
        ? WINDOWS_CONTEXT_TOKENS
        : process.platform === 'darwin'
          ? MAC_CONTEXT_TOKENS
          : STANDARD_CONTEXT_TOKENS
    ])
    expect(telemetry).not.toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'ollama_low_memory_fallback_triggered'
      })
    )
  })

  it('preserves assignee and deadline from model JSON in parseResponse', () => {
    const transcript = '[00:00] [Speaker] Chris will own the billing API migration by Friday.'

    const result = (provider as any).parseResponse(
      'meeting-1',
      JSON.stringify({
        decisions: [],
        action_items: [
          {
            topic: 'Billing API',
            title: 'Prepare billing API migration',
            content: 'Chris will own the billing API migration by Friday.',
            assignee: 'Chris',
            deadline: 'Friday',
            sourceStartMs: 0,
            sourceEndMs: 0
          }
        ],
        information: [],
        discussion: [],
        status_updates: []
      }),
      undefined,
      5_000,
      (provider as any).extractTimestampsMs(transcript),
      (provider as any).parseTranscriptLines(transcript)
    )

    expect(result.actionItems).toHaveLength(1)
    expect(result.actionItems[0].assignee).toBe('Chris')
    expect(result.actionItems[0].deadline).toBe('Friday')
  })

  it('uses the tight Windows writer schema and 768-token budget', async () => {
    setPlatform('win32')
    const windowsProvider = new OllamaProvider('http://localhost:11434', 'test-model')
    expect((windowsProvider as any).getNotesResponseFormat()).toBe('json')
    expect((windowsProvider as any).getMaxOutputTokens()).toBe(WINDOWS_TIGHT_MAX_OUTPUT_TOKENS)
    expect((windowsProvider as any).getChunkChars()).toBe(4000)

    const requestBodies: Array<{
      format?: unknown
      messages?: Array<{ role: string; content: string }>
      options?: {
        num_predict?: number
        repeat_penalty?: number
        num_gpu?: number
        num_thread?: number
      }
    }> = []

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init?: RequestInit) => {
        requestBodies.push(JSON.parse(String(init?.body ?? '{}')))

        return new Response(
          new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder()
              controller.enqueue(
                encoder.encode(
                  `${JSON.stringify({
                    message: {
                      content: JSON.stringify({
                        decisions: [],
                        action_items: [],
                        information: [
                          {
                            topic: 'Windows Performance',
                            title: 'CPU notes path was optimized',
                            content:
                              'The Windows notes generation path now uses the shared V2 writer.',
                            sourceStartMs: 0,
                            sourceEndMs: 0
                          }
                        ],
                        discussion: [],
                        status_updates: []
                      })
                    }
                  })}\n`
                )
              )
              controller.close()
            }
          }),
          { status: 200 }
        )
      })
    )

    const result = await windowsProvider.summarize(
      'meeting-windows-schema',
      '[00:00] [Chris] The Windows notes generation path now uses the shared V2 writer.',
      undefined,
      5
    )

    expect(result.information).toHaveLength(1)
    expect(requestBodies[0].format).toBe('json')
    expect(requestBodies[0].options?.num_predict).toBe(WINDOWS_TIGHT_MAX_OUTPUT_TOKENS)
    expect(requestBodies[0].options?.repeat_penalty).toBe(1.05)
    expect(requestBodies[0].options).not.toHaveProperty('num_gpu')
    expect(requestBodies[0].options).not.toHaveProperty('num_thread')
    expect(requestBodies[0].messages?.[0]?.content).toContain('[title, content, s, e]')
    expect(requestBodies[0].messages?.[0]?.content).not.toContain('MAC QUALITY TUNING OVERRIDE')
  })

  it('injects benchmark num_gpu and num_thread only when setBenchmarkOptions is set', async () => {
    setPlatform('win32')
    const provider = new OllamaProvider('http://localhost:11434', 'test-model')
    provider.setBenchmarkOptions({ numGpu: 0, numThread: 8 })

    const requestBodies: Array<{ options?: { num_gpu?: number; num_thread?: number } }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init?: RequestInit) => {
        requestBodies.push(JSON.parse(String(init?.body ?? '{}')))
        return new Response(
          new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder()
              controller.enqueue(
                encoder.encode(
                  `${JSON.stringify({
                    message: {
                      content: JSON.stringify({
                        decisions: [],
                        action_items: [],
                        information: [],
                        discussion: [],
                        status_updates: []
                      })
                    }
                  })}\n`
                )
              )
              controller.close()
            }
          }),
          { status: 200 }
        )
      })
    )

    await provider.summarize(
      'meeting-benchmark-options',
      '[00:00] [Chris] Benchmark CPU placement should force num_gpu 0.',
      undefined,
      5
    )

    expect(requestBodies[0].options?.num_gpu).toBe(0)
    expect(requestBodies[0].options?.num_thread).toBe(8)
  })

  it('forces num_gpu 0 when the writer profile is windows-cpu', async () => {
    setPlatform('win32')
    const provider = new OllamaProvider('http://localhost:11434', 'test-model')
    provider.setVramConstrainedContext(true, 'windows-cpu')

    const requestBodies: Array<{ options?: { num_gpu?: number } }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init?: RequestInit) => {
        requestBodies.push(JSON.parse(String(init?.body ?? '{}')))
        return new Response(
          new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder()
              controller.enqueue(
                encoder.encode(
                  `${JSON.stringify({
                    message: {
                      content: JSON.stringify({
                        decisions: [],
                        action_items: [],
                        information: [],
                        discussion: [],
                        status_updates: []
                      })
                    }
                  })}\n`
                )
              )
              controller.close()
            }
          }),
          { status: 200 }
        )
      })
    )

    await provider.summarize(
      'meeting-windows-cpu-num-gpu',
      '[00:00] [Chris] Windows CPU notes should keep layers on the host.',
      undefined,
      5
    )

    expect(requestBodies[0].options?.num_gpu).toBe(0)
  })

  it('classifies Run A llama-server 500s as transient and ignores parse errors', () => {
    expect(
      isTransientOllamaRuntimeError(
        'Ollama returned 500: {"error":"llama-server process has terminated: exit status 0xe06d7363: NTSTATUS 0xe06d7363"}'
      )
    ).toBe(true)
    expect(isTransientOllamaRuntimeError('model runner has unexpectedly stopped')).toBe(true)
    expect(isTransientOllamaRuntimeError('fetch failed')).toBe(true)
    expect(isTransientOllamaRuntimeError('Invalid JSON from Ollama')).toBe(false)
    expect(isTransientOllamaRuntimeError('Unexpected token } in JSON at position 12')).toBe(false)
  })

  it('keeps low-memory context when setLowMemoryMode(false) runs on a low-RAM Windows host', () => {
    setPlatform('win32')
    const lowRamProvider = new OllamaProvider('http://localhost:11434', 'test-model')
    ;(lowRamProvider as any).getHostMemorySnapshot = () => ({ freeGiB: 2.5, totalGiB: 7.77 })

    lowRamProvider.setLowMemoryMode(false)

    expect((lowRamProvider as any).contextProfile).toBe('low-memory')
    expect((lowRamProvider as any).contextTokens).toBe(LOW_MEMORY_CONTEXT_TOKENS)
  })

  it('uses windows-balanced context when setLowMemoryMode(false) runs on a high-RAM Windows host', () => {
    setPlatform('win32')
    const highRamProvider = new OllamaProvider('http://localhost:11434', 'test-model')
    ;(highRamProvider as any).getHostMemorySnapshot = () => ({ freeGiB: 16, totalGiB: 32 })

    highRamProvider.setLowMemoryMode(false)

    expect((highRamProvider as any).contextProfile).toBe('windows-balanced')
    expect((highRamProvider as any).contextTokens).toBe(WINDOWS_CONTEXT_TOKENS)
  })

  describe('Windows near-duplicate item dedup', () => {
    const provider = new OllamaProvider('http://localhost:11434', 'test-model')

    it('leaves writer items intact on Windows so scan matches macOS', () => {
      setPlatform('win32')
      const segments = makeSegments({
        information: [
          makeSegment({
            id: 'i1',
            category: 'information',
            title: 'Autopilot timeline confirmed',
            content: 'Hands-off driving expected in two years.'
          })
        ],
        discussion: [
          makeSegment({
            id: 'd1',
            category: 'discussion',
            title: 'Autopilot timeline confirmed',
            content: 'The team debated the two-year autopilot timeline.'
          })
        ]
      })

      ;(provider as any).dedupeNearDuplicateItems(segments)

      expect(segments.information).toHaveLength(1)
      expect(segments.discussion).toHaveLength(1)
    })

    it('does not collapse near-duplicate titles on Windows', () => {
      setPlatform('win32')
      const segments = makeSegments({
        information: [
          makeSegment({
            id: 'i1',
            category: 'information',
            title: 'Autopilot Expected in Two Years for Hands-Off Driving Capability',
            content: 'Hands-off driving is expected in about two years.'
          }),
          makeSegment({
            id: 'i2',
            category: 'information',
            title:
              'Autopilot Expected in Two Years for Hands-Off Driving Capability with Crash Rate of One-in-a-Thousand or Less',
            content:
              'Hands-off driving is expected in about two years with a projected crash rate of one in a thousand or less, including additional safety context.'
          })
        ]
      })

      ;(provider as any).dedupeNearDuplicateItems(segments)

      expect(segments.information).toHaveLength(2)
    })

    it('does not collapse cross-category near-duplicates on Windows', () => {
      setPlatform('win32')
      const segments = makeSegments({
        decisions: [
          makeSegment({
            id: 'd1',
            category: 'decision',
            title: 'Ship billing API migration before launch',
            content: 'Approved.',
            sourceStartMs: 60_000,
            sourceEndMs: 90_000
          })
        ],
        actionItems: [
          makeSegment({
            id: 'a1',
            category: 'action_item',
            title: 'Ship billing API migration before launch next quarter',
            content:
              'Chris will migrate the billing API before launch next quarter and document the rollout plan.',
            sourceStartMs: 60_000,
            sourceEndMs: 180_000
          })
        ]
      })

      ;(provider as any).dedupeNearDuplicateItems(segments)

      expect(segments.decisions).toHaveLength(1)
      expect(segments.actionItems).toHaveLength(1)
    })

    it('does not dedupe near-duplicate items on macOS', () => {
      setPlatform('darwin')
      const segments = makeSegments({
        information: [
          makeSegment({
            id: 'i1',
            category: 'information',
            title: 'Autopilot Expected in Two Years for Hands-Off Driving Capability',
            content: 'Hands-off driving is expected in about two years.'
          }),
          makeSegment({
            id: 'i2',
            category: 'information',
            title:
              'Autopilot Expected in Two Years for Hands-Off Driving Capability with Crash Rate of One-in-a-Thousand or Less',
            content:
              'Hands-off driving is expected in about two years with a projected crash rate of one in a thousand or less.'
          })
        ]
      })

      ;(provider as any).dedupeNearDuplicateItems(segments)

      expect(segments.information).toHaveLength(2)
    })
  })

  describe('platform writer prompt and chunk label guidance', () => {
    it('selects Mac notes category-neutrally and keeps claims on contiguous evidence', () => {
      setPlatform('darwin')
      const macProvider = new OllamaProvider('http://localhost:11434', 'test-model')
      const systemPrompt = (macProvider as any).getSystemPrompt() as string
      const label = (macProvider as any).buildChunkLabel(
        1,
        3,
        'Target a focused final note set around 40-55 total items.',
        ['Experiment Rollout']
      ) as string
      const singleChunkLabel = (macProvider as any).buildChunkLabel(
        0,
        1,
        'Target a focused final note set around 40-55 total items.',
        []
      ) as string
      expect(systemPrompt).toContain('Category does not affect priority')
      expect(systemPrompt).toContain(
        'Always keep a clear explicit request, assignment, or first-person commitment before lower-value information'
      )
      expect(systemPrompt).toContain('Most sections have no decision or action item')
      expect(systemPrompt).toContain('one claim from one cited contiguous span')
      expect(label).toContain('At most 6 records')
      expect(label).toContain('Keep cited requests/commitments')
      expect(label).toContain('one claim from one contiguous cited span')
      expect(systemPrompt).toContain('Before returning JSON, verify that every selected number')
      expect(label).not.toContain('Before JSON')
      expect(label).toContain('Experiment Rollout')
      expect(singleChunkLabel).not.toContain('40-55')
      expect(singleChunkLabel).toContain('Keep cited requests/commitments')
      // Leave enough of the 4K context for a complete six-record response.
      expect(systemPrompt.length).toBeLessThanOrEqual(5_000)
      expect(label.length).toBeLessThanOrEqual(360)
    })

    it('uses me and them as Mac source labels without claiming diarization', () => {
      setPlatform('darwin')
      const macProvider = new OllamaProvider('http://localhost:11434', 'test-model')
      const systemPrompt = (macProvider as any).getSystemPrompt() as string

      expect(systemPrompt).toContain('SPEAKER SOURCE (not diarization)')
      expect(systemPrompt).toContain('[me] explicit first-person commitment: assignee may be "Me"')
      expect(systemPrompt).toContain(
        '[them] first-person commitment: assignee stays null unless cited speech explicitly names a person'
      )
      expect(systemPrompt).toContain(
        'Named assignee only if that name occurs in cited assignment evidence'
      )
    })

    it('uses the tight writer guidance on later Windows chunks', () => {
      setPlatform('win32')
      const windowsProvider = new OllamaProvider('http://localhost:11434', 'test-model')
      const label = (windowsProvider as any).buildChunkLabel(
        1,
        3,
        'Target a focused final note set around 40-55 total items.',
        ['Product Planning']
      ) as string

      expect(label).toContain('at most 6 items')
      expect(label).not.toContain('Use broad reusable topic headings')
      expect(label).not.toContain('Product Planning')
    })

    it('keeps the Windows tight prompt and chunk label byte-for-byte unchanged', () => {
      setPlatform('win32')
      const windowsProvider = new OllamaProvider('http://localhost:11434', 'test-model')
      const systemPrompt = (windowsProvider as any).getSystemPrompt() as string
      const label = (windowsProvider as any).buildChunkLabel(
        1,
        3,
        'Target a focused final note set around 40-55 total items.',
        ['Product Planning']
      ) as string

      expect(createHash('sha256').update(systemPrompt).digest('hex')).toBe(
        '0de4d99f6e42a13eab92dd024b646d7652750d7fe59fdde6fcba743ce5aa876f'
      )
      expect(label).toBe(
        '\n\nThis is part 2 of 3 of the meeting. Strongest NEW notes only, at most 6 items. One fact in one category. Omit empty categories.'
      )
      expect(systemPrompt).not.toContain('Selection order when limited')
      expect(systemPrompt).not.toContain('[me]')
      expect(label).not.toContain('explicit requests, commitments, and assigned follow-ups')
    })

    it('uses the compact high-signal writer prompt on macOS', () => {
      setPlatform('darwin')
      const macProvider = new OllamaProvider('http://localhost:11434', 'test-model')
      const systemPrompt = (macProvider as any).getSystemPrompt() as string

      expect(systemPrompt).toContain('You extract high-signal meeting notes')
      expect(systemPrompt).toContain('at most 6 records total across the sum of all five arrays')
      expect(systemPrompt).toContain(
        'Preserve spoken product names, build labels, quantities, units, platforms'
      )
      expect(systemPrompt).toContain('Use semantic category keys: decisions, action_items')
      expect(systemPrompt).toContain('Record keys: t=topic')
      expect(systemPrompt).toContain(
        'Copy the IDs. Do not convert them into clocks or milliseconds'
      )
      expect((macProvider as any).getMaxOutputTokens()).toBe(MAC_MAX_OUTPUT_TOKENS)
    })

    it('uses the tight tuple prompt and omits topic reuse on Windows only', () => {
      setPlatform('win32')
      const windowsProvider = new OllamaProvider('http://localhost:11434', 'test-model')
      const systemPrompt = (windowsProvider as any).getSystemPrompt() as string
      const label = (windowsProvider as any).buildChunkLabel(
        1,
        3,
        'Target a focused final note set around 40-55 total items.',
        ['Product Planning']
      ) as string
      expect(systemPrompt).toContain('[title, content, s, e]')
      expect(systemPrompt).toContain('Keep exact numbers, names, versions, and dates')
      expect(systemPrompt).not.toContain('You extract high-signal meeting notes')
      expect(systemPrompt).not.toContain('GROUPING')
      expect(label).toContain('at most 6 items')
      expect(systemPrompt).toContain('At most 6 items')
      expect(label).not.toContain('Product Planning')
      expect(label).not.toContain('topic headings')
      expect((windowsProvider as any).getMaxOutputTokens()).toBe(WINDOWS_TIGHT_MAX_OUTPUT_TOKENS)
      expect((windowsProvider as any).getChunkChars()).toBe(4000)
      expect(systemPrompt).toContain('Target roughly 40-55 total final items')
      ;(windowsProvider as any).writerContinuation = true
      const continuationPrompt = (windowsProvider as any).getSystemPrompt() as string
      expect(continuationPrompt).toContain('[title, content, s, e]')
      expect(continuationPrompt).not.toContain('Target roughly 40-55 total final items')
      setPlatform('darwin')
      expect((windowsProvider as any).getChunkChars()).toBe(4000)
      expect((windowsProvider as any).getSystemPrompt()).toContain(
        'You extract high-signal meeting notes'
      )
      expect((windowsProvider as any).getMaxOutputTokens()).not.toBe(
        WINDOWS_TIGHT_MAX_OUTPUT_TOKENS
      )
      setPlatform('win32')
      expect(shouldSkipWindowsTightScanRewrites('win32')).toBe(true)
      expect(shouldSkipWindowsTightScanRewrites('darwin')).toBe(false)
      expect(shouldOmitWindowsTightResponseFormat('win32')).toBe(false)
      expect(shouldOmitWindowsTightResponseFormat('darwin')).toBe(false)
      expect(shouldAbsorbWindowsTightShortTail('win32')).toBe(false)
      const withTail = `${'a'.repeat(3900)}\n${'b'.repeat(200)}`
      expect((windowsProvider as any).chunkTranscript(withTail)).toHaveLength(2)
    })
  })
})

describe('formatNotesWriterTranscript', () => {
  afterEach(() => {
    setPlatform(originalPlatform)
    delete process.env.AUTODOC_TEST_NOTES_TIGHT
  })

  it('keeps speaker labels on Windows tight after speaker-omit was rejected', () => {
    const rows = [
      { startMs: 22_000, speaker: 'Matt', text: '14 starts and 6 cancellations' },
      { startMs: 3_661_000, speaker: 'Chris', text: 'one dot one dot three' }
    ]
    expect(formatNotesWriterTranscript(rows, false)).toBe(
      '[00:22] [Matt] 14 starts and 6 cancellations\n[01:01:01] [Chris] one dot one dot three'
    )

    setPlatform('win32')
    expect(shouldOmitWindowsTightSpeakerLabels('win32')).toBe(false)
    expect(formatNotesWriterTranscript(rows)).toBe(
      '[00:22] [Matt] 14 starts and 6 cancellations\n[01:01:01] [Chris] one dot one dot three'
    )
  })

  it('classifies ack-only lines but does not strip them after the v12 reject', () => {
    expect(isNotesWriterBackchannelOnly('yeah')).toBe(true)
    expect(isNotesWriterBackchannelOnly('Okay.')).toBe(true)
    expect(isNotesWriterBackchannelOnly('four three five is definitely higher')).toBe(false)
    expect(isNotesWriterBackchannelOnly('14 starts and 6 cancellations')).toBe(false)

    const rows = [
      { startMs: 1000, speaker: 'them', text: 'yeah' },
      { startMs: 2000, speaker: 'me', text: 'four three five is definitely higher' },
      { startMs: 3000, speaker: 'them', text: 'okay' }
    ]
    setPlatform('win32')
    expect(shouldStripWindowsTightBackchannel('win32')).toBe(false)
    expect(formatNotesWriterTranscript(rows)).toBe(
      '[00:01] [them] yeah\n[00:02] [me] four three five is definitely higher\n[00:03] [them] okay'
    )
  })

  it('keeps exact Mac row starts internally while Windows clocks stay byte-identical', () => {
    const rows = [{ startMs: 1_100, speaker: 'me', text: "I'll send the estimate." }]

    expect(formatNotesWriterTranscript(rows, false, 'darwin')).toBe(
      "[00:01.100] [me] I'll send the estimate."
    )
    expect(formatNotesWriterTranscript(rows, false, 'win32')).toBe(
      "[00:01] [me] I'll send the estimate."
    )
  })
})

describe('Windows tight writer stream cap', () => {
  afterEach(() => {
    delete process.env.AUTODOC_TEST_NOTES_TIGHT
  })

  it('counts finished tuples in truncated JSON and ignores the outer category array', () => {
    const partial =
      '{"i":[["14 starts","There are 14 starts and 6 cancellations.",22000,26000],["eight to sixteen","Raised RAM from 8 to 16 GB.",1061000,1071000],["four three five","Use the four-three-five build.",1419000,1429000],["one one three","Shipped one dot one dot three.",1040000,1049000],["fifth","Fifth fact.",1,2],["sixth","Sixth fact.",3,4],["seventh"'
    expect(countCompleteTightWriterItems(partial)).toBe(6)
    expect(countCompleteTightWriterItems('{"i":[["only","two fields"')).toBe(0)
  })

  it('counts title-content pairs so clockless 768 runaways still hit the cap', () => {
    const runaway = '{"i":[["a","b"],["c","d"],["e","f"],["g","h"],["i","j"],["k","l"],["m"'
    expect(countCompleteTightWriterItems(runaway)).toBe(6)
    expect(shouldStopWindowsTightWriterStream(runaway, 'win32')).toBe(true)
  })

  it('stops only on Windows tight once six items are complete', () => {
    const six =
      '{"i":[["a","b",1,2],["c","d",3,4],["e","f",5,6],["g","h",7,8],["i","j",9,10],["k","l",11,12]]}'
    expect(shouldStopWindowsTightWriterStream(six, 'win32')).toBe(true)
    expect(shouldStopWindowsTightWriterStream(six, 'darwin')).toBe(false)
    process.env.AUTODOC_TEST_NOTES_TIGHT = '0'
    expect(shouldStopWindowsTightWriterStream(six, 'win32')).toBe(false)
  })
})

describe('Mac writer stream cap', () => {
  afterEach(() => {
    setPlatform(originalPlatform)
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('stops at the promised six-record boundary', () => {
    const records = Array.from(
      { length: 8 },
      (_, index) => `{"t":"Theme","h":"Title ${index}","c":"Grounded content ${index}","s":1,"e":2}`
    )
    const withoutDelimiter = `{"decisions":[],"action_items":[],"information":[${records.join(',')}`
    const partial = `${withoutDelimiter},`

    expect(countCompleteMacWriterItems(partial)).toBe(8)
    expect(shouldStopMacWriterStream(partial, 'darwin')).toBe(true)
    expect(shouldStopMacWriterStream(withoutDelimiter, 'darwin')).toBe(false)
    expect(shouldStopMacWriterStream(partial, 'win32')).toBe(false)
    const sixOnly = `{"decisions":[],"information":[${records.slice(0, 6).join(',')},`
    expect(shouldStopMacWriterStream(sixOnly, 'darwin')).toBe(true)
    expect(countCompleteMacWriterItems(partial.replace(`,${records[7]}`, ''))).toBe(7)

    const repaired = (
      new OllamaProvider('http://localhost:11434', 'test-model') as any
    ).repairTruncatedJSON(partial)
    expect(repaired?.information).toHaveLength(8)
  })

  it('records observable performance telemetry before cancelling a capped Mac stream', async () => {
    setPlatform('darwin')
    const records = Array.from(
      { length: 8 },
      (_, index) => `{"t":"Theme","h":"Title ${index}","c":"Grounded content ${index}","s":1,"e":2}`
    )
    const partial = `{"decisions":[],"action_items":[],"information":[${records.join(',')},`
    const cancelStream = vi.fn()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(`${JSON.stringify({ message: { content: partial } })}\n`)
                )
              },
              cancel: cancelStream
            }),
            { status: 200 }
          )
      )
    )
    const onCallComplete = vi.fn()
    const cappedProvider = new OllamaProvider('http://localhost:11434', 'test-model')
    cappedProvider.setBenchmarkOptions({ onCallComplete })

    await expect(
      (cappedProvider as any).callOllama('[L1] [me] Grounded content.', MAC_CONTEXT_TOKENS)
    ).resolves.toBe(partial)

    expect(cancelStream).toHaveBeenCalledOnce()
    expect(cappedProvider.getLastOllamaCallMetrics()).toMatchObject({
      streamCapped: true,
      doneReason: 'stream_cap',
      evalCount: 1,
      totalDurationMs: expect.any(Number),
      evalDurationMs: expect.any(Number),
      evalTokPerSec: expect.any(Number)
    })
    expect(cappedProvider.getLastEvalTokPerSec()).toBeGreaterThan(0)
    expect(onCallComplete).toHaveBeenCalledWith(
      expect.objectContaining({ streamCapped: true, doneReason: 'stream_cap' })
    )
  })

  it('keeps normal Windows final metrics uncapped', async () => {
    setPlatform('win32')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => makeOllamaContentResponse('{"d":[],"a":[],"i":[],"u":[],"s":[]}'))
    )
    const windowsProvider = new OllamaProvider('http://localhost:11434', 'test-model')

    await (windowsProvider as any).callOllama('[00:00] [me] Test.', WINDOWS_CONTEXT_TOKENS)

    expect(windowsProvider.getLastOllamaCallMetrics()).toMatchObject({
      doneReason: 'stop',
      evalCount: 12
    })
    expect(windowsProvider.getLastOllamaCallMetrics()).not.toHaveProperty('streamCapped')
  })
})

describe('Mac action-candidate audit', () => {
  it('prioritizes local commitments and flags explicit remote plans and requests by line ID', () => {
    const transcript = [
      '[L1] [them] I will start the Android release today.',
      '[L2] [them] The iOS RC is in QA.',
      '[L3] [them] My plan is to reach out to beta users.',
      "[L4] [me] Yeah, I'll ping Sergio after the meeting.",
      '[L5] [me] Maybe I will ask again tomorrow.',
      '[L6] [them] Just make sure you approve both apps.'
    ].join('\n')

    expect(macActionCandidateLineIds(transcript)).toEqual([4, 1, 3, 6])
    expect(macActionCandidateGuidance(transcript)).toContain(
      'inspect L4, L1, L3, L6 before information'
    )
    expect(macActionCandidateGuidance('[L1] [them] The RC passed QA.')).toBe('')
  })

  it('flags explicit rollout conditions without copying transcript prose into the audit', () => {
    const transcript = [
      '[L1] [them] The iOS RC is in QA.',
      '[L2] [them] Whenever smoke tests finish, we will release it at fifty fifty.',
      '[L3] [them] The Android release started today.'
    ].join('\n')

    expect(macRolloutGateCandidateLineIds(transcript)).toEqual([2])
    expect(macRolloutGateCandidateGuidance(transcript)).toContain('inspect L2')
    expect(macRolloutGateCandidateGuidance(transcript)).not.toContain('fifty fifty')
  })

  it('ranks generic decisions, measured results, tradeoffs, gates, and material status', () => {
    const transcript = [
      '[L1] [them] The deployment completed this morning.',
      '[L2] [them] Conversion increased by 14 percent in the test.',
      '[L3] [me] We decided to use the staged rollout.',
      '[L4] [them] The tradeoff is higher cost for lower latency.',
      '[L5] [them] Once review passes, we will release the update.',
      '[L6] [them] Can you hear me for one second?',
      '[L7] [them] The migration is blocked on credentials.'
    ].join('\n')

    expect(macHighSignalCandidateLineIds(transcript)).toEqual([3, 2, 5, 4, 1, 7])
    expect(macHighSignalCandidateGuidance(transcript)).toContain('inspect L3, L2, L5, L4, L1, L7')
    expect(macHighSignalCandidateGuidance(transcript)).not.toContain('14 percent')
  })
})

describe('packTranscriptChunks', () => {
  it('packs to the char budget and folds a short leftover when asked', () => {
    const lines = Array.from({ length: 40 }, (_, index) => `line-${index} ${'x'.repeat(240)}`)
    const transcript = lines.join('\n')
    const packed = packTranscriptChunks(transcript, 6000, false)
    expect(packed.length).toBeGreaterThan(1)
    expect(packed.slice(0, -1).every((chunk) => chunk.length <= 6000)).toBe(true)

    const withTail = `${'a'.repeat(5900)}\n${'b'.repeat(200)}`
    const absorbed = packTranscriptChunks(withTail, 6000, true)
    expect(absorbed).toHaveLength(1)
    expect(absorbed[0]).toContain('b'.repeat(200))
    expect(packTranscriptChunks(withTail, 6000, false)).toHaveLength(2)
  })

  it('does not charge hidden Mac millisecond precision against the prompt chunk budget', () => {
    const precise = [
      `[00:01.100] [me] ${'a'.repeat(80)}`,
      `[00:02.200] [them] ${'b'.repeat(80)}`,
      `[00:03.300] [me] ${'c'.repeat(80)}`
    ].join('\n')
    const wholeSeconds = precise.replace(/\.\d{3}\]/gu, ']')
    const preciseChunks = packTranscriptChunks(precise, 130, false, true)
    const originalChunks = packTranscriptChunks(wholeSeconds, 130, false)

    expect(preciseChunks.map((chunk) => chunk.replace(/\.\d{3}\]/gu, ']'))).toEqual(originalChunks)
  })
})

describe('writerProgressPercent', () => {
  it('keeps the last writer chunk at 70 so scan is not shown as 99%', () => {
    expect(writerProgressPercent(13, 1, 14)).toBe(70)
    expect(writerProgressPercent(0, 0, 14)).toBe(0)
    expect(writerProgressPercent(13, 0.99, 14)).toBeLessThanOrEqual(70)
  })
})

describe('OllamaProvider retry sampling jitter', () => {
  afterEach(() => {
    setPlatform(originalPlatform)
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  function makeGarbageOllamaResponse(): Response {
    // Irreparable content: no "}," / "]" / "[]" for repairTruncatedJSON to cut at.
    const chunk = new TextEncoder().encode(
      `${JSON.stringify({ message: { content: 'garbage output' } })}\n`
    )
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(chunk)
          controller.close()
        }
      }),
      { status: 200 }
    )
  }

  it('keeps the first attempt at temperature 0 and jitters retries so they are not identical', async () => {
    const requestBodies: string[] = []
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      requestBodies.push(init?.body as string)
      return requestBodies.length === 1
        ? makeGarbageOllamaResponse()
        : makeSuccessfulOllamaResponse()
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await new OllamaProvider('http://localhost:11434', 'test-model').summarize(
      'meeting-retry-jitter',
      '[00:00] [Chris] The Windows notes retry completed after the stalled request was cancelled.',
      undefined,
      5
    )

    expect(result.information).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    const firstBody = JSON.parse(requestBodies[0])
    const retryBody = JSON.parse(requestBodies[1])

    expect(firstBody.options.temperature).toBe(0)
    expect('seed' in firstBody.options).toBe(false)
    expect(retryBody.options.temperature).toBeGreaterThan(0)
    expect(retryBody.options.seed).toBe(1)
  })
})

describe('OllamaProvider runner recycling hook', () => {
  afterEach(() => {
    setPlatform(originalPlatform)
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('invokes maybeRecycleRunner with the meeting id before each writer chunk', async () => {
    const maybeRecycleRunner = vi.fn()
    const callOrder: string[] = []
    const fetchMock = vi.fn(async () => {
      callOrder.push('fetch')
      return makeSuccessfulOllamaResponse()
    })
    maybeRecycleRunner.mockImplementation(() => callOrder.push('recycle'))
    vi.stubGlobal('fetch', fetchMock)

    await new OllamaProvider('http://localhost:11434', 'test-model', {
      maybeRecycleRunner
    }).summarize(
      'meeting-recycle-hook',
      '[00:00] [Chris] The Windows notes retry completed after the stalled request was cancelled.',
      undefined,
      5
    )

    expect(maybeRecycleRunner).toHaveBeenCalledWith('meeting-recycle-hook')
    expect(callOrder[0]).toBe('recycle')
  })

  it('invokes maybeRecycleRunner before scan completePrompt requests', async () => {
    const maybeRecycleRunner = vi.fn()
    const fetchMock = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `${JSON.stringify({ response: 'restyled text', done: true })}\n`
                )
              )
              controller.close()
            }
          }),
          { status: 200 }
        )
    )
    vi.stubGlobal('fetch', fetchMock)

    const output = await new OllamaProvider('http://localhost:11434', 'test-model', {
      maybeRecycleRunner
    }).completePrompt('Restyle this note.', {
      num_ctx: 8192,
      num_predict: 512,
      temperature: 0,
      seed: 7
    })

    expect(output).toBe('restyled text')
    expect(maybeRecycleRunner).toHaveBeenCalledTimes(1)
  })
})

describe('OllamaProvider writer parse skip and salvage', () => {
  afterEach(() => {
    setPlatform(originalPlatform)
    delete process.env.AUTODOC_DISABLE_WINDOWS_WRITER_GROUNDING
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  function createChunkedWindowsProvider(): OllamaProvider {
    setPlatform('win32')
    const provider = new OllamaProvider('http://localhost:11434', 'test-model')
    provider.setVramConstrainedContext(true, 'windows-vulkan')
    return provider
  }

  it('skips one irreparable chunk after a single parse retry and keeps later chunks', async () => {
    const provider = createChunkedWindowsProvider()
    let chunkOneCalls = 0
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const user = requestUserContent(init)
      if (user.includes('CHUNK_ONE_LYRICS')) {
        chunkOneCalls++
        return makeIrreparableJsonResponse()
      }
      if (user.includes('CHUNK_TWO_BILLING')) {
        return makeValidChunkResponse(
          'Billing API migration planned',
          'The billing API migration was confirmed.'
        )
      }
      return makeValidChunkResponse(
        'Feature flag rollout approved',
        'The feature flag rollout was approved.'
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await provider.summarize(
      'meeting-greg-skip',
      makeThreeChunkTranscript(),
      undefined,
      35
    )

    expect(result.information.map((item) => item.title)).toEqual([
      'Billing API migration planned',
      'Feature flag rollout approved'
    ])
    expect(chunkOneCalls).toBe(2)
    expect(provider.getLastWriterSkips()).toEqual([
      expect.objectContaining({
        chunkIndex: 1,
        attempts: 2,
        rawHead: expect.stringContaining('{"decisions"'),
        rawTail: expect.stringContaining('na ')
      })
    ])
    expect(mocks.logAutodocEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'notes llm chunk skipped',
        level: 'warn',
        meetingId: 'meeting-greg-skip',
        context: expect.objectContaining({
          chunkIndex: 1,
          chunkCount: 3,
          rawHead: expect.any(String),
          rawTail: expect.any(String),
          ollamaMetrics: expect.objectContaining({ doneReason: 'stop' })
        })
      })
    )
    expect(mocks.logAutodocEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'notes llm summarize completed',
        meetingId: 'meeting-greg-skip',
        context: expect.objectContaining({
          skippedChunkCount: 1,
          skippedChunkIndexes: [1]
        })
      })
    )
  })

  it('salvages complete items when JSON breaks mid-string', () => {
    const provider = new OllamaProvider('http://localhost:11434', 'test-model')
    const transcript = [
      '[00:00] [Speaker] The team confirmed the billing API migration.',
      '[00:05] [Speaker] Chris will own the feature flag rollout.'
    ].join('\n')
    const raw =
      '{"decisions":[],"action_items":[],"information":[' +
      '{"topic":"Billing","title":"Billing API migration planned","content":"The team confirmed the billing API migration.","sourceStartMs":0,"sourceEndMs":0},' +
      '{"topic":"Flags","title":"Feature flag rollout owned","content":"Chris will own the feature flag rollout.","sourceStartMs":5000,"sourceEndMs":5000},' +
      '{"topic":"Flags","title":"Broken item","content":"unterminated chorus that never closes'

    const result = (provider as any).parseResponse(
      'meeting-clite',
      raw,
      undefined,
      60_000,
      (provider as any).extractTimestampsMs(transcript),
      (provider as any).parseTranscriptLines(transcript)
    )

    expect(result.information).toHaveLength(2)
    expect(result.information.map((item: { title: string }) => item.title)).toEqual([
      'Billing API migration planned',
      'Feature flag rollout owned'
    ])
  })

  it('retains a complete open category when earlier categories already parsed', () => {
    process.env.AUTODOC_DISABLE_WINDOWS_WRITER_GROUNDING = '1'
    const provider = new OllamaProvider('http://localhost:11434', 'test-model')
    const transcript = [
      '[00:00] [Speaker] The first rollout action was recorded.',
      '[00:05] [Speaker] There are sixteen opted-in testers.',
      '[00:10] [Speaker] The monthly limit remains active.'
    ].join('\n')
    const raw =
      '{"decisions":[],"action_items":[' +
      '{"h":"Record rollout action","c":"The first rollout action was recorded.","s":0,"e":0}' +
      '],"information":[' +
      '{"h":"Tester count","c":"There are sixteen opted-in testers.","s":5000,"e":5000},' +
      '{"h":"Monthly limit","c":"The monthly limit remains active.","s":10000,"e":10000},'

    const result = (provider as any).parseResponse(
      'meeting-open-category',
      raw,
      undefined,
      60_000,
      (provider as any).extractTimestampsMs(transcript),
      (provider as any).parseTranscriptLines(transcript)
    )

    expect(result.actionItems).toHaveLength(1)
    expect(result.information.map((item: { title: string }) => item.title)).toEqual([
      'Tester count',
      'Monthly limit'
    ])
    delete process.env.AUTODOC_DISABLE_WINDOWS_WRITER_GROUNDING
  })

  it('resolves empty segments when every chunk is irreparable', async () => {
    const provider = createChunkedWindowsProvider()
    const fetchMock = vi.fn(async () => makeIrreparableJsonResponse())
    vi.stubGlobal('fetch', fetchMock)

    const result = await provider.summarize(
      'meeting-all-skipped',
      makeThreeChunkTranscript(),
      undefined,
      35
    )

    expect(result).toEqual({
      decisions: [],
      actionItems: [],
      information: [],
      discussion: [],
      statusUpdates: []
    })
    expect(fetchMock).toHaveBeenCalledTimes(6)
    expect(provider.getLastWriterSkips()).toHaveLength(3)
    expect(mocks.logAutodocEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'notes llm summarize completed',
        context: expect.objectContaining({
          skippedChunkCount: 3,
          itemCount: 0
        })
      })
    )
    expect(WRITER_PARSE_ERROR_CODE).toBe('NOTES_WRITER_PARSE_ERROR')
  })
})

describe('compact writer inspect and weighted decode', () => {
  it('records unknown categories and unexpandable items as silent drops', () => {
    const result = inspectCompactWriterPayload({
      d: [{ t: 'Theme', h: 'Ok', c: 'Body', s: 1, e: 2 }],
      extra: [{ title: 'Lost' }],
      i: 'not-an-array',
      a: [null, 12]
    })
    expect(result.rawItemCount).toBe(3)
    expect(result.expandedItemCount).toBe(1)
    expect(result.drops.map((drop) => drop.reason).sort()).toEqual([
      'category_not_array',
      'unexpandable_item',
      'unknown_category'
    ])
  })

  it('expands tight [title, content, s, e] tuples without treating title as topic', () => {
    const result = inspectCompactWriterPayload({
      a: [
        [
          'Raise Windows min RAM to 16GB',
          'Change the Windows minimum from 8GB to 16GB.',
          1_061_000,
          1_071_000
        ]
      ],
      i: [
        [
          '14 starts and 6 cancels',
          'Latest period had 14 starts and 6 cancellations.',
          22_000,
          28_000,
          null,
          null
        ]
      ]
    })
    expect(result.expandedItemCount).toBe(2)
    expect(result.expanded.action_items?.[0]).toMatchObject({
      title: 'Raise Windows min RAM to 16GB',
      content: 'Change the Windows minimum from 8GB to 16GB.',
      sourceStartMs: 1_061_000,
      sourceEndMs: 1_071_000
    })
    expect(result.expanded.action_items?.[0].topic).toBeUndefined()
    expect(result.expanded.information?.[0]).toMatchObject({
      title: '14 starts and 6 cancels',
      sourceStartMs: 22_000
    })
  })

  it('merges duplicate category keys and missing colons from raw JSON', () => {
    const raw =
      '{"i":[["14 starts and 6 cancellations","Latest period had 14 starts and 6 cancellations.",22000,28000]],"a":[["Submit PR","Matt will submit the PR.",68000,70000]],"i":[["Free tier doc","Roel posted the free tier doc.",158000,166000]],"x":[["Timeout debate","Team is reconsidering the timeout."],1061000,1071000]}'
    const parsed = parseWriterJsonRecord(raw)
    expect(parsed).not.toBeNull()
    const result = inspectCompactWriterPayload(parsed as Record<string, unknown>)
    expect(result.expanded.information?.map((row) => row.title)).toEqual([
      '14 starts and 6 cancellations',
      'Free tier doc'
    ])
    expect(result.expanded.discussion?.[0]).toMatchObject({
      title: 'Timeout debate',
      sourceStartMs: 1_061_000,
      sourceEndMs: 1_071_000
    })
  })

  it('reads mm:ss clocks out of tight writer prose', () => {
    expect(
      extractProseClockMs(
        'There are fourteen starts and six cancellations in the data as of 00:22.'
      )
    ).toEqual([22_000])
    expect(extractProseClockMs('as observed at 02:03 and again at [17:41]')).toEqual([
      123_000, 1_061_000
    ])
  })

  it('recovers tight items when category keys use commas instead of colons', () => {
    const raw =
      '{"d":[["Raise Windows min RAM to 16GB","Change the Windows minimum from 8GB to 16GB."]],"a",[["Draft Brevo email","Send Greg the Windows RAM note."]],"i",[["Auto Doc 1.1.3","Patch 1.1.3 fixed the email-us bug."]]}'
    const extracted = extractWriterCategoryObject(raw)
    expect(extracted?.a).toHaveLength(1)
    expect(extracted?.i).toHaveLength(1)
    const result = inspectCompactWriterPayload(extracted as Record<string, unknown>)
    expect(result.expanded.action_items?.[0].title).toBe('Draft Brevo email')
    expect(result.expanded.information?.[0].title).toBe('Auto Doc 1.1.3')
    expect(result.expanded.decisions?.[0].title).toBe('Raise Windows min RAM to 16GB')
  })

  it('still expands legacy [topic, title, content, ...] tuples', () => {
    const result = inspectCompactWriterPayload({
      d: [['Theme', 'Decided', 'We chose 16GB.', null, null, 12_000, 45_000]]
    })
    expect(result.expanded.decisions?.[0]).toMatchObject({
      topic: 'Theme',
      title: 'Decided',
      content: 'We chose 16GB.',
      sourceStartMs: 12_000,
      sourceEndMs: 45_000
    })
  })

  it('weights writer decode by duration instead of the last sample', () => {
    expect(
      computeWriterWeightedEvalTokPerSec([
        { evalCount: 5000, evalDurationMs: 500_000 },
        { evalCount: 266, evalDurationMs: 21_800 }
      ])
    ).toBe(10.1)
  })
})

describe('writer timestamp salvage', () => {
  const meetingMs = 1_982_686

  it('leaves in-range millisecond values alone', () => {
    expect(salvageWriterTimestampMs(22_000, meetingMs)).toBe(22_000)
    expect(salvageWriterTimestampMs(1_061_000, meetingMs)).toBe(1_061_000)
  })

  it('decodes compact clock overflow 17:41 → 17410000', () => {
    expect(salvageWriterTimestampMs(17_410_000, meetingMs)).toBe(1_061_000)
  })

  it('decodes slightly-over 2012000 as 20:12', () => {
    expect(salvageWriterTimestampMs(2_012_000, meetingMs)).toBe(1_212_000)
  })

  it('divides a 10x millisecond overflow when it is not a clock reading', () => {
    expect(salvageWriterTimestampMs(10_610_000, meetingMs)).toBe(1_061_000)
  })

  it('exposes an in-range clock alternate without rewriting real milliseconds', () => {
    expect(alternateClockTimestampMs(1_741_000, meetingMs)).toBe(1_061_000)
    expect(alternateClockTimestampMs(1_720_000, meetingMs)).toBe(1_040_000)
    expect(alternateClockTimestampMs(141_500, meetingMs)).toBe(855_000)
    expect(salvageWriterTimestampMs(1_741_000, meetingMs)).toBe(1_741_000)
    expect(salvageWriterTimestampMs(150_000, meetingMs)).toBe(150_000)
  })

  it('coerces numeric timestamp strings', () => {
    expect(salvageWriterTimestampMs('22000', meetingMs)).toBe(22_000)
    expect(salvageWriterTimestampMs('1061000', meetingMs)).toBe(1_061_000)
    expect(alternateClockTimestampMs('1741000', meetingMs)).toBe(1_061_000)
  })
})

describe('compact timestamp and spoken-quantity grounding', () => {
  afterEach(() => {
    setPlatform(originalPlatform)
    delete process.env.AUTODOC_DISABLE_WINDOWS_WRITER_GROUNDING
  })

  function parseInformationNote(
    platform: NodeJS.Platform,
    transcript: string,
    title: string,
    content: string
  ): MeetingSegments {
    setPlatform(platform)
    const provider = new OllamaProvider('http://localhost:11434', 'test-model')
    return (provider as any).parseResponse(
      'meeting-1',
      JSON.stringify({
        information: [
          {
            topic: 'Metrics',
            title,
            content,
            sourceStartMs: 10_000,
            sourceEndMs: 10_000
          }
        ]
      }),
      undefined,
      60_000,
      (provider as any).extractTimestampsMs(transcript),
      (provider as any).parseTranscriptLines(transcript)
    )
  }

  it('grounds written percentages against spoken-word evidence on Mac', () => {
    const result = parseInformationNote(
      'darwin',
      '[00:10] [them] Trial starts on Mac improved twelve percent.',
      'Mac trial starts improved 12%',
      'Trial starts on Mac improved 12%.'
    )

    expect(result.information).toHaveLength(1)
    expect(result.information[0].content).toContain('12%')
  })

  it('grounds build comparisons against sequential spoken digits on Mac', () => {
    const result = parseInformationNote(
      'darwin',
      '[00:10] [them] Four four three was narrowly ahead of four three five on Windows.',
      '443 narrowly led 435 on Windows',
      'Build 443 was narrowly ahead of 435 on Windows.'
    )

    expect(result.information).toHaveLength(1)
    expect(result.information[0].content).toContain('443')
    expect(result.information[0].content).toContain('435')
  })

  it('rejects a percentage when Mac evidence only contains the same count of users', () => {
    const result = parseInformationNote(
      'darwin',
      '[00:10] [them] We invited twelve users to test the build.',
      'Trial conversion improved 12%',
      'Trial conversion improved 12%.'
    )

    expect(result.information).toHaveLength(0)
  })

  it('leaves the existing Windows quantity policy unchanged', () => {
    const result = parseInformationNote(
      'win32',
      '[00:10] [them] Trial starts improved twelve percent.',
      'Trial starts improved 12%',
      'Trial starts improved 12%.'
    )

    expect(result.information).toHaveLength(0)
  })

  it('keeps a compact item whose s/e overflowed as clock digits', () => {
    setPlatform('win32')
    process.env.AUTODOC_DISABLE_WINDOWS_WRITER_GROUNDING = '1'
    const provider = new OllamaProvider('http://localhost:11434', 'test-model')
    const transcript = [
      '[17:40] [Chris] Eight gigabytes of RAM on Windows is a miserable experience.',
      '[17:41] [Chris] I raised the minimum spec for Windows to sixteen gigs.',
      '[18:12] [Chris] I drafted a Brevo email for Greg.'
    ].join('\n')

    const result = (provider as any).parseResponse(
      'meeting-1',
      JSON.stringify({
        d: [],
        a: [
          {
            t: 'Windows spec',
            h: 'Update minimum RAM requirement for Windows',
            c: 'Raised the Windows minimum from 8GB to 16GB and drafted a Brevo email for Greg.',
            o: 'Chris',
            s: 17_410_000,
            e: 18_000_000
          }
        ],
        i: [],
        x: [],
        u: []
      }),
      undefined,
      1_982_686,
      (provider as any).extractTimestampsMs(transcript),
      (provider as any).parseTranscriptLines(transcript)
    )

    expect(result.actionItems).toHaveLength(1)
    expect(result.actionItems[0].title).toContain('minimum RAM')
    expect(result.actionItems[0].sourceStartMs).toBeGreaterThanOrEqual(1_060_000)
    expect(result.actionItems[0].sourceStartMs).toBeLessThan(1_200_000)
    delete process.env.AUTODOC_DISABLE_WINDOWS_WRITER_GROUNDING
  })

  it('keeps spoken fourteen/six when the note writes digits', () => {
    setPlatform('win32')
    const provider = new OllamaProvider('http://localhost:11434', 'test-model')
    const transcript = [
      '[00:22] [Matt] Yeah, I mean there is fourteen Starts and Six cancels in less than twenty four hours.',
      '[00:28] [Matt] That is what the data is saying.',
      '[03:40] [Matt] I posted the working requirements document.'
    ].join('\n')

    const result = (provider as any).parseResponse(
      'meeting-1',
      JSON.stringify({
        information: [
          {
            topic: 'Cancellations',
            title: '14 starts, 6 cancellations reported',
            content: 'The data shows 14 starts and 6 cancellations in less than 24 hours.',
            sourceStartMs: 220_000,
            sourceEndMs: 280_000
          }
        ]
      }),
      undefined,
      1_982_686,
      (provider as any).extractTimestampsMs(transcript),
      (provider as any).parseTranscriptLines(transcript)
    )

    expect(result.information).toHaveLength(1)
    expect(result.information[0].title).toContain('14 starts')
  })

  it('keeps 1.1.3 when compact s/e used in-range mmss×1000', () => {
    setPlatform('win32')
    process.env.AUTODOC_DISABLE_WINDOWS_WRITER_GROUNDING = '1'
    const provider = new OllamaProvider('http://localhost:11434', 'test-model')
    const transcript = [
      '[17:07] [Chris] I noticed a minor bug with one dot one dot two of Auto Doc where the email us text would not go away.',
      '[17:20] [Chris] So I made a PR and got a one dot one dot three out release for Mac OS and Windows.'
    ].join('\n')

    const result = (provider as any).parseResponse(
      'meeting-1',
      JSON.stringify({
        d: [],
        a: [],
        i: [
          {
            t: 'Patch',
            h: 'PR and release details for Auto Doc 1.1.3',
            c: 'A minor patch release (1.1.3) was issued for Mac OS and Windows to fix a persistent email text bug.',
            s: 1_720_000,
            e: 1_731_000
          }
        ],
        x: [],
        u: []
      }),
      undefined,
      1_982_686,
      (provider as any).extractTimestampsMs(transcript),
      (provider as any).parseTranscriptLines(transcript)
    )

    expect(result.information).toHaveLength(1)
    expect(result.information[0].title).toContain('1.1.3')
    expect(result.information[0].sourceStartMs).toBeGreaterThanOrEqual(1_020_000)
    expect(result.information[0].sourceStartMs).toBeLessThan(1_100_000)
  })

  it('keeps 4.3.5 when the transcript says four three five', () => {
    setPlatform('win32')
    process.env.AUTODOC_DISABLE_WINDOWS_WRITER_GROUNDING = '1'
    const provider = new OllamaProvider('http://localhost:11434', 'test-model')
    const transcript = [
      '[14:15] [Matt] We just released the four three five build.',
      '[14:19] [Matt] So I think we should run that for the week instead of releasing another build.'
    ].join('\n')

    const result = (provider as any).parseResponse(
      'meeting-1',
      JSON.stringify({
        d: [],
        a: [],
        i: [],
        x: [],
        u: [
          {
            t: 'Release',
            h: 'Current build in use',
            c: 'The 4.3.5 build is currently running and will be used for the week unless there are critical issues.',
            s: 141_500,
            e: 142_900
          }
        ]
      }),
      undefined,
      1_982_686,
      (provider as any).extractTimestampsMs(transcript),
      (provider as any).parseTranscriptLines(transcript)
    )

    expect(result.statusUpdates).toHaveLength(1)
    expect(result.statusUpdates[0].content).toContain('4.3.5')
    expect(result.statusUpdates[0].sourceStartMs).toBe(855_000)
  })

  it('keeps a count fact when a later line supplies an extra duration', () => {
    setPlatform('win32')
    const provider = new OllamaProvider('http://localhost:11434', 'test-model')
    const transcript = [
      '[00:22] [Matt] Yeah, I mean there is fourteen Starts and Six cancels.',
      '[00:28] [Matt] That is what the data is saying.',
      '[00:40] [Matt] Analytics on local discovery only shows QA traffic.',
      '[00:50] [Matt] The upgrade panel looks wrong in QA.',
      '[01:00] [Matt] Feature flags may be mis-assigned.',
      '[01:10] [Matt] Timeout might be too short.',
      '[02:30] [Matt] It has been less than twenty four hours so it is too early.'
    ].join('\n')

    const result = (provider as any).parseResponse(
      'meeting-1',
      JSON.stringify({
        i: [
          [
            'Data shows 14 starts and 6 cancellations in less than 24 hours',
            'The data indicates 14 starts and 6 cancellations, suggesting a potential common issue.',
            22_000,
            150_000
          ]
        ]
      }),
      undefined,
      1_982_686,
      (provider as any).extractTimestampsMs(transcript),
      (provider as any).parseTranscriptLines(transcript)
    )

    expect(result.information).toHaveLength(1)
    expect(result.information[0].title).toContain('14 starts')
    expect(result.information[0].sourceStartMs).toBeLessThan(60_000)
  })

  it('keeps a count fact when the writer added an extra duration that is also in the transcript', () => {
    setPlatform('win32')
    const provider = new OllamaProvider('http://localhost:11434', 'test-model')
    const transcript = [
      '[00:22] [Matt] Yeah, I mean there is fourteen Starts and Six cancels in less than twenty four hours.',
      '[00:28] [Matt] That is what the data is saying.',
      '[02:30] [Matt] Analytics on local discovery only shows QA traffic.'
    ].join('\n')

    const result = (provider as any).parseResponse(
      'meeting-1',
      JSON.stringify({
        i: [
          [
            'Data shows 14 starts and 6 cancellations in less than 24 hours',
            'The data indicates 14 starts and 6 cancellations, suggesting a potential common issue.',
            22_000,
            150_000
          ]
        ]
      }),
      undefined,
      1_982_686,
      (provider as any).extractTimestampsMs(transcript),
      (provider as any).parseTranscriptLines(transcript)
    )

    expect(result.information).toHaveLength(1)
    expect(result.information[0].title).toContain('14 starts')
    expect(result.information[0].sourceStartMs).toBeLessThan(60_000)
  })

  it('does not treat a product channel like V2 as a required quantity', () => {
    setPlatform('win32')
    const provider = new OllamaProvider('http://localhost:11434', 'test-model')
    const transcript = [
      '[18:20] [Chris] The V2 bake-off picked a smaller and faster model.',
      '[18:24] [Chris] That architecture change is the clear winner.'
    ].join('\n')

    const result = (provider as any).parseResponse(
      'meeting-1',
      JSON.stringify({
        x: [
          [
            'V2 model bake-off results in clear winner',
            'A bake-off between current and potential models for V2 identified a smaller, faster model.',
            1_909_000,
            1_928_000
          ]
        ]
      }),
      undefined,
      1_982_686,
      (provider as any).extractTimestampsMs(transcript),
      (provider as any).parseTranscriptLines(transcript)
    )

    expect(result.discussion).toHaveLength(1)
    expect(result.discussion[0].title).toMatch(/bake-off/i)
  })

  it('expands tight tuples whose clocks arrived as strings', () => {
    const inspected = inspectCompactWriterPayload({
      i: [['Staging copy', 'Gabriel updated staging wordings.', '2303000', '2309000']]
    })
    expect(inspected.expanded.information).toHaveLength(1)
    expect(inspected.expanded.information[0].sourceStartMs).toBe(2_303_000)
    expect(inspected.expanded.information[0].sourceEndMs).toBe(2_309_000)
  })
})

describe('Windows writer grounding boundary', () => {
  afterEach(() => {
    delete process.env.AUTODOC_DISABLE_WINDOWS_WRITER_GROUNDING
    setPlatform(originalPlatform)
  })

  function parseWithStats(
    transcript: string,
    payload: Record<string, unknown>
  ): {
    segments: MeetingSegments
    groundingAccepted: number
    groundingSalvaged: number
    groundingDropped: number
    drops: Array<{ reason: string; category?: string; detail?: string }>
  } {
    const provider = new OllamaProvider('http://localhost:11434', 'test-model')
    return (provider as any).parseResponseWithStats(
      'meeting-1',
      JSON.stringify(payload),
      undefined,
      1_982_686,
      (provider as any).extractTimestampsMs(transcript),
      (provider as any).parseTranscriptLines(transcript)
    )
  }

  it('sanitizes on win32 by default, and the disable switch wins', () => {
    expect(shouldSanitizeWindowsWriterRecords('win32', undefined)).toBe(true)
    expect(shouldSanitizeWindowsWriterRecords('win32', '0')).toBe(true)
    expect(shouldSanitizeWindowsWriterRecords('win32', '1')).toBe(false)
    expect(shouldSanitizeWindowsWriterRecords('darwin', undefined)).toBe(false)
    expect(shouldSanitizeWindowsWriterRecords('linux', undefined)).toBe(false)
  })

  it('is not a backdoor around the Windows digit-token quantity policy', () => {
    setPlatform('win32')
    const result = parseWithStats('[00:10] [them] Trial starts improved twelve percent.', {
      information: [
        {
          topic: 'Metrics',
          title: 'Trial starts improved 12%',
          content: 'Trial starts improved 12%.',
          sourceStartMs: 10_000,
          sourceEndMs: 10_000
        }
      ]
    })

    expect(result.segments.information).toHaveLength(0)
    expect(result.groundingDropped).toBe(0)
    expect(result.drops.some((drop) => drop.reason === 'ungrounded')).toBe(true)
  })

  it('accepts a grounded tight information tuple and counts it', () => {
    setPlatform('win32')
    const result = parseWithStats(
      '[00:10] [them] The rollout is paused until the crash rate drops.',
      {
        i: [['Rollout paused', 'The rollout is paused until the crash rate drops.', 10_000, 10_000]]
      }
    )

    expect(result.segments.information).toHaveLength(1)
    expect(result.segments.information[0].content).toContain('rollout is paused')
    expect(result.groundingAccepted).toBe(1)
    expect(result.groundingDropped).toBe(0)
  })

  it('accepts a paraphrased bundled action tuple whole once its atoms verify', () => {
    setPlatform('win32')
    const transcript = [
      '[00:10] [Chris] The Android RC finished testing, so I will start the release today.',
      '[00:18] [Chris] It passed QA.'
    ].join('\n')
    const result = parseWithStats(transcript, {
      a: [
        {
          t: 'Release',
          h: 'Start Android RC release',
          c: 'Begin Android RC release today after QA approval.',
          s: 10_000,
          e: 18_000
        }
      ]
    })

    expect(result.segments.actionItems).toHaveLength(1)
    expect(result.segments.actionItems[0].content).toBe(
      'Begin Android RC release today after QA approval.'
    )
    expect(result.groundingAccepted).toBe(1)
    expect(result.groundingDropped).toBe(0)
  })

  it('grounds a spoken gigabyte range cited across neighboring lines', () => {
    setPlatform('win32')
    const transcript = [
      '[00:10] [me] The minimum spec was eight gigs on Windows.',
      '[00:16] [me] Eight gigabytes of RAM on Windows is a miserable experience.',
      '[00:22] [me] So I raised it, at least right now, to sixteen gigs.'
    ].join('\n')
    const result = parseWithStats(transcript, {
      i: [
        [
          'Minimum RAM requirement updated',
          'Raised the Windows minimum RAM requirement from 8 to 16 gigabytes.',
          10_000,
          22_000
        ]
      ]
    })

    expect(result.segments.information).toHaveLength(1)
    expect(result.segments.information[0].content).toContain('8 to 16 gigabytes')
    expect(result.groundingAccepted).toBe(1)
    expect(result.groundingDropped).toBe(0)
  })

  it('does not read a stitched-in hearing negation as a claim polarity flip', () => {
    setPlatform('win32')
    const transcript = [
      "[00:10] [them] Oh say that again, I didn't get the last We just released the four three five build.",
      '[00:18] [me] So I think we should run that for the week.'
    ].join('\n')
    const result = parseWithStats(transcript, {
      i: [
        [
          'Current build for the week',
          'The team agrees to use the four three five build for the week.',
          10_000,
          18_000
        ]
      ]
    })

    expect(result.segments.information).toHaveLength(1)
    expect(result.groundingAccepted).toBe(1)
    expect(result.groundingDropped).toBe(0)
  })

  it('drops a record whose citation resolves to unrelated speech', () => {
    setPlatform('win32')
    const transcript = [
      '[00:10] [them] Yeah.',
      '[00:12] [me] Sounds good, talk soon.'
    ].join('\n')
    const result = parseWithStats(transcript, {
      x: [
        [
          'Architecture changes required',
          'The new model requires architectural adjustments to function properly.',
          10_000,
          12_000
        ]
      ]
    })

    expect(result.segments.discussion).toHaveLength(0)
    expect(result.groundingDropped).toBe(1)
  })

  it('rejects a polarity flip and records the grounding drop', () => {
    setPlatform('win32')
    const result = parseWithStats(
      '[00:10] [them] The beta rollout is not paused for review.',
      {
        i: [['Beta rollout paused', 'The beta rollout is paused for review.', 10_000, 10_000]]
      }
    )

    expect(result.segments.information).toHaveLength(0)
    expect(result.groundingDropped).toBe(1)
    expect(result.drops.some((drop) => drop.reason === 'grounding_rejected')).toBe(true)
  })

  it('keeps the old Windows accept path when the disable switch is set', () => {
    setPlatform('win32')
    process.env.AUTODOC_DISABLE_WINDOWS_WRITER_GROUNDING = '1'

    const result = parseWithStats(
      '[00:10] [them] The beta rollout is not paused for review.',
      {
        i: [['Beta rollout paused', 'The beta rollout is paused for review.', 10_000, 10_000]]
      }
    )

    expect(result.segments.information).toHaveLength(1)
    expect(result.groundingDropped).toBe(0)
    expect(result.drops.some((drop) => drop.reason === 'grounding_rejected')).toBe(false)
  })

  it('keeps spoken fourteen/six coverage with grounding enabled', () => {
    setPlatform('win32')
    const transcript = [
      '[00:22] [Matt] Yeah, I mean there is fourteen Starts and Six cancels in less than twenty four hours.',
      '[00:28] [Matt] That is what the data is saying.'
    ].join('\n')
    const result = parseWithStats(transcript, {
      information: [
        {
          topic: 'Cancellations',
          title: '14 starts, 6 cancellations reported',
          content: 'The data shows 14 starts and 6 cancellations in less than 24 hours.',
          sourceStartMs: 220_000,
          sourceEndMs: 280_000
        }
      ]
    })

    expect(result.segments.information).toHaveLength(1)
    expect(result.segments.information[0].title).toContain('14 starts')
  })

  it('rejects a tentative proposal written as a firm plan, unlike the range-only path', () => {
    setPlatform('win32')
    // The evidence says the build was "just released" and that the speaker
    // "thinks we should" run it for the week; the note asserts it "is
    // currently running and will be used ... unless there are critical
    // issues". The boundary rejects that state shift by design. Whether the
    // page still covers the build number is an E2E gate, not a unit gate.
    const transcript = [
      '[14:15] [Matt] We just released the four three five build.',
      '[14:19] [Matt] So I think we should run that for the week instead of releasing another build.'
    ].join('\n')
    const result = parseWithStats(transcript, {
      u: [
        {
          t: 'Release',
          h: 'Current build in use',
          c: 'The 4.3.5 build is currently running and will be used for the week unless there are critical issues.',
          s: 141_500,
          e: 142_900
        }
      ]
    })

    expect(result.segments.statusUpdates).toHaveLength(0)
    expect(result.groundingDropped).toBe(1)
    expect(result.drops.some((drop) => drop.reason === 'grounding_rejected')).toBe(true)
  })
})
