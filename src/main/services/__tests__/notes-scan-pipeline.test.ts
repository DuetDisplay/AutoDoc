import { describe, expect, it } from 'vitest'
import type { MeetingSegments, Segment } from '../../../shared/types'
import { runNotesScanPipeline } from '../notes-scan-pipeline'

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
    expect(result.groupingFallback).toBe(true)
  })
})
