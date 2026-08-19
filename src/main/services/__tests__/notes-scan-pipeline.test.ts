import { describe, expect, it } from 'vitest'
import type { MeetingSegments, Segment } from '../../../shared/types'
import { emptyValidationStats } from '../notes-evidence-validate'
import {
  runNotesScanPipeline,
  scanLayerProgress,
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

describe('runNotesScanPipeline', () => {
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
    expect(result.content.overview?.text).toMatch(/This meeting (covered|focused on)/)
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
})

describe('scanLayerProgress', () => {
  it('maps the scan fraction onto 70-99 instead of a frozen 99', () => {
    expect(scanLayerProgress(0)).toBe(70)
    expect(scanLayerProgress(1)).toBe(99)
    expect(scanLayerProgress(0.5)).toBeGreaterThan(70)
    expect(scanLayerProgress(0.5)).toBeLessThan(99)
  })
})
