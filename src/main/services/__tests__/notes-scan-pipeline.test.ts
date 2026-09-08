import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeetingSegments, Segment } from '../../../shared/types'
import { emptyValidationStats } from '../notes-evidence-validate'
import {
  restyleRejectReason,
  runNotesScanPipeline,
  scanLayerProgress,
  type NotesRewritePolicy,
  type ScanGenerateRequest
} from '../notes-scan-pipeline'

function segment(partial: Partial<Segment> & Pick<Segment, 'id' | 'category' | 'title'>): Segment {
  return {
    meetingId: 'meeting-1',
    topic: 'Analytics',
    content: partial.content ?? partial.title,
    assignee: null,
    deadline: null,
    sourceStartMs: 1000,
    sourceEndMs: 2000,
    ...partial
  }
}

const SYNTHESIZED_OVERVIEW = 'The team locked login analytics coverage and assigned the offline review.'

function overviewGenerate(): ReturnType<typeof vi.fn> {
  return vi.fn(async () => JSON.stringify({ overview: SYNTHESIZED_OVERVIEW }))
}

function segments(): MeetingSegments {
  return {
    decisions: [
      segment({
        id: 'd1',
        category: 'decision',
        title: 'Login event data collection decision',
        content: 'The team decided to collect login events from all users.'
      })
    ],
    actionItems: [
      segment({
        id: 'a1',
        category: 'action_item',
        title: 'Review the offline analytics PR',
        content: 'Norbert will review the offline analytics PR.',
        assignee: 'Norbert'
      })
    ],
    information: [
      segment({
        id: 'i1',
        category: 'information',
        title: 'HP opt-in rate',
        content: "HP's opt-in analytics rate for gaming PCs is 80-95%."
      })
    ],
    discussion: [],
    statusUpdates: []
  }
}

const platform = Object.getOwnPropertyDescriptor(process, 'platform')

