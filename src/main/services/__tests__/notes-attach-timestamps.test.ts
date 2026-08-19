import { describe, expect, it } from 'vitest'
import type { CatalogItem } from '../../../../scripts/notes-writer-probe/groups.ts'
import type { MeetingNotesContent, NoteItem, NoteSourceRange } from '../../../shared/types'
import { attachNotesTimestamps, isMeetingSpanOnly } from '../notes-attach-timestamps'

function catalogItem(
  id: string,
  text: string,
  startMs: number,
  endMs: number,
  topic = 'Analytics',
  extraSources: NoteSourceRange[] = []
): CatalogItem {
  return {
    id,
    titleLine: text,
    fullText: text,
    item: {
      id,
      title: text,
      content: text,
      topic,
      bucket: 'information',
      owner: null,
      deadline: null,
      sources: [{ startMs, endMs }, ...extraSources],
      children: []
    }
  }
}

function item(text: string, startMs = 0, endMs = 5000): NoteItem {
  return {
    id: text,
    title: text,
    topic: null,
    owner: null,
    deadline: null,
    text,
    sources: [{ startMs, endMs }],
    provenance: 'generated',
    completed: false
  }
}

function content(partial: Partial<MeetingNotesContent>): MeetingNotesContent {
  return {
    overview: null,
    keyTakeaways: [],
    sections: [],
    decisions: [],
    nextSteps: [],
    ...partial
  }
}

function attachKeyPoint(
  text: string,
  topical: CatalogItem[],
  meetingSpan: readonly NoteSourceRange[],
  groupIds?: string[]
) {
  const attached = attachNotesTimestamps(
    content({
      sections: [
        {
          id: 's1',
          title: 'Analytics',
          summary: null,
          keyPoints: [item(text)],
          supportingDetails: []
        }
      ]
    }),
    {
      topical,
      actions: [],
      groups: [{ name: 'Analytics', ids: groupIds ?? topical.map((row) => row.id) }],
      meetingSpan
    }
  )
  return attached.sections[0]?.keyPoints[0]
}

