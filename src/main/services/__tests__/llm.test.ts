import { describe, it, expect } from 'vitest'
import { OllamaProvider } from '../llm'

describe('OllamaProvider grounding', () => {
  const provider = new OllamaProvider('http://localhost:11434', 'test-model')

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
})