describe('runNotesScanPipeline', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  })

  afterEach(() => {
    if (platform) Object.defineProperty(process, 'platform', platform)
  })

  it('presents every writer record and asks only for a synthesized overview', async () => {
    const input = segments()
    input.actionItems.push(
      segment({
        id: 'a2',
        category: 'action_item',
        title: 'Send the rollout update',
        content: 'Send the rollout update after QA clears.',
        sourceStartMs: 3000,
        sourceEndMs: 4000
      }),
      segment({
        id: 'a3',
        category: 'action_item',
        title: 'Share the signed build',
        content: 'Share the signed build with beta users.',
        assignee: 'them',
        sourceStartMs: 5000,
        sourceEndMs: 6000
      })
    )
    const generate = overviewGenerate()
    const progress: string[] = []

    const result = await runNotesScanPipeline(input, {
      title: 'Standup',
      meetingId: 'meeting-1',
      presentationMode: 'lossless',
      attributionTranscript: [
        {
          id: 't0',
          meetingId: 'meeting-1',
          speaker: 'them',
          text: 'I asked Norbert about the offline analytics PR.',
          startMs: 100,
          endMs: 500,
          confidence: 1
        },
        {
          id: 't1',
          meetingId: 'meeting-1',
          speaker: 'them',
          text: 'Norbert will review the offline analytics PR.',
          startMs: 1100,
          endMs: 1900,
          confidence: 1
        },
        {
          id: 't2',
          meetingId: 'meeting-1',
          speaker: 'me',
          text: "I'll send the rollout update after QA clears.",
          startMs: 3100,
          endMs: 3900,
          confidence: 1
        },
        {
          id: 't3',
          meetingId: 'meeting-1',
          speaker: 'them',
          text: "I'll share the signed build with beta users.",
          startMs: 5100,
          endMs: 5900,
          confidence: 1
        }
      ],
      localOwnerLabel: 'Me',
      spanSources: [{ startMs: 0, endMs: 7000 }],
      generate,
      onProgress: (update) => progress.push(update.stage)
    })

    const presentedItems = [
      ...result.content.decisions,
      ...result.content.nextSteps,
      ...result.content.sections.flatMap((section) => [
        ...section.keyPoints,
        ...section.supportingDetails
      ])
    ]
    expect(generate).toHaveBeenCalledTimes(1)
    expect(generate.mock.calls[0]?.[0]).toMatchObject({
      num_predict: 256,
      format: { required: ['overview'] }
    })
    expect(generate.mock.calls[0]?.[0].prompt).toContain('one or two short sentences')
    expect(generate.mock.calls[0]?.[0].prompt).not.toContain('keyTakeaways')
    expect(presentedItems.map((item) => item.id).sort()).toEqual(['a1', 'a2', 'a3', 'd1', 'i1'])
    expect(result.content.decisions[0]).toMatchObject({
      id: 'd1',
      text: 'The team decided to collect login events from all users.'
    })
    expect(result.content.nextSteps).toEqual([
      expect.objectContaining({ id: 'a1', owner: 'Norbert' }),
      expect.objectContaining({ id: 'a2', owner: 'Me' }),
      expect.objectContaining({ id: 'a3', owner: null })
    ])
    expect(progress).toEqual(['scan-start', 'overview', 'lossless-presentation'])
    expect(result.validation).toEqual(emptyValidationStats(false))
    expect(result).toMatchObject({
      presentationMode: 'lossless',
      exactWriterCoverage: true,
      attributionOwnersAdded: 1,
      attributionOwnersStripped: 1,
      attributionOwnersPreserved: 1,
      recoveredActionCount: 0,
      dedupedRecoveredActionCount: 3,
      recoveredDecisionCount: 0,
      overviewSkipped: false
    })
    expect(result.content.overview?.text).toBe(SYNTHESIZED_OVERVIEW)
    expect(result.overviewFailed).toBe(false)
    expect(result.content.keyTakeaways.length).toBeGreaterThan(0)
    expect(result.content.keyTakeaways.every((item) => item.id.startsWith('lossless-takeaway:'))).toBe(
      true
    )
  })

  it('recovers accepted decisions before presentation without another model call', async () => {
    const generate = overviewGenerate()
    const result = await runNotesScanPipeline(
      {
        decisions: [],
        actionItems: [],
        information: [],
        discussion: [],
        statusUpdates: []
      },
      {
        title: 'Launch planning',
        meetingId: 'meeting-1',
        presentationMode: 'lossless',
        attributionTranscript: [
          {
            id: 'proposal',
            meetingId: 'meeting-1',
            speaker: 'me',
            text: 'Should we ship the beta on Friday?',
            startMs: 1_000,
            endMs: 2_000,
            confidence: 1
          },
          {
            id: 'acceptance',
            meetingId: 'meeting-1',
            speaker: 'them',
            text: 'Yeah, sounds good.',
            startMs: 2_500,
            endMs: 3_500,
            confidence: 1
          }
        ],
        spanSources: [{ startMs: 1_000, endMs: 3_500 }],
        generate
      }
    )

    expect(generate).toHaveBeenCalledTimes(1)
    expect(result.content.decisions).toEqual([
      expect.objectContaining({
        title: 'Ship the beta on Friday',
        text: 'Ship the beta on Friday.'
      })
    ])
    expect(result.content.overview?.text).toBe(SYNTHESIZED_OVERVIEW)
    expect(result).toMatchObject({
      recoveredDecisionCount: 1,
      promotedDecisionCount: 0,
      exactWriterCoverage: true
    })
  })

  it('recovers an uncovered local commitment before lossless presentation without another model call', async () => {
    const generate = overviewGenerate()
    const result = await runNotesScanPipeline(
      {
        decisions: [],
        actionItems: [],
        information: [],
        discussion: [],
        statusUpdates: []
      },
      {
        title: 'Release review',
        meetingId: 'meeting-1',
        presentationMode: 'lossless',
        attributionTranscript: [
          {
            id: 'sergio-commitment',
            meetingId: 'meeting-1',
            speaker: 'me',
            text: "Yeah, I'll ping Sergio after the meeting just to find out when they'll be done testing.",
            startMs: 1_515_000,
            endMs: 1_521_000,
            confidence: 1
          }
        ],
        localOwnerLabel: 'Me',
        spanSources: [{ startMs: 1_515_000, endMs: 1_521_000 }],
        generate
      }
    )

    expect(generate).toHaveBeenCalledTimes(1)
    expect(result.content.nextSteps).toEqual([
      expect.objectContaining({
        title: 'Ping Sergio after the meeting',
        text: "Ping Sergio after the meeting just to find out when they'll be done testing.",
        owner: 'Me',
        deadline: null,
        sources: [{ startMs: 1_515_000, endMs: 1_521_000 }]
      })
    ])
    expect(result).toMatchObject({
      recoveredActionCount: 1,
      promotedActionCount: 0,
      exactWriterCoverage: true
    })
  })

  it('preserves exact-millisecond ownership and dedupes recovery for a cited local commitment', async () => {
    const generate = overviewGenerate()
    const result = await runNotesScanPipeline(
      {
        decisions: [],
        actionItems: [
          segment({
            id: 'writer-action',
            category: 'action_item',
            title: 'Send the estimate',
            content: 'Send the estimate after receiving the build.',
            sourceStartMs: 1100,
            sourceEndMs: 1100
          })
        ],
        information: [],
        discussion: [],
        statusUpdates: []
      },
      {
        title: 'Release review',
        meetingId: 'meeting-1',
        presentationMode: 'lossless',
        attributionTranscript: [
          {
            id: 'local-commitment',
            meetingId: 'meeting-1',
            speaker: 'me',
            text: "I'll send the estimate after receiving the build.",
            startMs: 1100,
            endMs: 1900,
            confidence: 1
          }
        ],
        localOwnerLabel: 'Me',
        spanSources: [{ startMs: 1100, endMs: 1900 }],
        generate
      }
    )

    expect(generate).toHaveBeenCalledTimes(1)
    expect(result.content.nextSteps).toEqual([
      expect.objectContaining({
        id: 'writer-action',
        owner: 'Me',
        sources: [{ startMs: 1100, endMs: 1100 }]
      })
    ])
    expect(result).toMatchObject({
      attributionOwnersAdded: 1,
      recoveredActionCount: 0,
      dedupedRecoveredActionCount: 1,
      exactWriterCoverage: true
    })
  })

  it('falls back to unrestyled topical text and still emits Next Steps without a Decisions footer', async () => {
    const result = await runNotesScanPipeline(segments(), {
      title: 'Standup',
      spanSources: [{ startMs: 0, endMs: 5000 }],
      generate: async () => 'not valid json'
    })

    expect(result.markdown).toContain('## Next Steps')
    expect(result.markdown).not.toMatch(/^## Decisions$/m)
    expect(result.content.decisions).toEqual([])
    expect(result.content.nextSteps.some((item) => item.title?.includes('offline analytics'))).toBe(
      true
    )
    expect(result.groupingFallback).toBe(false)
    expect(result.markdown).toMatch(/## (Analytics|HP opt-in rate)/)
    expect(result.attachFailed).toBe(false)
    expect(result.overviewFailed).toBe(true)
    expect(result.content.overview?.text).toMatch(
      /opt-in analytics rate|login events|offline analytics/i
    )
    expect(result.content.overview?.text).not.toMatch(/^This meeting (covered|focused on)/)
    expect(result.content.sections[0]?.keyPoints[0]?.sources[0]?.startMs).toBe(1000)
    expect(result.validation).toEqual(emptyValidationStats(false))
  })

  it('does not run transcript LLM validation and drops assertive overview takeaways', async () => {
    const generate = async (request: ScanGenerateRequest): Promise<string> => {
      if (request.prompt.includes('Summarize the finished meeting notes')) {
        return JSON.stringify({
          overview: 'Standup recap.',
          keyTakeaways: ['Team agreed to adopt the Mirror concept']
        })
      }
      return 'not valid json'
    }

    const result = await runNotesScanPipeline(segments(), {
      title: 'Standup',
      spanSources: [{ startMs: 0, endMs: 5000 }],
      transcript: [
        {
          speaker: 'Chris',
          text: 'The linear for this feature request is DD1450.',
          startMs: 0,
          endMs: 4000
        }
      ],
      generate
    })

    expect(result.validation).toEqual(emptyValidationStats(false))
    expect(result.overviewFailed).toBe(false)
    expect(result.content.overview?.text).toBe('Standup recap.')
    expect(result.content.keyTakeaways.some((row) => /agreed/i.test(row.text))).toBe(false)
    expect(
      result.content.sections.some((section) =>
        section.supportingDetails.some((row) => row.text.includes('DD1450'))
      )
    ).toBe(true)
  })

  it('reports scan progress inside the reserved 70-99 band', async () => {
    const seen: number[] = []
    await runNotesScanPipeline(segments(), {
      title: 'Standup',
      spanSources: [{ startMs: 0, endMs: 5000 }],
      generate: async () => 'not valid json',
      onProgress: (update) => {
        seen.push(scanLayerProgress(update.fraction))
      }
    })

    expect(seen[0]).toBe(70)
    expect(seen.at(-1)).toBe(99)
    expect(Math.max(...seen)).toBe(99)
    expect(seen.some((percent) => percent > 70 && percent < 99)).toBe(true)
  })

  it('does not make an overview model call on macOS lossless notes', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    const generate = overviewGenerate()
    const result = await runNotesScanPipeline(segments(), {
      title: 'Standup',
      meetingId: 'meeting-1',
      presentationMode: 'lossless',
      attributionTranscript: [
        {
          id: 't1',
          meetingId: 'meeting-1',
          speaker: 'them',
          text: 'The team decided to collect login events from all users.',
          startMs: 1100,
          endMs: 1900,
          confidence: 1
        }
      ],
      spanSources: [{ startMs: 0, endMs: 5000 }],
      generate
    })

    expect(generate).not.toHaveBeenCalled()
    expect(result.content.overview?.text).toBe(
      'The team decided to collect login events from all users.'
    )
    expect(result.overviewFailed).toBe(false)
    expect(result.content.sections.some((section) => section.title === 'Other Notes')).toBe(false)
  })
})

