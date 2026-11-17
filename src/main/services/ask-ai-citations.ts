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

/**
 * AD-202 writer rules, off unless AUTODOC_ASK_AI_AD202_RULES=1: the app shows the count filter
 * itself, and a reply with nothing relevant ends with [0] so it shows no source links. Mac
 * testing found the writer often sent only "[0]", including for requests about the chat
 * itself, and the changed rules altered other answers, so 1.3.4 keeps the original rules.
 */
export function useAskAiAd202Rules(): boolean {
  return process.env.AUTODOC_ASK_AI_AD202_RULES === '1'
}

export const ASK_AI_NO_EVIDENCE_RULE =
  'If the evidence has nothing relevant to the request, say so and end with [0].'

/** The writer's [0] marker, with no real citation, means it found nothing relevant. */
export function answerReportsNoEvidence(answer: string): boolean {
  return /\[0\]/.test(answer) && !/\[[1-9]\d*\]/.test(answer)
}

/** The app's existing no-match wording (ask-ai-answer.ts), used when the writer sends only [0]. */
export const ASK_AI_NO_EVIDENCE_FALLBACK = "I didn't find that in your notes or transcripts."

/** A [0] reply with no words (AD-202 Windows: the writer sent only "[0]"). */
export function answerIsOnlyNoEvidenceMarker(answer: string): boolean {
  return answerReportsNoEvidence(answer) && applyAnswerCitations(answer, []).answer.trim() === ''
}

/** Final answer text and source links. With AD-202 rules, a [0] reply shows no links. */
export function finalizeChatAnswer(
  answer: string,
  sources?: ChatSourceCard[]
): { content: string; sources?: ChatSourceCard[] } {
  const noEvidence = useAskAiAd202Rules() && answerReportsNoEvidence(answer)
  if (!sources || sources.length === 0) {
    const content = noEvidence
      ? applyAnswerCitations(answer, []).answer.trimEnd()
      : answer.replace(/\[n\]/g, '')
    return process.env.AUTODOC_ASK_AI_CITED_CARDS === '1' ? { content, sources: [] } : { content }
  }
  const applied = applyAnswerCitations(answer, sources)
  return {
    content: noEvidence ? applied.answer.trimEnd() : applied.answer,
    sources: noEvidence
      ? []
      : process.env.AUTODOC_ASK_AI_CITED_CARDS === '1'
        ? applied.sources
        : sources
  }
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
