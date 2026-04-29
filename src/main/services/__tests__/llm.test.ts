import { afterEach, describe, it, expect, vi } from 'vitest'
import { LOW_MEMORY_CONTEXT_TOKENS, OllamaProvider, STANDARD_CONTEXT_TOKENS } from '../llm'

const mocks = vi.hoisted(() => ({
  logAutodocEvent: vi.fn(),
  captureMessage: vi.fn(),
}))

vi.mock('../autodoc-log', () => ({
  logAutodocEvent: mocks.logAutodocEvent,
}))

vi.mock('../sentry-reporter', () => ({
  captureMessage: mocks.captureMessage,
}))

describe('OllamaProvider grounding', () => {
  const provider = new OllamaProvider('http://localhost:11434', 'test-model')

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('drops hallucinated notes whose numbers are not supported by the cited transcript span', () => {
    const transcript = [
      '[00:00] [Speaker] Latest Windows desktop installs are 73 for this build.',
      '[00:05] [Speaker] We are still rolling 30% to rewrite and 70% to legacy Windows.',
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
            sourceEndMs: 5000,
          },
        ],
        discussion: [],
        status_updates: [],
      }),
      undefined,
      60_000,
      (provider as any).extractTimestampsMs(transcript),
      (provider as any).parseTranscriptLines(transcript),
    )

    expect(result.information).toEqual([])
  })

  it('keeps grounded items that match the cited transcript span', () => {
    const transcript = [
      '[00:00] [Speaker] Latest Windows desktop installs are 73 for this build.',
      '[00:05] [Speaker] We are still rolling 30% to rewrite and 70% to legacy Windows.',
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
            sourceEndMs: 5000,
          },
        ],
        discussion: [],
        status_updates: [],
      }),
      undefined,
      60_000,
      (provider as any).extractTimestampsMs(transcript),
      (provider as any).parseTranscriptLines(transcript),
    )

    expect(result.information).toHaveLength(1)
    expect(result.information[0].title).toContain('30%')
  })

  it('snaps timestamps within the current transcript chunk to avoid cross-chunk jumps', () => {
    const fullTranscript = [
      '[00:00] [Speaker] Team introductions and agenda review.',
      '[10:00] [Speaker] We should migrate the billing API before launch.',
      '[10:05] [Speaker] Chris will own the billing API migration plan.',
    ].join('\n')
    const chunkTranscript = [
      '[10:00] [Speaker] We should migrate the billing API before launch.',
      '[10:05] [Speaker] Chris will own the billing API migration plan.',
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
            sourceEndMs: 1000,
          },
        ],
        information: [],
        discussion: [],
        status_updates: [],
      }),
      undefined,
      605_000,
      (provider as any).extractTimestampsMs(fullTranscript),
      (provider as any).parseTranscriptLines(chunkTranscript),
    )

    expect(result.actionItems).toHaveLength(1)
    expect(result.actionItems[0].sourceStartMs).toBe(600_000)
    expect(result.actionItems[0].sourceEndMs).toBe(600_000)
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
          sourceEndMs: 0,
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
          sourceEndMs: 0,
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
          sourceEndMs: 0,
        },
        {
          id: 'i4',
          meetingId: 'meeting-1',
          category: 'information',
          topic: 'Mixpanel Reporting',
          title: 'Mixpanel events are noisy',
          content: 'Reporting in Mixpanel is noisy because event tracking includes too many plan switches.',
          assignee: null,
          deadline: null,
          sourceStartMs: 0,
          sourceEndMs: 0,
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
          sourceEndMs: 0,
        },
        {
          id: 'i6',
          meetingId: 'meeting-1',
          category: 'information',
          topic: 'Mixpanel Event Quality',
          title: 'Event-based workflows are hard to measure',
          content: 'Mixpanel cannot cleanly represent some event-based workflows, which hurts reporting quality.',
          assignee: null,
          deadline: null,
          sourceStartMs: 0,
          sourceEndMs: 0,
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
          sourceEndMs: 0,
        },
      ],
      discussion: [],
      statusUpdates: [],
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

  it('falls back to a smaller Ollama context after an insufficient RAM response', async () => {
    const telemetry = vi.fn()
    const adaptiveProvider = new OllamaProvider('http://localhost:11434', 'test-model', {
      onTelemetry: telemetry,
    })
    const requestContextTokens: number[] = []

    vi.stubGlobal('fetch', vi.fn(async (_url, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { options?: { num_ctx?: number } }
      requestContextTokens.push(body.options?.num_ctx ?? 0)

      if (requestContextTokens.length === 1) {
        return new Response(
          JSON.stringify({
            error: 'model requires more system memory (8.3 GiB) than is available (5.5 GiB)',
          }),
          { status: 500 },
        )
      }

      return new Response(
        new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder()
            controller.enqueue(encoder.encode(`${JSON.stringify({
              message: {
                content: JSON.stringify({
                  decisions: [],
                  action_items: [],
                  information: [
                    {
                      topic: 'Planning',
                      title: 'Launch plan confirmed',
                      content: 'The launch plan was confirmed for next week.',
                      sourceStartMs: 0,
                      sourceEndMs: 0,
                    },
                  ],
                  discussion: [],
                  status_updates: [],
                }),
              },
            })}\n`))
            controller.close()
          },
        }),
        { status: 200 },
      )
    }))

    const result = await adaptiveProvider.summarize(
      'meeting-low-ram',
      '[00:00] [Chris] The launch plan was confirmed for next week.',
      undefined,
      5,
    )

    expect(result.information).toHaveLength(1)
    expect(requestContextTokens).toEqual([STANDARD_CONTEXT_TOKENS, LOW_MEMORY_CONTEXT_TOKENS])
    expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({
      meetingId: 'meeting-low-ram',
      event: 'ollama_low_memory_fallback_triggered',
      properties: expect.objectContaining({
        ollamaRequiredSystemMemoryGiB: 8.3,
        ollamaAvailableSystemMemoryGiB: 5.5,
      }),
    }))
    expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({
      event: 'ollama_low_memory_fallback_succeeded',
    }))
  })
})
