export interface ChatSourceCard {
  n: number
  meetingId: string
  title: string
  quote: string
  startMs: number | null
  category: string
}

const CITATION_MARKER = /\[(?:\d+|n)\]/g

/** Display-only selection; citation numbers may span an appended conversation. */
export function filterCitedSourceCards(
  answer: string,
  sources: readonly ChatSourceCard[]
): ChatSourceCard[] {
  const byNumber = new Map(sources.map((source) => [source.n, source]))
  const seen = new Set<number>()
  const cited: ChatSourceCard[] = []
  for (const match of answer.matchAll(/\[(\d+)\]/g)) {
    const n = Number(match[1])
    const source = byNumber.get(n)
    if (!source || seen.has(n)) continue
    seen.add(n)
    cited.push(source)
  }
  return cited
}

export function numberSourceCards(cards: Array<Omit<ChatSourceCard, 'n'>>): ChatSourceCard[] {
  return cards.slice(0, 8).map((card, index) => ({ ...card, n: index + 1 }))
}

/** Strip leftover [n] markers. Chips come from retrieved evidence, not model cites. */
export function applyAnswerCitations(
  answer: string,
  sources: readonly ChatSourceCard[]
): { answer: string; sources: ChatSourceCard[] } {
  return {
    answer: answer
      .replace(CITATION_MARKER, '')
      .replace(/[ \t]+([.,;:])/g, '$1')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]+\n/g, '\n'),
    sources:
      process.env.AUTODOC_ASK_AI_CITED_CARDS === '1'
        ? filterCitedSourceCards(answer, sources)
        : [...sources]
  }
}