describe('attachNotesTimestamps', () => {
  const meetingSpan = [{ startMs: 0, endMs: 5000 }]

  it('keeps unrestyled item ranges when the output line matches that catalog item', () => {
    const first = catalogItem('i01', 'HP opt-in analytics rate is 80-95 percent', 1000, 1600)
    const attached = attachKeyPoint(
      'HP opt-in analytics rate is 80-95 percent',
      [first],
      meetingSpan
    )

    expect(attached?.sources).toEqual([{ startMs: 1000, endMs: 1600 }])
  })

  it('unions ranges when a restyled bullet merges several catalog items', () => {
    const first = catalogItem('i01', 'Consent to Analytics events needs a fix', 1000, 1400)
    const second = catalogItem('i02', 'Login events should be collected from all users', 20000, 26000)
    const attached = attachKeyPoint(
      'Consent to Analytics and login events from all users',
      [first, second],
      [{ startMs: 0, endMs: 120000 }]
    )

    expect(attached?.sources).toEqual([
      { startMs: 1000, endMs: 1400 },
      { startMs: 20000, endMs: 26000 }
    ])
  })

  it('copies the meeting span when the bullet has no confident catalog match', () => {
    const first = catalogItem('i01', 'Completely unrelated alpha topic', 1000, 1400)
    const second = catalogItem('i02', 'Completely unrelated beta topic', 3000, 3600)
    const takeaway = item('We should look at the broader rollout')
    const nextStep = item('Schedule a follow-up with legal')
    const attached = attachNotesTimestamps(
      content({
        keyTakeaways: [takeaway],
        sections: [
          {
            id: 's1',
            title: 'Analytics',
            summary: null,
            keyPoints: [item('We should look at the broader rollout')],
            supportingDetails: [item('Nothing in this note matches catalog items')]
          }
        ],
        nextSteps: [nextStep]
      }),
      {
        topical: [first, second],
        actions: [catalogItem('a01', 'Completely unrelated action topic', 4000, 4500)],
        groups: [{ name: 'Analytics', ids: ['i01', 'i02'] }],
        meetingSpan
      }
    )

    expect(attached.keyTakeaways[0]?.sources).toEqual(meetingSpan)
    expect(attached.sections[0]?.keyPoints[0]?.sources).toEqual(meetingSpan)
    expect(attached.sections[0]?.supportingDetails[0]?.sources).toEqual(meetingSpan)
    expect(attached.nextSteps[0]?.sources).toEqual(meetingSpan)
    expect(isMeetingSpanOnly(attached.sections[0]?.keyPoints[0]?.sources ?? [], meetingSpan)).toBe(
      true
    )
  })

  it('keeps only the top-scoring catalog items when a bullet loosely overlaps many', () => {
    const meeting = [{ startMs: 0, endMs: 200000 }]
    const topical = [
      catalogItem(
        'i01',
        'weekly analytics login events consent tracking collected',
        10000,
        11000
      ),
      catalogItem('i02', 'login events should be collected from users', 40000, 41000),
      catalogItem('i03', 'analytics events collected from paying users', 70000, 71000),
      catalogItem('i04', 'consent tracking weekly rollout', 100000, 101000),
      catalogItem('i05', 'should tracking analytics users', 130000, 131000),
      catalogItem('i06', 'login events analytics only here', 160000, 161000)
    ]
    const attached = attachKeyPoint(
      'weekly analytics login events consent tracking should be collected from paying users',
      topical,
      meeting
    )

    expect(attached?.sources).toEqual([
      { startMs: 10000, endMs: 11000 },
      { startMs: 40000, endMs: 41000 },
      { startMs: 70000, endMs: 71000 }
    ])
  })

  it('merges overlapping or near-adjacent ranges and caps at five', () => {
    const meeting = [{ startMs: 0, endMs: 400000 }]
    const first = catalogItem('i01', 'weekly analytics login events consent tracking collected', 10000, 20000, 'Analytics', [
      { startMs: 25000, endMs: 35000 }
    ])
    const second = catalogItem('i02', 'login events should be collected from users', 40000, 50000, 'Analytics', [
      { startMs: 90000, endMs: 100000 }
    ])
    const third = catalogItem('i03', 'analytics events collected from paying users', 130000, 140000, 'Analytics', [
      { startMs: 170000, endMs: 180000 },
      { startMs: 210000, endMs: 220000 },
      { startMs: 250000, endMs: 260000 }
    ])
    const attached = attachKeyPoint(
      'weekly analytics login events consent tracking should be collected from paying users',
      [first, second, third],
      meeting
    )

    expect(attached?.sources).toEqual([
      { startMs: 10000, endMs: 50000 },
      { startMs: 90000, endMs: 100000 },
      { startMs: 130000, endMs: 140000 },
      { startMs: 170000, endMs: 180000 },
      { startMs: 210000, endMs: 220000 }
    ])
  })

  it('collapses a union that covers at least half the meeting to the meeting span', () => {
    const meeting = [{ startMs: 0, endMs: 10000 }]
    const first = catalogItem('i01', 'Consent to Analytics events needs a fix', 1000, 4000)
    const second = catalogItem('i02', 'Login events should be collected from all users', 5000, 8000)
    const attached = attachKeyPoint(
      'Consent to Analytics and login events from all users',
      [first, second],
      meeting
    )

    expect(attached?.sources).toEqual(meeting)
    expect(isMeetingSpanOnly(attached?.sources ?? [], meeting)).toBe(true)
  })

  it('collapses a union whose extent covers most of the meeting to the meeting span', () => {
    const meeting = [{ startMs: 0, endMs: 100000 }]
    const first = catalogItem('i01', 'Consent to Analytics events needs a fix', 5000, 6000)
    const second = catalogItem('i02', 'Login events should be collected from all users', 90000, 91000)
    const attached = attachKeyPoint(
      'Consent to Analytics and login events from all users',
      [first, second],
      meeting
    )

    expect(attached?.sources).toEqual(meeting)
    expect(isMeetingSpanOnly(attached?.sources ?? [], meeting)).toBe(true)
  })

  it('copies next-step times from the matching action item', () => {
    const action = catalogItem('a01', 'Review the offline analytics PR', 4000, 4500)
    action.item.bucket = 'actionItems'
    const attached = attachNotesTimestamps(
      content({
        nextSteps: [item('Review the offline analytics PR')]
      }),
      {
        topical: [],
        actions: [action],
        groups: [],
        meetingSpan
      }
    )

    expect(attached.nextSteps[0]?.sources).toEqual([{ startMs: 4000, endMs: 4500 }])
  })

  it('detects meeting-span stubs so Jump to can stay hidden', () => {
    expect(isMeetingSpanOnly([{ startMs: 0, endMs: 5000 }], meetingSpan)).toBe(true)
    expect(isMeetingSpanOnly([{ startMs: 1000, endMs: 1600 }], meetingSpan)).toBe(false)
  })
})