describe('restyleRejectReason', () => {
  it('names the shared gate that rejected a rewrite', () => {
    expect(restyleRejectReason('Talk to Nora', 'Talk to Nora about i03')).toBe('catalog-id')
    expect(restyleRejectReason('Nora approved 16GB', 'Someone approved more RAM')).toBe('facts')
    expect(restyleRejectReason('Nora approved 16GB', 'Nora approved 16GB')).toBeNull()
  })
})

describe('scanLayerProgress', () => {
  it('maps the scan fraction onto 70-99 instead of a frozen 99', () => {
    expect(scanLayerProgress(0)).toBe(70)
    expect(scanLayerProgress(1)).toBe(99)
    expect(scanLayerProgress(0.5)).toBeGreaterThan(70)
    expect(scanLayerProgress(0.5)).toBeLessThan(99)
  })
})

const STRICT_REWRITE_POLICY: NotesRewritePolicy = {
  maxAttemptsPerSection: 1,
  bailAfterConsecutiveRejects: 2
}

const FOUR_TOPICS = [
  {
    name: 'Checkout Latency Spike',
    title: 'Checkout latency',
    content: 'Nora measured 12ms checkout latency.',
    accepted: '- Nora measured 12ms checkout latency.'
  },
  {
    name: 'HP Gaming Opt-in',
    title: 'HP opt-in',
    content: "HP's opt-in analytics rate for gaming PCs is 80-95%.",
    accepted: "- HP's opt-in analytics rate for gaming PCs is 80-95%."
  },
  {
    name: 'Offline Analytics Ticket',
    title: 'Offline analytics',
    content: 'Chris filed DD1450 for offline analytics.',
    accepted: '- Chris filed DD1450 for offline analytics.'
  },
  {
    name: 'Login Volume Snapshot',
    title: 'Login volume',
    content: 'Login events reached 16GB yesterday.',
    accepted: '- Login events reached 16GB yesterday.'
  }
] as const

