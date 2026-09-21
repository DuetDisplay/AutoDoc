import { describe, expect, it } from 'vitest'
import type { MeetingSegments, NormalizedNoteItem, SegmentCategory } from '../../../shared/types'
import { adaptLegacySegments, LegacySegmentsAdapterError } from '../legacy-segments-adapter'

type LegacyFixtureSegment = {
  id?: string | null
  meetingId?: string | null
  category: SegmentCategory
  topic: string | null
  title: string
  content: string
  assignee: string | null
  deadline: string | null
  sourceStartMs: number
  sourceEndMs: number
}

function segment(
  overrides: Partial<LegacyFixtureSegment> & Pick<LegacyFixtureSegment, 'category' | 'content'>
): LegacyFixtureSegment {
  return {
    id: 'segment-id',
    meetingId: 'meeting-1',
    topic: null,
    title: '',
    assignee: null,
    deadline: null,
    sourceStartMs: 1_000,
    sourceEndMs: 2_000,
    ...overrides
  }
}

function fixture(): Record<keyof MeetingSegments, LegacyFixtureSegment[]> {
  return {
    decisions: [
      segment({
        id: 'duplicate',
        category: 'decision',
        topic: ' Architecture ',
        title: ' Keep title ',
        content: ' Keep decision content ',
        sourceStartMs: 605_000,
        sourceEndMs: 600_000
      }),
      segment({
        id: undefined,
        meetingId: undefined,
        category: 'decision',
        content: 'No source sentinel',
        sourceStartMs: 0,
        sourceEndMs: 0
      })
    ],
    actionItems: [
      segment({
        id: 'duplicate',
        category: 'action_item',
        content: 'Action at zero',
        assignee: ' Casey ',
        deadline: ' Friday ',
        sourceStartMs: 0,
        sourceEndMs: 400
      }),
      segment({
        id: 'legacy-item:decisions:1',
        category: 'action_item',
        content: 'Reserved raw id'
      })
    ],
    information: [
      segment({
        id: 'information-first',
        category: 'information',
        topic: 'Alpha',
        content: 'First Alpha',
        sourceStartMs: 30_000,
        sourceEndMs: 31_000
      }),
      segment({
        id: 'information-second',
        category: 'information',
        topic: 'Alpha',
        content: 'Second Alpha',
        sourceStartMs: 5_000,
        sourceEndMs: 6_000
      }),
      segment({
        id: 'information-empty',
        category: 'information',
        topic: '',
        content: 'Ungrouped information'
      })
    ],
    discussion: [
      segment({
        id: 'discussion',
        category: 'discussion',
        topic: 'Alpha',
        content: 'Discussion remains a separate section'
      })
    ],
    statusUpdates: [
      segment({
        id: 'status',
        category: 'status_update',
        content: 'Ungrouped status'
      })
    ]
  }
}

function allItems(notes: ReturnType<typeof adaptLegacySegments>): NormalizedNoteItem[] {
  return [
    ...notes.decisions,
    ...notes.nextSteps,
    ...notes.sections.flatMap((section) => [...section.keyPoints, ...section.supportingDetails])
  ]
}

