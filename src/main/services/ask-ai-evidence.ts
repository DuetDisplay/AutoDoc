import { unicodeContentTokens } from './unicode-text'
import type { AskAiAnswer } from './ask-ai-answer'

const FILLER = new Set([
  'what',
  'who',
  'when',
  'will',
  'where',
  'how',
  'the',
  'for',
  'are',
  'was',
  'did',
  'does',
  'have',
  'that',
  'this',
  'our',
  'about',
  'which',
  'much',
  'many',
  'from',
  'moving',
  'responsible'
])

/** Query facets are relevance cues only; they never supply an answer value. */
export function questionFacet(question: string): RegExp | null {
  if (/\b(and|compare|explain|summari[sz]e|why)\b/iu.test(question)) return null
  if (/\b(owns?|owner|responsible|assigned)\b|担当|\b(responsable)\b/iu.test(question))
    return /\b(owns?|owner|responsible|assigned)\b|担当|責任|\b(responsable)\b/iu
  if (/\b(budget|money|cost|set aside|ceiling|plafond)\b|予算/iu.test(question))
    return /\b(budget|money|cost|ceiling|plafond)\b|予算/iu
  if (/\b(passphrase|recovery code|rollback)\b/iu.test(question))
    return /\b(passphrase|recovery code|rollback)\b/iu
  if (/\b(encryption key)\b/iu.test(question)) return /\b(encryption key)\b/iu
  if (/\b(when|launch|date)\b|発売日|いつ/iu.test(question))
    return /\b(launch|date|january|february|march|april|may|june|july|august|september|october|november|december)\b|発売日|\d{4}年/iu
  return null
}

export function evidenceTerms(question: string): string[] {
  return [...new Set(unicodeContentTokens(question, 3))].filter((term) => !FILLER.has(term))
}

/** An English facet match alone cannot answer a different subtopic's owner.
 * Quoted evidence must also cover non-generic query anchors. Native-language
 * queries retain the Unicode retrieval path rather than English stop rules. */
export function matchesEvidenceFacet(question: string, text: string, title: string): boolean {
  const facet = questionFacet(question)
  if (!facet?.test(text)) return false
  // eslint-disable-next-line no-control-regex -- This intentionally tests the complete ASCII range.
  if (/[^\x00-\x7F]/u.test(question)) return true
  const generic = new Set([
    'owns',
    'own',
    'owner',
    'owners',
    'assigned',
    'budget',
    'money',
    'cost',
    'set',
    'aside',
    'ceiling',
    'passphrase',
    'recovery',
    'code',
    'rollback',
    'emergency',
    'encryption',
    'key',
    'launch',
    'date',
    'approve',
    'approved',
    'its',
    'they',
    'them',
    'their',
    'please',
    'tell',
    'show',
    'can',
    'could',
    'would',
    'you',
    'your',
    'our',
    'this',
    'that',
    'did',
    'the',
    'for'
  ])
  const anchors = evidenceTerms(question).filter((term) => !generic.has(term) && !/^\d/u.test(term))
  const source = `${title} ${text}`.toLowerCase()
  return anchors.every((term) => source.includes(term))
}

/** For a narrow factual question, quote the matching source rather than ask a
 * second model to restate it. Multiple meetings go to the writer; quotations
 * within one meeting remain attributed without choosing or fabricating a value. */
export function directEvidenceAnswer(question: string, answer: AskAiAnswer): string | null {
  const facet = questionFacet(question)
  if (
    !facet ||
    answer.intent !== 'lookup' ||
    /\b(compare|summari[sz]e|explain|why)\b/iu.test(question)
  )
    return null
  const rows = (answer.sources ?? []).filter((source) =>
    matchesEvidenceFacet(question, source.quote, source.title)
  )
  if (!rows.length) return null
  // Multiple meetings may contain an earlier proposal and a later decision.
  // Let the writer assess that relationship instead of presenting both as a
  // resolved answer to a question such as "What is the approved budget?".
  if (new Set(rows.map((source) => source.meetingId)).size > 1) return null
  return rows
    .map((source) => `> ${source.quote.trim()}\n\n[${source.n}] ${source.title}`)
    .join('\n\n')
}