function fourTopicSegments(): MeetingSegments {
  return {
    decisions: [],
    actionItems: [],
    information: FOUR_TOPICS.map((topic, index) =>
      segment({
        id: `t${index + 1}`,
        category: 'information',
        title: topic.title,
        topic: topic.name,
        content: topic.content
      })
    ),
    discussion: [],
    statusUpdates: []
  }
}

function groupingJson(): string {
  return JSON.stringify({
    groups: FOUR_TOPICS.map((topic, index) => ({
      name: topic.name,
      ids: [`i${String(index + 1).padStart(2, '0')}`]
    }))
  })
}

function promptKind(prompt: string): 'group' | 'restyle' | 'compress' | 'overview' {
  if (prompt.includes('assign existing meeting-note items to topic groups')) return 'group'
  if (prompt.includes('rewriting one section of existing meeting notes')) return 'restyle'
  if (prompt.includes('compressing one section of existing meeting notes')) return 'compress'
  if (prompt.includes('Summarize the finished meeting notes')) return 'overview'
  throw new Error(`unexpected prompt: ${prompt.slice(0, 80)}`)
}

function sectionTopic(prompt: string): string {
  const match = prompt.match(/^Section topic:\s*(.+)$/m)
  return match?.[1]?.trim() ?? ''
}

