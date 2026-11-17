import { afterEach, expect, it, vi } from 'vitest'
import { applyAnswerCitations, filterCitedSourceCards } from '../ask-ai-citations'

const cards = [1, 2, 9].map((n) => ({
  n,
  meetingId: `meeting-${n}`,
  title: `Meeting ${n}`,
  quote: `Passage ${n}`,
  startMs: 0,
  category: 'note'
}))
afterEach(() => vi.unstubAllEnvs())
it('keeps only valid cited cards in first-citation order, including conversation-wide numbers', () => {
  expect(
    filterCitedSourceCards('Third [9], first [1], third again [9], invalid [8].', cards)
  ).toEqual([cards[2], cards[0]])
})
it('ignores invalid markers and repeated citations', () => {
  expect(filterCitedSourceCards('[0] [77] [-1] [x] [2] [2]', cards)).toEqual([cards[1]])
})
it('shows no source cards without a valid citation, including a count-tool answer', () => {
  for (const answer of ['Not in the notes.', 'There are 24 recordings.', 'Unknown [88].'])
    expect(filterCitedSourceCards(answer, cards)).toEqual([])
})
it('changes only the selected cards when enabled; marker stripping stays unchanged', () => {
  vi.stubEnv('AUTODOC_ASK_AI_CITED_CARDS', '1')
  expect(applyAnswerCitations('Second [2]. First [1].', cards)).toEqual({
    answer: 'Second. First.',
    sources: [cards[1], cards[0]]
  })
})
it.each([undefined, '0', 'false'])(
  'is byte-identical to the current function when flag is %s',
  (flag) => {
    vi.stubEnv('AUTODOC_ASK_AI_CITED_CARDS', flag)
    for (const answer of [
      'Second [2]. First [1].',
      'Unknown [77].',
      'No citations.',
      '[2]  x [1] ,\n'
    ]) {
      const current = {
        answer: answer
          .replace(/\[(\d+)\]/g, '')
          .replace(/[ \t]+([.,;:])/g, '$1')
          .replace(/[ \t]{2,}/g, ' ')
          .replace(/[ \t]+\n/g, '\n'),
        sources: [...cards]
      }
      expect(JSON.stringify(applyAnswerCitations(answer, cards))).toBe(JSON.stringify(current))
    }
  }
)
