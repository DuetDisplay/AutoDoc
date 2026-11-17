import { describe, expect, it } from 'vitest'
import { applyAnswerCitations, numberSourceCards } from '../ask-ai-citations'

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
