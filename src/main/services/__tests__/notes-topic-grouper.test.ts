import { describe, expect, it } from 'vitest'
import type { MeetingSegments, Segment, SegmentCategory } from '../../../shared/types'
import { NEEDS_REVIEW_TOPIC, OTHER_NOTES_TOPIC } from '../../../shared/notes-presentation'
import { assignPresentationTopics } from '../notes-topic-grouper'

function segment(
  id: string,
  category: SegmentCategory,
  title: string,
  content: string,
  startMs: number
): Segment {
  return {
    id,
    meetingId: 'meeting-1',
    category,
    topic: null,
    title,
    content,
    assignee: null,
    deadline: null,
    sourceStartMs: startMs,
    sourceEndMs: startMs + 1000
  }
}

function empty(): MeetingSegments {
  return {
    decisions: [],
    actionItems: [],
    information: [],
    discussion: [],
    statusUpdates: []
  }
}

describe('assignPresentationTopics', () => {
  it('keeps writer topics and quarantines corrupted records', () => {
    const input: MeetingSegments = {
      ...empty(),
      information: [
        segment('kept', 'information', 'Mac trial starts', 'Trial starts increased by 12% on Mac.', 1000)
      ],
      actionItems: [
        segment('junk', 'action_item', 'Broken task', 'KeŰ runningŰ This Annual default test', 2000)
      ]
    }
    input.information[0]!.topic = 'A/B Tests'

    const assigned = assignPresentationTopics(input)

    expect(input.information[0]?.topic).toBe('A/B Tests')
    expect(assigned.information[0]?.topic).toBe('A/B Tests')
    expect(assigned.actionItems[0]?.topic).toBe(NEEDS_REVIEW_TOPIC)
    expect(assigned.actionItems[0]?.content).toBe('KeŰ runningŰ This Annual default test')
  })

  it('groups topicless records by shared terms and time without dropping any', () => {
    const assigned = assignPresentationTopics({
      ...empty(),
      information: [
        segment(
          'spread',
          'information',
          'Trial spread and leaders',
          'The trial spread and leaders are unchanged versus last week.',
          10_000
        ),
        segment(
          'revenue',
          'information',
          'Trial revenue',
          'Trial revenue moved with the same experiment cohort.',
          40_000
        ),
        segment(
          'email',
          'information',
          'Signup email campaign',
          'The signup email campaign failed to send after install.',
          400_000
        )
      ]
    })

    const topics = assigned.information.map((row) => row.topic)
    expect(topics.every((topic) => topic && topic !== 'Information')).toBe(true)
    expect(new Set(topics).size).toBeGreaterThanOrEqual(2)
    expect(assigned.information).toHaveLength(3)
  })

  it('sends weak singletons to Other Notes instead of inventing a chapter', () => {
    const assigned = assignPresentationTopics({
      ...empty(),
      information: [segment('weak', 'information', 'Note', 'The build shipped.', 1000)]
    })
    expect(assigned.information[0]?.topic).toBe(OTHER_NOTES_TOPIC)
  })

  it('refuses leftover titles and dumps overflow instead of merging chapters', () => {
    const assigned = assignPresentationTopics({
      ...empty(),
      information: [
        segment('id', 'information', 'Identified', 'The team identified a board counting issue.', 1_000),
        segment('share', 'information', 'Share Politic', 'Share Politic.', 2_000),
        segment(
          'sub',
          'information',
          'Subscription status page',
          'The subscription status page shows the wrong upgrade panel.',
          10_000
        ),
        segment(
          'flag',
          'information',
          'Subscription upgrade panel',
          'A feature flag will hide the subscription upgrade panel.',
          12_000
        )
      ],
      actionItems: [
        segment('junk', 'action_item', 'Share Politic', 'Share Politic.', 3_000)
      ]
    })

    expect(assigned.information.find((row) => row.id === 'id')?.topic).toMatch(
      /board|analytics|counting/i
    )
    expect(assigned.actionItems[0]?.topic).toBe(NEEDS_REVIEW_TOPIC)
    expect(assigned.information.find((row) => row.id === 'sub')?.topic).toMatch(/subscription/i)
    expect(assigned.information.some((row) => row.topic === 'Identified')).toBe(false)
    expect(assigned.information.some((row) => row.topic === 'Information')).toBe(false)
  })

  it('names leftover gerund titles from content and quarantines leftover fragments', () => {
    const assigned = assignPresentationTopics({
      ...empty(),
      statusUpdates: [
        segment('logs', 'status_update', 'But logs show it was running', 'But logs show it was running', 1_000),
        segment(
          'shot',
          'status_update',
          'Indicating',
          'Screenshot shows the Duet icon in the menu bar, indicating user confusion about app behavior',
          2_000
        )
      ],
      information: [
        segment(
          'tier',
          'information',
          'Free tier requirements document is evolving',
          'Matt has posted an evolving requirements document for the free tier, open to feedback as implementation progresses.',
          3_000
        )
      ],
      actionItems: [
        segment(
          'link',
          'action_item',
          'Send the link again',
          'Send the link again to review and discuss with La Raul and baby low levels.',
          4_000
        )
      ]
    })

    expect(assigned.statusUpdates.find((row) => row.id === 'logs')?.topic).toBe(NEEDS_REVIEW_TOPIC)
    expect(assigned.statusUpdates.find((row) => row.id === 'shot')?.topic).not.toBe('Indicating')
    expect(assigned.information[0]?.topic).not.toBe(OTHER_NOTES_TOPIC)
    expect(assigned.actionItems[0]?.topic).toBe(NEEDS_REVIEW_TOPIC)
  })
})