describe('legacy segments adapter', () => {
  it('maps every bucket losslessly without mutating the legacy input', () => {
    const input = fixture()
    const before = structuredClone(input)

    const notes = adaptLegacySegments('meeting-1', input)

    expect(input).toEqual(before)
    expect(notes.sourceTranscriptRevision).toBeNull()
    expect(notes.sourceAttributionRevision).toBeNull()
    expect(notes.overview).toBeNull()
    expect(notes.keyTakeaways).toEqual([])
    expect(notes.decisions.map((item) => item.text)).toEqual([
      ' Keep decision content ',
      'No source sentinel'
    ])
    expect(notes.nextSteps.map((item) => item.text)).toEqual(['Action at zero', 'Reserved raw id'])
    expect(notes.sections.map((section) => section.title)).toEqual([
      'Alpha',
      'Information',
      'Alpha',
      'Status Updates'
    ])
    expect(notes.sections[0].keyPoints.map((item) => item.text)).toEqual([
      'First Alpha',
      'Second Alpha'
    ])
    expect(notes.sections[0].keyPoints.map((item) => item.sources)).toEqual([
      [{ startMs: 30_000, endMs: 31_000 }],
      [{ startMs: 5_000, endMs: 6_000 }]
    ])
    expect(notes.sections[1].keyPoints[0].topic).toBe('')
    expect(notes.sections.every((section) => section.supportingDetails.length === 0)).toBe(true)

    const firstDecision = notes.decisions[0]
    expect(firstDecision).toMatchObject({
      title: ' Keep title ',
      topic: ' Architecture ',
      provenance: 'legacy',
      sources: [{ startMs: 600_000, endMs: 605_000 }],
      legacySource: {
        bucket: 'decisions',
        itemIndex: 0,
        segmentId: 'duplicate',
        sourceStartMs: 605_000,
        sourceEndMs: 600_000
      }
    })
    expect(notes.decisions[1].sources).toEqual([])
    expect(notes.nextSteps[0]).toMatchObject({
      owner: ' Casey ',
      deadline: ' Friday ',
      sources: [{ startMs: 0, endMs: 400 }]
    })
  })

  it('keeps explicit provenance sufficient to reconstruct every original bucket and item order', () => {
    const input = fixture()
    const notes = adaptLegacySegments('meeting-1', input)
    const bucketOrder: Array<keyof MeetingSegments> = [
      'decisions',
      'actionItems',
      'information',
      'discussion',
      'statusUpdates'
    ]

    const origins = allItems(notes)
      .map((item) => ({ item, origin: item.legacySource! }))
      .sort(
        (a, b) =>
          bucketOrder.indexOf(a.origin.bucket) - bucketOrder.indexOf(b.origin.bucket) ||
          a.origin.itemIndex - b.origin.itemIndex
      )

    expect(origins).toHaveLength(Object.values(input).flat().length)
    for (const { item, origin } of origins) {
      const raw = input[origin.bucket][origin.itemIndex]
      expect(item.provenance).toBe('legacy')
      expect({
        title: item.title,
        content: item.text,
        topic: item.topic,
        assignee: item.owner,
        deadline: item.deadline,
        segmentId: origin.segmentId,
        meetingId: origin.meetingId,
        category: origin.category,
        sourceStartMs: origin.sourceStartMs,
        sourceEndMs: origin.sourceEndMs
      }).toEqual({
        title: raw.title,
        content: raw.content,
        topic: raw.topic,
        assignee: raw.assignee,
        deadline: raw.deadline,
        segmentId: raw.id ?? null,
        meetingId: raw.meetingId ?? null,
        category: raw.category,
        sourceStartMs: raw.sourceStartMs,
        sourceEndMs: raw.sourceEndMs
      })
    }
  })

  it('assigns globally unique deterministic IDs without colliding with raw IDs', () => {
    const input = fixture()
    const first = adaptLegacySegments('meeting-1', input)
    const second = adaptLegacySegments('meeting-1', input)
    const ids = [
      ...allItems(first).map((item) => item.id),
      ...first.sections.map((section) => section.id)
    ]

    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual([
      ...allItems(second).map((item) => item.id),
      ...second.sections.map((section) => section.id)
    ])
    expect(first.decisions[0].id).not.toBe('duplicate')
    expect(first.nextSteps[0].id).not.toBe('duplicate')
    expect(first.decisions[1].id).not.toBe('legacy-item:decisions:1')
    expect(first.nextSteps[1].id).toBe('legacy-item:decisions:1')
  })

  it('uses 0/0 only as the legacy no-source sentinel while retaining real zero-based and reversed ranges', () => {
    const input = fixture()
    input.decisions[0].sourceStartMs = 5_000
    input.decisions[0].sourceEndMs = 5_000
    input.decisions[1].sourceStartMs = 10_000
    input.decisions[1].sourceEndMs = 2_000

    const notes = adaptLegacySegments('meeting-1', input)

    expect(notes.decisions[0].sources).toEqual([{ startMs: 5_000, endMs: 5_000 }])
    expect(notes.decisions[1].sources).toEqual([{ startMs: 2_000, endMs: 10_000 }])
    expect(notes.nextSteps[0].sources).toEqual([{ startMs: 0, endMs: 400 }])
    expect(notes.decisions[1].legacySource).toMatchObject({
      sourceStartMs: 10_000,
      sourceEndMs: 2_000
    })
  })

  it('fails closed for a mismatched meeting but permits missing legacy meeting IDs', () => {
    const missing = fixture()
    missing.decisions[0].meetingId = null
    expect(
      adaptLegacySegments('meeting-1', missing).decisions[0].legacySource?.meetingId
    ).toBeNull()

    const mismatched = fixture()
    mismatched.decisions[0].meetingId = 'other-meeting'
    expect(() => adaptLegacySegments('meeting-1', mismatched)).toThrowError(
      expect.objectContaining({ code: 'meeting-mismatch' })
    )
  })

  it('uses the bucket as authority and exposes only content-free category diagnostics', () => {
    const input = fixture()
    input.information[0].category = 'discussion'
    input.information[0].content = 'SECRET CONTENT'
    const diagnostics: Array<{
      code: string
      bucket: keyof MeetingSegments
      category: SegmentCategory
    }> = []

    const notes = adaptLegacySegments('meeting-1', input, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    })

    expect(notes.sections[0].keyPoints[0].text).toBe('SECRET CONTENT')
    expect(notes.sections[0].keyPoints[0].legacySource?.category).toBe('discussion')
    expect(diagnostics).toEqual([
      { code: 'bucket-category-mismatch', bucket: 'information', category: 'discussion' }
    ])
    expect(JSON.stringify(diagnostics)).not.toContain('SECRET')
  })

  it('makes the legacy revision order- and whitespace-sensitive', () => {
    const input = fixture()
    const revision = adaptLegacySegments('meeting-1', input).revision

    expect(adaptLegacySegments('meeting-1', structuredClone(input)).revision).toBe(revision)

    const reordered = fixture()
    reordered.decisions.reverse()
    expect(adaptLegacySegments('meeting-1', reordered).revision).not.toBe(revision)

    const whitespaceChanged = fixture()
    whitespaceChanged.decisions[0].content = whitespaceChanged.decisions[0].content.trim()
    expect(adaptLegacySegments('meeting-1', whitespaceChanged).revision).not.toBe(revision)
  })

  it('reads Windows catalog files as items and next steps', () => {
    const notes = adaptLegacySegments('meeting-1', {
      items: [
        segment({
          id: 'item-1',
          category: 'information',
          title: 'Rollback needs a flag',
          content: 'The rollback needs a feature flag.'
        })
      ],
      nextSteps: [
        segment({
          id: 'step-1',
          category: 'action_item',
          title: 'Write the rollback plan',
          content: 'Chris will write the rollback plan.',
          assignee: 'Chris'
        })
      ]
    })

    expect(notes.sections).toHaveLength(1)
    expect(notes.sections[0].keyPoints[0].title).toBe('Rollback needs a flag')
    expect(notes.nextSteps).toHaveLength(1)
    expect(notes.nextSteps[0].title).toBe('Write the rollback plan')
    expect(notes.decisions).toHaveLength(0)
  })

  it.each([
    {},
    {
      decisions: [],
      actionItems: [],
      information: [],
      discussion: [],
      statusUpdates: [],
      extra: []
    },
    {
      decisions: [{ content: 'missing required fields' }],
      actionItems: [],
      information: [],
      discussion: [],
      statusUpdates: []
    }
  ])('rejects corrupt legacy input', (input) => {
    expect(() => adaptLegacySegments('meeting-1', input)).toThrow(LegacySegmentsAdapterError)
  })
})
