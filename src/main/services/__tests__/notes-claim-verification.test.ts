import { describe, expect, it, vi } from 'vitest'
import {
  parseClaimVerdict,
  verifyOverviewClaims,
  type ClaimCompleteFn
} from '../notes-claim-verification'

const verdict = (value: string): string => JSON.stringify({ verdict: value })

describe('parseClaimVerdict', () => {
  it('accepts only the two enum values', () => {
    expect(parseClaimVerdict('{"verdict":"supported"}')).toBe('supported')
    expect(parseClaimVerdict(' {"verdict":"unsupported"}\n')).toBe('unsupported')
    expect(parseClaimVerdict('{"verdict":"maybe"}')).toBeNull()
    expect(parseClaimVerdict('')).toBeNull()
  })
})

describe('verifyOverviewClaims', () => {
  const overview = { text: 'The team reviewed the launch. Nothing was decided.', sources: [] }

  it('drops unsupported sentences, logs only their position and length, and returns null when none remain', async () => {
    const complete = vi.fn<ClaimCompleteFn>(async (prompt) =>
      verdict(
        prompt.includes('SUMMARY SENTENCE:\nNothing was decided.') ? 'unsupported' : 'supported'
      )
    )
    const result = await verifyOverviewClaims(overview, '- Launch reviewed', complete)
    expect(result.overview).toEqual({ ...overview, text: 'The team reviewed the launch.' })
    expect(result).toMatchObject({
      checked: 2,
      removed: 1,
      errors: 0,
      dropped: [{ index: 1, chars: 'Nothing was decided.'.length }]
    })
    expect(complete.mock.calls[0]![0]).toContain('MEETING NOTES:\n- Launch reviewed')

    const all = await verifyOverviewClaims(overview, '', async () => verdict('unsupported'))
    expect(all.overview).toBeNull()
  })

  it('sends a language-neutral prompt with an enum schema and keeps `$` sequences literal', async () => {
    const complete = vi.fn<ClaimCompleteFn>(async () => verdict('supported'))
    await verifyOverviewClaims({ text: 'Die Kosten liegen bei $& 5.' }, '- Kosten: $1', complete)
    const [prompt, options] = complete.mock.calls[0]!
    expect(prompt).toContain('SUMMARY SENTENCE:\nDie Kosten liegen bei $& 5.')
    expect(prompt).toContain('MEETING NOTES:\n- Kosten: $1')
    expect(prompt).not.toContain('Write the entire response')
    expect(options).toMatchObject({
      temperature: 0,
      format: { properties: { verdict: { enum: ['supported', 'unsupported'] } } }
    })
  })

  it('keeps sentences whose check fails and joins CJK sentences without spaces', async () => {
    const ja = { text: '発売日を確認した。まだ決まっていない。' }
    const result = await verifyOverviewClaims(
      ja,
      '',
      vi
        .fn<ClaimCompleteFn>()
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValueOnce(verdict('supported'))
    )
    expect(result.overview?.text).toBe('発売日を確認した。まだ決まっていない。')
    expect(result.errors).toBe(1)
  })
})
