import { describe, expect, it } from 'vitest'
import type {
  MeetingNotesContent,
  MeetingSegments,
  Segment,
  SegmentCategory
} from '../../../shared/types'
import {
  ensureExactLosslessCoverage,
  hasExactLosslessCoverage,
  LosslessPresenterError,
  presentMeetingSegmentsLosslessly
} from '../notes-lossless-presenter'
import { parseMeetingNotesContent } from '../notes-schema'

const MEETING_ID = 'meeting-1'

function segment(id: string, category: SegmentCategory, overrides: Partial<Segment> = {}): Segment {
  return {
    id,
    meetingId: MEETING_ID,
    category,
    topic: null,
    title: `${id} title`,
    content: `${id} content`,
    assignee: null,
    deadline: null,
    sourceStartMs: 1_000,
    sourceEndMs: 2_000,
    ...overrides
  }
}

function fixture(): MeetingSegments {
  return {
    decisions: [
      segment('decision-1', 'decision', {
        topic: 'Rollout',
        title: 'Release at a 50/50 split',
        content: 'Release the free tier at a 50/50 split after QA clears.',
        sourceStartMs: 10_000,
        sourceEndMs: 12_000
      })
    ],
    actionItems: [
      segment('action-1', 'action_item', {
        topic: 'Rollout',
        title: 'Ping Sergio for the smoke-test ETA',
        content: 'Greg will ask Sergio for an estimate as soon as he receives a build.',
        assignee: 'Greg',
        deadline: 'When the build arrives',
        sourceStartMs: 20_000,
        sourceEndMs: 24_000
      })
    ],
    information: [
      segment('info-1', 'information', {
        topic: 'A/B Tests',
        title: 'Mac trial starts increased',
        content: 'Trial starts increased by 12% on Mac.',
        sourceStartMs: 30_000,
        sourceEndMs: 31_000
      }),
      segment('info-2', 'information', {
        topic: ' A/B Tests ',
        title: 'Windows trial starts increased',
        content: 'Trial starts increased by about 5% on Windows.',
        sourceStartMs: 32_000,
        sourceEndMs: 34_000
      }),
      segment('info-3', 'information', {
        topic: null,
        title: 'Stripe improved',
        content: 'Stripe was higher week over week for two consecutive days.',
        sourceStartMs: 35_000,
        sourceEndMs: 36_000
      })
    ],
    discussion: [
      segment('discussion-1', 'discussion', {
        topic: 'A/B Tests',
        title: 'Cancel-rate uncertainty',
        content: 'The team discussed two competing effects on cancellation rate.',
        sourceStartMs: 40_000,
        sourceEndMs: 44_000
      })
    ],
    statusUpdates: [
      segment('status-1', 'status_update', {
        topic: 'Mobile Releases',
        title: 'Android RC passed QA',
        content: 'The Android release started today.',
        sourceStartMs: 50_000,
        sourceEndMs: 52_000
      })
    ]
  }
}

function allItems(content: MeetingNotesContent) {
  return [
    ...content.decisions,
    ...content.nextSteps,
    ...content.sections.flatMap((section) => [...section.keyPoints, ...section.supportingDetails])
  ]
}

