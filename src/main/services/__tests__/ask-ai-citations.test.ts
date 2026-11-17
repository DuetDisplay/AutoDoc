import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  answerIsOnlyNoEvidenceMarker,
  answerReportsNoEvidence,
  applyAnswerCitations,
  finalizeChatAnswer,
  numberSourceCards
} from '../ask-ai-citations'

const sources = numberSourceCards([
  {
    meetingId: 'billing-sync',
    title: 'Billing Sync',
    quote: 'Ship the invoice export this week.',
    startMs: 84_000,
    category: 'information'
  },
  {
    meetingId: 'billing-sync',
    title: 'Billing Sync',
    quote: 'Priya owns the follow-up.',
    startMs: 120_000,
    category: 'actionItems'
  }
])

describe('ask-ai-citations', () => {
  it('numbers retrieved evidence for chips', () => {
    expect(sources.map((source) => source.n)).toEqual([1, 2])
  })

  it('strips leftover markers and keeps every retrieved source for chips', () => {
    const applied = applyAnswerCitations(
      'Priya owns the invoice export [1]. Legal never agreed [9]. See also [2].',
      sources
    )
    expect(applied.answer).toContain('Priya owns the invoice export.')
    expect(applied.answer).not.toMatch(/\[\d+\]/)
    expect(applied.sources.map((source) => source.n)).toEqual([1, 2])
  })

  it('keeps chips empty when no sources were retrieved', () => {
    const applied = applyAnswerCitations('This came from [3] and [4].', [])
    expect(applied.answer).not.toMatch(/\[\d+\]/)
    expect(applied.sources).toEqual([])
  })
})

it('strips literal citation placeholders without changing ordinary bracketed words', () => {
  expect(applyAnswerCitations('One [n]. Two [1]. Keep [notes].', sources).answer).toBe(
    'One. Two. Keep [notes].'
  )
})

describe('AD-202 final source links', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('recognises only an uncited [0] reply as reporting no relevant evidence', () => {
    expect(answerReportsNoEvidence('Nothing about parrots is recorded. [0]')).toBe(true)
    expect(answerReportsNoEvidence('Priya owns it [1].')).toBe(false)
    expect(answerReportsNoEvidence('Priya owns it [1]; the date is unknown [0].')).toBe(false)
    expect(answerReportsNoEvidence('The date is unknown [n].')).toBe(false)
    expect(answerReportsNoEvidence('Room [10] was booked.')).toBe(false)
    expect(answerReportsNoEvidence('No mention.')).toBe(false)
  })

  it('recognises a [0] reply with no words', () => {
    expect(answerIsOnlyNoEvidenceMarker('[0]')).toBe(true)
    expect(answerIsOnlyNoEvidenceMarker(' [0] \n')).toBe(true)
    expect(answerIsOnlyNoEvidenceMarker('[0][0]')).toBe(true)
    expect(answerIsOnlyNoEvidenceMarker('Nothing about parrots. [0]')).toBe(false)
    expect(answerIsOnlyNoEvidenceMarker('[1]')).toBe(false)
    expect(answerIsOnlyNoEvidenceMarker('')).toBe(false)
  })

  it('shows no links and strips the marker for a [0] reply when AUTODOC_ASK_AI_AD202_RULES=1', () => {
    vi.stubEnv('AUTODOC_ASK_AI_AD202_RULES', '1')
    const final = finalizeChatAnswer(
      'There is no evidence about parrots eating carrots. [0]',
      sources
    )
    expect(final).toEqual({
      content: 'There is no evidence about parrots eating carrots.',
      sources: []
    })
    expect(finalizeChatAnswer('Nothing relevant was recorded [0].')).toEqual({
      content: 'Nothing relevant was recorded.'
    })
  })

  it('keeps every retrieved link for an answer without [0] when AUTODOC_ASK_AI_AD202_RULES=1', () => {
    vi.stubEnv('AUTODOC_ASK_AI_AD202_RULES', '1')
    const final = finalizeChatAnswer('Priya owns the invoice export.', sources)
    expect(final.sources).toEqual(sources)
    expect(
      finalizeChatAnswer('Priya owns it [1]; the date is unknown [0].', sources).sources
    ).toEqual(sources)
  })

  it.each([undefined, '0'])('keeps the original links and text by default (rules %s)', (rules) => {
    vi.stubEnv('AUTODOC_ASK_AI_AD202_RULES', rules)
    // Original stripping, unchanged: it leaves the space before a final marker.
    expect(finalizeChatAnswer('Nothing about parrots. [0]', sources)).toEqual({
      content: 'Nothing about parrots. ',
      sources
    })
    expect(finalizeChatAnswer('Nothing about parrots [n]. [0]')).toEqual({
      content: 'Nothing about parrots . [0]'
    })
  })
})