function acceptedRestyle(topicName: string): string {
  const topic = FOUR_TOPICS.find((row) => row.name === topicName)
  if (!topic) throw new Error(`unknown restyle topic: ${topicName}`)
  return topic.accepted
}

function overviewJson(): string {
  return JSON.stringify({
    overview:
      'The team reviewed checkout latency, opt-in rate, offline analytics, and login volume.',
    keyTakeaways: ['Nora measured 12ms checkout latency']
  })
}

const REJECTED_REWRITE = 'Talk to Nora about i03'

function recordCalls(): {
  kinds: Array<'group' | 'restyle' | 'compress' | 'overview'>
  restyleTopics: string[]
  compressTopics: string[]
} {
  return { kinds: [], restyleTopics: [], compressTopics: [] }
}

describe('runNotesScanPipeline rewrite policy', () => {
  it('uses two restyle/compress attempts under the default policy and records no skips', async () => {
    const calls = recordCalls()
    const result = await runNotesScanPipeline(fourTopicSegments(), {
      title: 'Standup',
      spanSources: [{ startMs: 0, endMs: 5000 }],
      generate: async (request) => {
        const kind = promptKind(request.prompt)
        calls.kinds.push(kind)
        if (kind === 'group') return groupingJson()
        if (kind === 'restyle') {
          calls.restyleTopics.push(sectionTopic(request.prompt))
          return REJECTED_REWRITE
        }
        if (kind === 'compress') {
          calls.compressTopics.push(sectionTopic(request.prompt))
          return REJECTED_REWRITE
        }
        return overviewJson()
      }
    })

    expect(new Set(calls.restyleTopics).size).toBe(4)
    expect(calls.restyleTopics.filter((topic) => topic === FOUR_TOPICS[0].name)).toHaveLength(2)
    expect(calls.compressTopics.filter((topic) => topic === FOUR_TOPICS[0].name)).toHaveLength(2)
    expect(result.restyleSkips).toBe(0)
    expect(result.compressSkips).toBe(0)
    expect(result.restyleFallbacks).toBe(4)
    expect(result.compressFallbacks).toBe(4)
  })

  it('makes one restyle attempt per section when maxAttemptsPerSection is 1', async () => {
    const calls = recordCalls()
    await runNotesScanPipeline(fourTopicSegments(), {
      title: 'Standup',
      spanSources: [{ startMs: 0, endMs: 5000 }],
      rewritePolicy: STRICT_REWRITE_POLICY,
      generate: async (request) => {
        const kind = promptKind(request.prompt)
        calls.kinds.push(kind)
        if (kind === 'group') return groupingJson()
        if (kind === 'restyle') {
          calls.restyleTopics.push(sectionTopic(request.prompt))
          return REJECTED_REWRITE
        }
        if (kind === 'compress') return REJECTED_REWRITE
        return overviewJson()
      }
    })

    expect(calls.restyleTopics.filter((topic) => topic === FOUR_TOPICS[0].name)).toHaveLength(1)
  })

  it('skips later restyles after consecutive rejects and still runs grouping plus overview', async () => {
    const calls = recordCalls()
    const progress: string[] = []
    const result = await runNotesScanPipeline(fourTopicSegments(), {
      title: 'Standup',
      spanSources: [{ startMs: 0, endMs: 5000 }],
      rewritePolicy: STRICT_REWRITE_POLICY,
      onProgress: (update) => {
        progress.push(update.stage)
      },
      generate: async (request) => {
        const kind = promptKind(request.prompt)
        calls.kinds.push(kind)
        if (kind === 'group') return groupingJson()
        if (kind === 'restyle') {
          calls.restyleTopics.push(sectionTopic(request.prompt))
          return REJECTED_REWRITE
        }
        if (kind === 'compress') {
          calls.compressTopics.push(sectionTopic(request.prompt))
          return acceptedRestyle(sectionTopic(request.prompt))
        }
        return overviewJson()
      }
    })

    expect(calls.restyleTopics).toEqual([FOUR_TOPICS[0].name, FOUR_TOPICS[1].name])
    expect(result.restyleFallbacks).toBe(2)
    expect(result.restyleRejectReasons).toHaveLength(2)
    expect(result.restyleSkips).toBe(2)
    expect(calls.kinds.filter((kind) => kind === 'group')).toHaveLength(1)
    expect(calls.kinds.filter((kind) => kind === 'overview')).toHaveLength(1)
    expect(progress.filter((stage) => stage === 'restyle')).toHaveLength(4)
  })

  it('resets the restyle consecutive-reject counter after an accepted rewrite', async () => {
    const calls = recordCalls()
    const result = await runNotesScanPipeline(fourTopicSegments(), {
      title: 'Standup',
      spanSources: [{ startMs: 0, endMs: 5000 }],
      rewritePolicy: STRICT_REWRITE_POLICY,
      generate: async (request) => {
        const kind = promptKind(request.prompt)
        calls.kinds.push(kind)
        if (kind === 'group') return groupingJson()
        if (kind === 'restyle') {
          const topic = sectionTopic(request.prompt)
          calls.restyleTopics.push(topic)
          return topic === FOUR_TOPICS[1].name ? acceptedRestyle(topic) : REJECTED_REWRITE
        }
        if (kind === 'compress') return acceptedRestyle(sectionTopic(request.prompt))
        return overviewJson()
      }
    })

    expect(calls.restyleTopics).toEqual(FOUR_TOPICS.map((topic) => topic.name))
    expect(result.restyleSkips).toBe(0)
    expect(result.restyleFallbacks).toBe(3)
  })

  it('makes one compress attempt per chunk when maxAttemptsPerSection is 1', async () => {
    const calls = recordCalls()
    await runNotesScanPipeline(fourTopicSegments(), {
      title: 'Standup',
      spanSources: [{ startMs: 0, endMs: 5000 }],
      rewritePolicy: STRICT_REWRITE_POLICY,
      generate: async (request) => {
        const kind = promptKind(request.prompt)
        if (kind === 'group') return groupingJson()
        if (kind === 'restyle') return acceptedRestyle(sectionTopic(request.prompt))
        if (kind === 'compress') {
          calls.compressTopics.push(sectionTopic(request.prompt))
          return REJECTED_REWRITE
        }
        return overviewJson()
      }
    })

    expect(calls.compressTopics.filter((topic) => topic === FOUR_TOPICS[0].name)).toHaveLength(1)
  })

  it('skips later compress chunks after consecutive rejects and leaves skipped text unchanged', async () => {
    const calls = recordCalls()
    const progress: string[] = []
    const result = await runNotesScanPipeline(fourTopicSegments(), {
      title: 'Standup',
      spanSources: [{ startMs: 0, endMs: 5000 }],
      rewritePolicy: STRICT_REWRITE_POLICY,
      onProgress: (update) => {
        progress.push(update.stage)
      },
      generate: async (request) => {
        const kind = promptKind(request.prompt)
        calls.kinds.push(kind)
        if (kind === 'group') return groupingJson()
        if (kind === 'restyle') return acceptedRestyle(sectionTopic(request.prompt))
        if (kind === 'compress') {
          calls.compressTopics.push(sectionTopic(request.prompt))
          return REJECTED_REWRITE
        }
        return overviewJson()
      }
    })

    expect(calls.compressTopics).toEqual([FOUR_TOPICS[0].name, FOUR_TOPICS[1].name])
    expect(result.compressFallbacks).toBe(2)
    expect(result.compressRejectReasons).toHaveLength(2)
    expect(result.compressSkips).toBe(2)
    expect(result.markdown).toContain('Chris filed DD1450 for offline analytics.')
    expect(result.markdown).toContain('Login events reached 16GB yesterday.')
    expect(calls.kinds.filter((kind) => kind === 'group')).toHaveLength(1)
    expect(calls.kinds.filter((kind) => kind === 'overview')).toHaveLength(1)
    expect(progress.filter((stage) => stage === 'compress')).toHaveLength(4)
  })

  it('resets the compress consecutive-reject counter after an accepted rewrite', async () => {
    const calls = recordCalls()
    const result = await runNotesScanPipeline(fourTopicSegments(), {
      title: 'Standup',
      spanSources: [{ startMs: 0, endMs: 5000 }],
      rewritePolicy: STRICT_REWRITE_POLICY,
      generate: async (request) => {
        const kind = promptKind(request.prompt)
        if (kind === 'group') return groupingJson()
        if (kind === 'restyle') return acceptedRestyle(sectionTopic(request.prompt))
        if (kind === 'compress') {
          const topic = sectionTopic(request.prompt)
          calls.compressTopics.push(topic)
          return topic === FOUR_TOPICS[1].name ? acceptedRestyle(topic) : REJECTED_REWRITE
        }
        return overviewJson()
      }
    })

    expect(calls.compressTopics).toEqual(FOUR_TOPICS.map((topic) => topic.name))
    expect(result.compressSkips).toBe(0)
    expect(result.compressFallbacks).toBe(3)
  })

  it('skips grouping and overview LLM when skipStructureLlm is set', async () => {
    const calls = recordCalls()
    const result = await runNotesScanPipeline(fourTopicSegments(), {
      title: 'Standup',
      spanSources: [{ startMs: 0, endMs: 5000 }],
      rewritePolicy: {
        maxAttemptsPerSection: 1,
        bailAfterConsecutiveRejects: 0,
        skipRewrites: true,
        skipStructureLlm: true
      },
      generate: async (request) => {
        calls.kinds.push(promptKind(request.prompt))
        throw new Error(`unexpected generate: ${request.prompt.slice(0, 40)}`)
      }
    })

    expect(calls.kinds).toEqual([])
    expect(result.overviewFailed).toBe(true)
    expect(result.overviewFailureReasons).toEqual(['structure-llm-skipped'])
    expect(result.content.overview?.text).toMatch(/opt-in|login|analytics|latency/i)
    expect(result.restyleSkips).toBe(4)
    expect(result.compressSkips).toBeGreaterThan(0)
  })
})