describe('lossless notes presenter', () => {
  it('preserves every writer record and its fields without mutating the input', () => {
    const segments = fixture()
    const before = structuredClone(segments)

    const content = presentMeetingSegmentsLosslessly(MEETING_ID, segments)

    expect(segments).toEqual(before)
    expect(() => parseMeetingNotesContent(content)).not.toThrow()
    expect(hasExactLosslessCoverage(segments, content)).toBe(true)
    expect(content.overview).toEqual({
      text: 'Release the free tier at a 50/50 split after QA clears.',
      sources: [{ startMs: 10_000, endMs: 12_000 }],
      provenance: 'generated'
    })
    expect(content.keyTakeaways).toHaveLength(3)
    expect(content.keyTakeaways.every((item) => item.id.startsWith('lossless-takeaway:'))).toBe(
      true
    )
    expect(
      allItems(content)
        .map((item) => item.id)
        .sort()
    ).toEqual(
      Object.values(segments)
        .flat()
        .map((item) => item.id)
        .sort()
    )
    expect(content.decisions).toEqual([
      expect.objectContaining({
        id: 'decision-1',
        title: 'Release at a 50/50 split',
        text: 'Release the free tier at a 50/50 split after QA clears.',
        topic: 'Rollout',
        sources: [{ startMs: 10_000, endMs: 12_000 }]
      })
    ])
    expect(content.nextSteps).toEqual([
      expect.objectContaining({
        id: 'action-1',
        title: 'Ping Sergio for the smoke-test ETA',
        text: 'Greg will ask Sergio for an estimate as soon as he receives a build.',
        owner: 'Greg',
        deadline: 'When the build arrives',
        sources: [{ startMs: 20_000, endMs: 24_000 }]
      })
    ])
  })

  it('merges trimmed writer topics across all non-footer categories without dropping IDs', () => {
    const content = presentMeetingSegmentsLosslessly(MEETING_ID, fixture())

    expect(content.sections.map((section) => section.title)).toEqual([
      'A/B Tests',
      'Information',
      'Mobile Releases'
    ])
    expect(content.sections.map((section) => section.id)).toEqual([
      expect.stringMatching(/^lossless-section:topical:/),
      expect.stringMatching(/^lossless-section:information:/),
      expect.stringMatching(/^lossless-section:topical:/)
    ])
    expect(content.sections[0]?.keyPoints.map((item) => item.id)).toEqual([
      'info-1',
      'info-2',
      'discussion-1'
    ])
    expect(content.sections[0]?.keyPoints.map((item) => item.topic)).toEqual([
      'A/B Tests',
      ' A/B Tests ',
      'A/B Tests'
    ])
    expect(content.sections[2]?.keyPoints.map((item) => item.id)).toEqual(['status-1'])
  })

  it('keeps separate category fallback headings for records without a writer topic', () => {
    const segments: MeetingSegments = {
      decisions: [],
      actionItems: [],
      information: [segment('info', 'information')],
      discussion: [segment('discussion', 'discussion', { topic: '   ' })],
      statusUpdates: [segment('status', 'status_update')]
    }

    const content = presentMeetingSegmentsLosslessly(MEETING_ID, segments)

    expect(content.sections.map((section) => section.title)).toEqual([
      'Information',
      'Discussion',
      'Status Updates'
    ])
    expect(content.sections.map((section) => section.id)).toEqual([
      expect.stringMatching(/^lossless-section:information:/),
      expect.stringMatching(/^lossless-section:discussion:/),
      expect.stringMatching(/^lossless-section:status_update:/)
    ])
    expect(hasExactLosslessCoverage(segments, content)).toBe(true)
  })

  it('does not impose the old eight-section grouping limit', () => {
    const segments: MeetingSegments = {
      decisions: [],
      actionItems: [],
      information: Array.from({ length: 12 }, (_, index) =>
        segment(`info-${index}`, 'information', { topic: `Topic ${index}` })
      ),
      discussion: [],
      statusUpdates: []
    }

    const content = presentMeetingSegmentsLosslessly(MEETING_ID, segments)

    expect(content.sections).toHaveLength(12)
    expect(allItems(content)).toHaveLength(12)
    expect(hasExactLosslessCoverage(segments, content)).toBe(true)
  })

  it('prefers a complete standalone outcome without relying on domain vocabulary', () => {
    const segments: MeetingSegments = {
      decisions: [],
      actionItems: [],
      information: [
        segment('brief', 'information', {
          topic: 'Hiring',
          content: 'Candidates were discussed.',
          sourceStartMs: 1_000
        }),
        segment('complete', 'information', {
          topic: 'Hiring',
          content:
            'The hiring panel found that the candidate met the role requirements and communicated clearly.',
          sourceStartMs: 2_000
        })
      ],
      discussion: [],
      statusUpdates: []
    }

    const content = presentMeetingSegmentsLosslessly(MEETING_ID, segments)

    expect(content.overview?.text).toBe(
      'The hiring panel found that the candidate met the role requirements and communicated clearly.'
    )
  })

  it('orders merged items, sections, decisions, and next steps by source chronology', () => {
    const segments: MeetingSegments = {
      decisions: [
        segment('decision-late', 'decision', {
          sourceStartMs: 90_000,
          sourceEndMs: 91_000
        }),
        segment('decision-early', 'decision', {
          sourceStartMs: 5_000,
          sourceEndMs: 6_000
        })
      ],
      actionItems: [
        segment('action-late', 'action_item', {
          sourceStartMs: 80_000,
          sourceEndMs: 81_000
        }),
        segment('action-early', 'action_item', {
          sourceStartMs: 7_000,
          sourceEndMs: 8_000
        })
      ],
      information: [
        segment('alpha-late', 'information', {
          topic: 'Alpha',
          sourceStartMs: 50_000,
          sourceEndMs: 51_000
        }),
        segment('alpha-tie-first', 'information', {
          topic: 'Alpha',
          sourceStartMs: 40_000,
          sourceEndMs: 41_000
        }),
        segment('beta', 'information', {
          topic: 'Beta',
          sourceStartMs: 20_000,
          sourceEndMs: 21_000
        })
      ],
      discussion: [
        segment('alpha-early', 'discussion', {
          topic: 'Alpha',
          sourceStartMs: 10_000,
          sourceEndMs: 11_000
        }),
        segment('alpha-tie-second', 'discussion', {
          topic: 'Alpha',
          sourceStartMs: 40_000,
          sourceEndMs: 41_000
        }),
        segment('gamma', 'discussion', {
          topic: 'Gamma',
          sourceStartMs: 20_000,
          sourceEndMs: 21_000
        })
      ],
      statusUpdates: [
        segment('alpha-middle', 'status_update', {
          topic: 'Alpha',
          sourceStartMs: 30_000,
          sourceEndMs: 31_000
        })
      ]
    }

    const content = presentMeetingSegmentsLosslessly(MEETING_ID, segments)

    expect(content.decisions.map((item) => item.id)).toEqual(['decision-early', 'decision-late'])
    expect(content.nextSteps.map((item) => item.id)).toEqual(['action-early', 'action-late'])
    expect(content.sections.map((section) => section.title)).toEqual(['Alpha', 'Beta', 'Gamma'])
    expect(content.sections[0]?.keyPoints.map((item) => item.id)).toEqual([
      'alpha-early',
      'alpha-middle',
      'alpha-tie-first',
      'alpha-tie-second',
      'alpha-late'
    ])
    expect(hasExactLosslessCoverage(segments, content)).toBe(true)
  })

  it('rejects dropped, changed, duplicated, and misfiled writer records', () => {
    const segments = fixture()
    const valid = presentMeetingSegmentsLosslessly(MEETING_ID, segments)

    const dropped = structuredClone(valid)
    dropped.sections[0]?.keyPoints.pop()
    expect(hasExactLosslessCoverage(segments, dropped)).toBe(false)

    const changed = structuredClone(valid)
    changed.nextSteps[0]!.text = 'Changed action context'
    expect(hasExactLosslessCoverage(segments, changed)).toBe(false)

    const duplicated = structuredClone(valid)
    duplicated.sections[0]?.keyPoints.push(structuredClone(duplicated.sections[0]!.keyPoints[0]!))
    expect(hasExactLosslessCoverage(segments, duplicated)).toBe(false)

    const misfiled = structuredClone(valid)
    misfiled.sections[0]?.keyPoints.push(misfiled.decisions.shift()!)
    expect(hasExactLosslessCoverage(segments, misfiled)).toBe(false)

    const inventedOverview = structuredClone(valid)
    inventedOverview.overview!.text = 'The team approved an unsupported launch date.'
    expect(hasExactLosslessCoverage(segments, inventedOverview)).toBe(false)

    const inventedTakeaway = structuredClone(valid)
    inventedTakeaway.keyTakeaways[0]!.text = 'Unsupported summary text.'
    expect(hasExactLosslessCoverage(segments, inventedTakeaway)).toBe(false)
  })

  it('uses the simple category-only projection when a candidate fails exact coverage', () => {
    const segments = fixture()
    const damaged = presentMeetingSegmentsLosslessly(MEETING_ID, segments)
    damaged.sections[0]?.keyPoints.pop()

    const fallback = ensureExactLosslessCoverage(MEETING_ID, segments, damaged)

    expect(fallback.sections.map((section) => section.title)).toEqual([
      'Information',
      'Discussion',
      'Status Updates'
    ])
    expect(fallback.sections[0]?.keyPoints.map((item) => item.id)).toEqual([
      'info-1',
      'info-2',
      'info-3'
    ])
    expect(hasExactLosslessCoverage(segments, fallback)).toBe(true)
  })

  it('is deterministic and returns valid empty content', () => {
    const segments = fixture()
    expect(presentMeetingSegmentsLosslessly(MEETING_ID, segments)).toEqual(
      presentMeetingSegmentsLosslessly(MEETING_ID, structuredClone(segments))
    )

    const empty: MeetingSegments = {
      decisions: [],
      actionItems: [],
      information: [],
      discussion: [],
      statusUpdates: []
    }
    expect(presentMeetingSegmentsLosslessly(MEETING_ID, empty)).toEqual({
      overview: null,
      keyTakeaways: [],
      sections: [],
      decisions: [],
      nextSteps: []
    })
  })

  it('fails closed when source identity or category cannot be preserved', () => {
    const duplicate = fixture()
    duplicate.actionItems[0]!.id = duplicate.decisions[0]!.id
    expect(() => presentMeetingSegmentsLosslessly(MEETING_ID, duplicate)).toThrowError(
      expect.objectContaining<Partial<LosslessPresenterError>>({ code: 'duplicate-segment-id' })
    )

    const mismatchedMeeting = fixture()
    mismatchedMeeting.information[0]!.meetingId = 'another-meeting'
    expect(() => presentMeetingSegmentsLosslessly(MEETING_ID, mismatchedMeeting)).toThrowError(
      expect.objectContaining<Partial<LosslessPresenterError>>({ code: 'meeting-mismatch' })
    )

    const mismatchedCategory = fixture()
    mismatchedCategory.information[0]!.category = 'discussion'
    expect(() => presentMeetingSegmentsLosslessly(MEETING_ID, mismatchedCategory)).toThrowError(
      expect.objectContaining<Partial<LosslessPresenterError>>({ code: 'category-mismatch' })
    )
  })
})
