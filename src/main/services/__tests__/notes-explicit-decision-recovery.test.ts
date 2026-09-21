import { describe, expect, it } from 'vitest'
import type { MeetingSegments, Segment, Transcript } from '../../../shared/types'
import { recoverExplicitTranscriptDecisions } from '../notes-explicit-decision-recovery'

const MEETING_ID = 'planning-1'

function emptySegments(): MeetingSegments {
  return {
    decisions: [],
    actionItems: [],
    information: [],
    discussion: [],
    statusUpdates: []
  }
}

function row(id: string, text: string, startMs: number, speaker = 'them'): Transcript {
  return {
    id,
    meetingId: MEETING_ID,
    speaker,
    text,
    startMs,
    endMs: startMs + 1_000,
    confidence: 1
  }
}

function information(overrides: Partial<Segment> = {}): Segment {
  return {
    id: 'writer-info',
    meetingId: MEETING_ID,
    category: 'information',
    topic: 'Migration',
    title: 'Migration delayed until canary completes',
    content: 'The migration will wait until the canary completes.',
    assignee: null,
    deadline: null,
    sourceStartMs: 1_000,
    sourceEndMs: 2_000,
    ...overrides
  }
}

describe('explicit transcript decision recovery', () => {
  it.each([
    ['We decided to refund the customer.', 'Refund the customer'],
    ["Let's hold off on the migration until the canary completes.", 'Hold off on the migration'],
    ["We're going with the smaller deployment.", 'Going with the smaller deployment']
  ])('recovers a direct choice: %s', (text, expectedTitle) => {
    const result = recoverExplicitTranscriptDecisions(emptySegments(), [row('d1', text, 1_000)])

    expect(result.segments.decisions).toEqual([
      expect.objectContaining({
        category: 'decision',
        title: expect.stringContaining(expectedTitle)
      })
    ])
    expect(result.recoveredDecisionCount).toBe(1)
  })

  it('recovers a concrete proposal only after a nearby explicit acceptance', () => {
    const result = recoverExplicitTranscriptDecisions(emptySegments(), [
      row('proposal', 'Should we ship the beta on Friday?', 1_000, 'me'),
      row('acceptance', 'Yeah, sounds good.', 2_500, 'them')
    ])

    expect(result.segments.decisions).toEqual([
      expect.objectContaining({
        title: 'Ship the beta on Friday',
        content: 'Ship the beta on Friday.',
        sourceStartMs: 1_000,
        sourceEndMs: 3_500
      })
    ])
  })

  it('does not require an accepted proposal to start with a domain-specific action verb', () => {
    const result = recoverExplicitTranscriptDecisions(emptySegments(), [
      row('proposal', "Why don't we get the contract signed this week?", 1_000, 'me'),
      row('acceptance', 'That works.', 2_500, 'them')
    ])

    expect(result.segments.decisions).toEqual([
      expect.objectContaining({ content: 'Get the contract signed this week.' })
    ])
  })

  it.each([
    [[row('proposal', 'Should we inspect the logs?', 1_000), row('acceptance', 'Maybe.', 2_500)]],
    [
      [
        row('proposal', "Why don't we just investigate a little bit?", 1_000),
        row('acceptance', 'Okay.', 2_500)
      ]
    ],
    [[row('casual', "Let's take a look at the dashboard.", 1_000)]],
    [[row('choice', 'Should we use blue or green?', 1_000), row('yes', 'Yeah.', 2_500)]],
    [[row('future', "We'll keep the ticket open and watch for more reports.", 1_000)]],
    [[row('uncertain', 'I thought I approved it right away.', 1_000)]],
    [[row('anaphoric', 'I agreed with your reasoning.', 1_000)]],
    [[row('prior-context', 'We agreed on that yesterday, so I revised the mockup.', 1_000)]],
    [[row('conditional', "Unless the build fails, we'll release another one next week.", 1_000)]]
  ])('does not turn tentative or ambiguous discussion into a decision', (rows: Transcript[]) => {
    expect(recoverExplicitTranscriptDecisions(emptySegments(), rows).segments.decisions).toEqual([])
  })

  it.each([
    ['sales review', 'We decided to send the revised quote tomorrow.'],
    ['one-on-one', "Let's move the promotion review to next month."],
    ['research interview', "We're going with the second research question."],
    ['support escalation', 'The final decision is to refund the customer.']
  ])('applies the same explicit-choice rule to a %s', (_meetingType, text) => {
    const result = recoverExplicitTranscriptDecisions(emptySegments(), [
      row('decision', text, 1_000)
    ])
    expect(result.segments.decisions).toHaveLength(1)
  })

  it('promotes an overlapping writer fact instead of duplicating the decision', () => {
    const segments = emptySegments()
    segments.information.push(information())
    const result = recoverExplicitTranscriptDecisions(segments, [
      row('decision', "Let's wait on the migration until the canary completes.", 1_000)
    ])

    expect(result.segments.information).toEqual([])
    expect(result.segments.decisions).toEqual([
      expect.objectContaining({ id: 'writer-info', category: 'decision' })
    ])
    expect(result).toMatchObject({
      recoveredDecisionCount: 0,
      promotedDecisionCount: 1
    })
  })

  it('dedupes a decision the writer already captured', () => {
    const segments = emptySegments()
    segments.decisions.push({ ...information(), id: 'writer-decision', category: 'decision' })

    const result = recoverExplicitTranscriptDecisions(segments, [
      row('decision', 'We decided to wait on the migration until the canary completes.', 1_000)
    ])

    expect(result.segments.decisions).toHaveLength(1)
    expect(result.dedupedRecoveredDecisionCount).toBe(1)
  })
})
