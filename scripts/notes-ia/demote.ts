import { itemText } from './text.ts'
import type { Bucket, IaItem } from './types.ts'

/**
 * Hedge / proposal markers from the Phase 2 plan. Conservative: when unsure, demote.
 * `could` excludes `couldn't` so factual absences are not treated as proposals.
 */
const HEDGE_PATTERNS: readonly RegExp[] = [
  /\bmaybe\b/i,
  /\bcould(?!n['’]?t)\b/i,
  /\bshould we\b/i,
  /\bwhat if\b/i,
  /\bmight(?!n['’]?t)\b/i,
  /\bpropose\b/i,
  /\bconsider\b/i,
  /\bprobably\b/i,
  /\bthinking about\b/i,
  /\bwe may\b/i
]

const FUTURE_CONDITIONAL_PATTERNS: readonly RegExp[] = [
  /\bif we\b/i,
  /\bif i\b/i,
  /\bwould\b/i,
  /\bwe should\b/i,
  /\bshould i\b/i
]

/** Genuine commitments must survive even when a hedge word appears in another clause. */
const COMMITMENT_PATTERNS: readonly RegExp[] = [
  /\bi will\b/i,
  /\bi'll\b/i,
  /\bwe will\b/i,
  /\bwe'll\b/i,
  /\bwe agreed\b/i,
  /\bagreed to\b/i,
  /\bwe decided\b/i,
  /\bdecided to\b/i,
  /\bwill send\b/i,
  /\bwill ship\b/i
]

const DEMOTE_BUCKETS = new Set<Bucket>(['decisions', 'actionItems'])

export function looksLikeCommitment(text: string): boolean {
  return COMMITMENT_PATTERNS.some((pattern) => pattern.test(text))
}

export function looksUncertain(text: string): boolean {
  if (text.includes('?')) return true
  return (
    HEDGE_PATTERNS.some((pattern) => pattern.test(text)) ||
    FUTURE_CONDITIONAL_PATTERNS.some((pattern) => pattern.test(text))
  )
}

/**
 * Demote Decisions/Actions whose text is a question, hedge, or future-conditional.
 * Unsure → demote. Must not demote explicit commitments (see tests).
 */
export function shouldDemote(item: Pick<IaItem, 'title' | 'content' | 'bucket'>): boolean {
  if (!DEMOTE_BUCKETS.has(item.bucket)) return false
  const text = itemText(item)
  const uncertain = looksUncertain(text)
  if (!uncertain) return false
  if (!looksLikeCommitment(text)) return true
  if (text.includes('?')) return true
  if (/\bshould we\b/i.test(text) || /\bwhat if\b/i.test(text)) return true
  if (/\bmaybe\b/i.test(text) || /\bprobably\b/i.test(text) || /\bmight(?!n['’]?t)\b/i.test(text)) {
    return true
  }
  return false
}

export function demoteModality(items: readonly IaItem[]): { items: IaItem[]; demoted: number } {
  let demoted = 0

  const walk = (item: IaItem): IaItem => {
    const children = item.children.map(walk)
    if (!shouldDemote(item)) return { ...item, children }
    demoted += 1
    return { ...item, bucket: 'information', children }
  }

  return { items: items.map(walk), demoted }
}
