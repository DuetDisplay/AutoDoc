import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MeetingSegments, Segment } from '../../../shared/types'
import { removeExactDuplicateSegments } from '../notes-exact-duplicates'
import { presentMeetingSegmentsLosslessly } from '../notes-lossless-presenter'
import { runNotesScanPipeline } from '../notes-scan-pipeline'

function note(overrides: Partial<Segment> = {}): Segment {
  return {
    id: 'meeting-information:duplicate', meetingId: 'meeting', category: 'information',
    topic: null, title: 'Character Cuts',
    content: 'About ten characters will be cut from the next game.',
    assignee: null, deadline: null, sourceStartMs: 398000, sourceEndMs: 422000,
    ...overrides
  }
}

function fixture(information: Segment[]): MeetingSegments {
  return { decisions: [], actionItems: [], information, discussion: [], statusUpdates: [] }
}

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
afterEach(() => Object.defineProperty(process, 'platform', originalPlatform))

describe('removeExactDuplicateSegments', () => {
  it('keeps the first exact copy in order without mutating input or candidate drafts', () => {
    const first = note()
    const later = note({ id: 'later', sourceStartMs: 480000, sourceEndMs: 500000 })
    const input = { ...fixture([first, later, structuredClone(first)]), nextStepCandidates: [first, first] }
    const original = structuredClone(input)
    const result = removeExactDuplicateSegments(input)
    expect(result.information).toEqual([first, later])
    expect(result.information[0]).toBe(first)
    expect(result.nextStepCandidates).toBe(input.nextStepCandidates)
    expect(input).toEqual(original)
    expect(removeExactDuplicateSegments(result)).toBe(result)
  })

  it.each([
    { id: 'different-id' }, { meetingId: 'another-meeting' }, { category: 'discussion' },
    { topic: 'Roster' }, { title: 'Character cuts' }, { content: 'About eleven characters will be cut.' },
    { assignee: 'Alex' }, { deadline: 'Friday' }, { sourceStartMs: 399000 }, { sourceEndMs: 423000 },
    { actionContext: { title: 'Review cuts', sourceStartMs: 390000, sourceEndMs: 398000 } },
    { futureMetadata: 'preserve unknown fields too' }
  ] as Array<Partial<Segment>>)( 'preserves any field difference: %j', (difference) => {
    const input = fixture([note(), note(difference)])
    expect(removeExactDuplicateSegments(input)).toBe(input)
    if (!difference.id) {
      expect(() => presentMeetingSegmentsLosslessly('meeting', input)).toThrow()
    }
  })

  it('preserves differing nested metadata and conflicting copies', () => {
    const first = note({ actionContext: { title: 'Review cuts', sourceStartMs: 1000, sourceEndMs: 2000 } })
    const conflicting = { ...first, actionContext: { ...first.actionContext!, sourceEndMs: 3000 } }
    const result = removeExactDuplicateSegments(fixture([first, conflicting, structuredClone(first)]))
    expect(result.information).toEqual([first, conflicting])
    expect(() => presentMeetingSegmentsLosslessly('meeting', result)).toThrow(/duplicate-segment-id/)
  })

  it('does not hide a malformed duplicate placed in another bucket', () => {
    const item = note()
    const input = { ...fixture([item]), decisions: [structuredClone(item)] }
    expect(removeExactDuplicateSegments(input)).toBe(input)
    expect(() => presentMeetingSegmentsLosslessly('meeting', input)).toThrow()
  })

  it.each(['decisions', 'actionItems', 'information', 'discussion', 'statusUpdates'] as const)(
    'removes exact copies in %s', (bucket) => {
      const categories = { decisions: 'decision', actionItems: 'action_item', information: 'information', discussion: 'discussion', statusUpdates: 'status_update' } as const
      const item = note({ category: categories[bucket] })
      const input = { ...fixture([]), [bucket]: [item, structuredClone(item)] }
      expect(removeExactDuplicateSegments(input)[bucket]).toEqual([item])
    }
  )

  it.each(['win32', 'darwin'] as const)(
    'unblocks V2 on %s with unchanged unique content and model requests', async (platform) => {
      Object.defineProperty(process, 'platform', { configurable: true, value: platform })
      const first = note()
      const second = note({ id: 'other', title: 'Release date', content: 'No release date has been announced.', sourceStartMs: 50000, sourceEndMs: 50000 })
      const clean = fixture([first, second])
      const duplicated = fixture([first, structuredClone(first), second])
      expect(() => presentMeetingSegmentsLosslessly('meeting', duplicated)).toThrow(/duplicate-segment-id/)
      const generate = vi.fn(async () => JSON.stringify({ overview: 'The discussion covered possible roster cuts and the unannounced release date.' }))
      const options = { title: 'Meeting', meetingId: 'meeting', presentationMode: 'lossless' as const,
        attributionTranscript: [], spanSources: [], generate }
      const baseline = await runNotesScanPipeline(clean, options)
      const requests = structuredClone(generate.mock.calls)
      generate.mockClear()
      const result = await runNotesScanPipeline(removeExactDuplicateSegments(duplicated), options)
      expect(result.content).toEqual(baseline.content)
      expect(result.exactWriterCoverage).toBe(true)
      expect(generate.mock.calls).toEqual(requests)
      expect(removeExactDuplicateSegments(duplicated)).toEqual(clean)
    }
  )
})
