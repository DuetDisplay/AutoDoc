import { afterEach, describe, it, expect, vi } from 'vitest'
import {
  LOW_MEMORY_CONTEXT_TOKENS,
  MAC_CONTEXT_TOKENS,
  OllamaProvider,
  STANDARD_CONTEXT_TOKENS,
  WINDOWS_CHUNK_CHARS,
  WINDOWS_MAX_OUTPUT_TOKENS,
  WINDOWS_CONTEXT_TOKENS
} from '../llm'

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
    vi.unstubAllGlobals()
    vi.clearAllMocks()
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
      process.platform === 'darwin' ? 605_000 : 600_000
    )
    expect(result.actionItems[0].sourceEndMs).toBe(
      process.platform === 'darwin' ? 605_000 : 600_000
    )
  })

  it('anchors macOS note timestamps to the strongest matching transcript evidence', () => {
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
      process.platform === 'darwin' ? 620_000 : 600_000
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
      expect(systemPrompt).toContain('MAC QUALITY TUNING OVERRIDE')

      tunedProvider.setLowMemoryMode(true)
      expect((tunedProvider as any).chunkTranscript(longTranscript)).toHaveLength(3)
      return
    }

    expect(chunks).toHaveLength(process.platform === 'win32' ? 2 : 3)
    expect(systemPrompt).not.toContain('MAC QUALITY TUNING OVERRIDE')
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

  it('does not let unsupported pricing headings win canonical topic selection on macOS', () => {
    const tunedProvider = new OllamaProvider('http://localhost:11434', 'test-model')
    const canonical = (tunedProvider as any).pickCanonicalTopic({
      segments: [
        {
          topic: 'Pricing & Costs',
          title: 'Retina setting default changed',
          content: 'The team discussed the retina setting and resolution behavior.'
        },
        {
          topic: 'Pricing & Costs',
          title: 'Feature flag issue needs cleanup',
          content: 'The local discovery feature flag needs refactoring before it ships.'
        },
        {
          topic: 'Pricing & Costs',
          title: 'Stylus hover implementation changed',
          content: 'The iOS and desktop sides need changes for stylus hover behavior.'
        },
        {
          topic: 'Technical Changes',
          title: 'Technical changes grouped together',
          content: 'The notes should use a technical chapter instead of a pricing chapter.'
        }
      ],
      labelCounts: new Map([
        ['Pricing & Costs', 3],
        ['Technical Changes', 1]
      ])
    })

    expect(canonical).toBe(process.platform === 'darwin' ? 'Technical Changes' : 'Pricing & Costs')
  })

  it('consolidates macOS local note topics into broad topic families', () => {
    const tunedProvider = new OllamaProvider('http://localhost:11434', 'test-model')
    const segments = {
      decisions: [
        {
          id: 'd1',
          meetingId: 'm1',
          category: 'decision',
          topic: 'Pricing & Costs',
          title: 'Retina setting default changed',
          content: 'The team agreed to make retina the default resolution setting.',
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

    ;(tunedProvider as any).consolidateMacTopicFamilies(segments)

    expect(segments.decisions[0].topic).toBe(
      process.platform === 'darwin' ? 'Technical Changes' : 'Pricing & Costs'
    )
  })

  it('stores ordered timestamp ranges for macOS notes', () => {
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

    if (process.platform === 'darwin') {
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

  it('uses constrained shorter notes generation on Windows', async () => {
    if (process.platform !== 'win32') {
      return
    }

    const windowsProvider = new OllamaProvider('http://localhost:11434', 'test-model')
    const requestBodies: Array<{
      format?: unknown
      messages?: Array<{ role: string; content: string }>
      options?: { num_predict?: number }
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
                              'The Windows notes generation path now uses a stricter response format.',
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
      '[00:00] [Chris] The Windows notes generation path now uses a stricter response format.',
      undefined,
      5
    )

    expect(result.information).toHaveLength(1)
    expect(requestBodies[0].format).toMatchObject({
      type: 'object',
      properties: {
        decisions: expect.objectContaining({ type: 'array' }),
        action_items: expect.objectContaining({ type: 'array' }),
        information: expect.objectContaining({ type: 'array' }),
        discussion: expect.objectContaining({ type: 'array' }),
        status_updates: expect.objectContaining({ type: 'array' })
      }
    })
    expect(requestBodies[0].options?.num_predict).toBe(WINDOWS_MAX_OUTPUT_TOKENS)
    expect(requestBodies[0].messages?.[1]?.content).toContain(
      'It is okay for action_items or status_updates to be empty'
    )
  })

  it('uses larger transcript chunks on Windows to reduce notes calls', () => {
    if (process.platform !== 'win32') {
      return
    }

    const windowsProvider = new OllamaProvider('http://localhost:11434', 'test-model')

    expect((windowsProvider as any).getChunkChars()).toBe(WINDOWS_CHUNK_CHARS)
  })
})
