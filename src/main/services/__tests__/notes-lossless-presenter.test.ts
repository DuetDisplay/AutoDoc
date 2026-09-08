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
    expect(content.overview?.provenance).toBe('generated')
    expect(content.overview?.text).toContain('Release the free tier at a 50/50 split after QA clears.')
    expect(content.keyTakeaways.length).toBeGreaterThanOrEqual(3)
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

    expect(content.sections.map((section) => section.title)).toEqual(
      expect.arrayContaining(['A/B Tests', 'Mobile Releases'])
    )
    expect(content.sections.some((section) => section.title === 'Information')).toBe(false)
    expect(content.sections.every((section) => section.id.startsWith('lossless-section:topical:'))).toBe(
      true
    )
    const abTests = content.sections.find((section) => section.title === 'A/B Tests')
    expect(abTests?.keyPoints.map((item) => item.id)).toEqual([
      'info-1',
      'info-2',
      'discussion-1'
    ])
    expect(abTests?.keyPoints.map((item) => item.topic)).toEqual([
      'A/B Tests',
      'A/B Tests',
      'A/B Tests'
    ])
    expect(
      content.sections.find((section) => section.title === 'Mobile Releases')?.keyPoints.map(
        (item) => item.id
      )
    ).toEqual(['status-1'])
  })

  it('places weak topicless records in Other Notes instead of generic categories', () => {
    const segments: MeetingSegments = {
      decisions: [],
      actionItems: [],
      information: [segment('info', 'information')],
      discussion: [segment('discussion', 'discussion', { topic: '   ' })],
      statusUpdates: [segment('status', 'status_update')]
    }

    const content = presentMeetingSegmentsLosslessly(MEETING_ID, segments)

    expect(content.sections.some((section) => section.title === 'Information')).toBe(false)
    expect(content.sections.flatMap((section) => section.keyPoints.map((item) => item.id)).sort()).toEqual(
      ['discussion', 'info', 'status']
    )
    expect(hasExactLosslessCoverage(segments, content)).toBe(true)
  })

  it('keeps Other Notes after named chapters even when leftovers start earlier', () => {
    const segments: MeetingSegments = {
      decisions: [],
      actionItems: [],
      information: [
        segment('early-leftover', 'information', {
          title: 'Note',
          content: 'The build shipped.',
          sourceStartMs: 1_000,
          sourceEndMs: 2_000
        }),
        segment('analytics', 'information', {
          topic: 'Analytics',
          title: 'Login events need consent',
          content: 'A fix is needed on the Consent to Analytics event.',
          sourceStartMs: 8_000,
          sourceEndMs: 9_000
        })
      ],
      discussion: [],
      statusUpdates: []
    }

    const content = presentMeetingSegmentsLosslessly(MEETING_ID, segments)

    expect(content.sections.map((section) => section.title)).toEqual(['Analytics', 'Other Notes'])
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

    expect(content.overview?.text).toContain(
      'The hiring panel found that the candidate met the role requirements and communicated clearly.'
    )
    expect(content.overview?.text).not.toContain('Candidates were discussed.')
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

  it('does not promote unresolved comparisons or vague decisions as the overview', () => {
    const segments: MeetingSegments = {
      decisions: [
        segment('vague', 'decision', {
          title: 'Do this properly',
          content: "Let's make sure we do this properly.",
          sourceStartMs: 1_000,
          sourceEndMs: 1_500
        })
      ],
      actionItems: [],
      information: [
        segment('spread', 'information', {
          title: 'The spread and leaders',
          content: 'The spread and leaders are still the same as yesterday.',
          sourceStartMs: 2_000,
          sourceEndMs: 2_500
        }),
        segment('trials', 'information', {
          title: 'Mac trial starts increased',
          content: 'Trial starts increased by 12% on Mac after the free-tier experiment.',
          sourceStartMs: 3_000,
          sourceEndMs: 3_500
        })
      ],
      discussion: [],
      statusUpdates: []
    }

    const content = presentMeetingSegmentsLosslessly(MEETING_ID, segments)

    expect(content.overview?.text).toContain('Trial starts increased by 12% on Mac')
    expect(content.overview?.text).not.toContain('same as yesterday')
    expect(content.overview?.text).not.toContain('do this properly')
    expect(content.sections.some((section) => section.title === 'Information')).toBe(false)
    expect(hasExactLosslessCoverage(segments, content)).toBe(true)
  })

  it('indexes takeaways by topic instead of repeating the body sentence', () => {
    const body =
      'The data indicates 14 starts and 6 cancellations, which the team considers unusual and potentially coincidental, with no common problem identified.'
    const segments: MeetingSegments = {
      decisions: [],
      actionItems: [],
      information: [
        segment('cancels', 'information', {
          topic: 'Cancellations',
          title: body,
          content: body,
          sourceStartMs: 1_000
        })
      ],
      discussion: [],
      statusUpdates: []
    }
    const content = presentMeetingSegmentsLosslessly(MEETING_ID, segments)

    const takeaway = content.keyTakeaways.find((item) => item.topic === 'Cancellations')
    expect(takeaway?.title).toBe('')
    expect(takeaway?.text).toBe(body)
    expect(content.overview?.text).not.toContain('Cancellations —')
    expect(hasExactLosslessCoverage(segments, content)).toBe(true)
  })

  it('keeps corrupted next steps in coverage under Needs Review', () => {
    const segments: MeetingSegments = {
      decisions: [],
      actionItems: [
        segment('junk', 'action_item', {
          title: 'Broken annual test',
          content: 'KeŰ runningŰ This Annual default test for a cŰ',
          sourceStartMs: 1_000
        })
      ],
      information: [
        segment('metric', 'information', {
          title: 'Average daily app registrations',
          content: 'Average daily app registrations are under ten, including Sundays.',
          sourceStartMs: 2_000
        })
      ],
      discussion: [],
      statusUpdates: []
    }

    const content = presentMeetingSegmentsLosslessly(MEETING_ID, segments)

    expect(content.nextSteps).toEqual([
      expect.objectContaining({
        id: 'junk',
        text: 'KeŰ runningŰ This Annual default test for a cŰ',
        topic: 'Needs Review'
      })
    ])
    expect(content.overview?.text).toContain('Average daily app registrations')
    expect(hasExactLosslessCoverage(segments, content)).toBe(true)
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
