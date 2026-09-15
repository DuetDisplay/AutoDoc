/**
 * Deterministic commitment verifier. Keep extractor items whose action
 * (and owner, if a real name) tokens are grounded in transcript utterances,
 * whose best support is not past-tense completion, and whose hedge-window
 * support is either clean or confirmed by a separate agreement/assignment.
 */

export type VerifyReason =
  | 'kept'
  | 'ungrounded'
  | 'modality_promoted'
  | 'past_completion'
  | 'empty_action'

export interface ExtractedCommitment {
  index: number
  raw: string
  action: string
  owner: string | null
  rationale: string | null
}

export interface VerifyDecision {
  index: number
  keep: boolean
  reason: VerifyReason
  actionTokenCount: number
  groundedTokenCount: number
  supportingUtteranceCount: number
  hedgeHits: string[]
  confirmationUtteranceCount: number
}

export interface VerifyResult {
  extracted: ExtractedCommitment[]
  decisions: VerifyDecision[]
  kept: ExtractedCommitment[]
}

const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'to',
  'for',
  'of',
  'and',
  'or',
  'in',
  'on',
  'at',
  'by',
  'with',
  'from',
  'as',
  'is',
  'are',
  'be',
  'been',
  'was',
  'were',
  'it',
  'its',
  'this',
  'that',
  'these',
  'those',
  'we',
  'you',
  'they',
  'i',
  'me',
  'my',
  'our',
  'your',
  'their',
  'into',
  'than',
  'then',
  'so',
  'if',
  'not',
  'no',
  'do',
  'does',
  'did',
  'up',
  'out',
  'off',
  'over',
  'into',
  'about',
  'into'
])

const TOKEN_ALIASES: Record<string, string> = {
  everyone: 'everybody',
  everybody: 'everybody',
  mixpanel: 'mixpanel',
  mix: 'mixpanel'
}

/** Radius around best-support turns scanned for hedge markers. Frozen. */
export const HEDGE_WINDOW = 2

const HEDGE_CHECKS: readonly { label: string; pattern: RegExp }[] = [
  { label: 'we could', pattern: /\bwe could\b/iu },
  { label: 'should', pattern: /\bshould\b/iu },
  { label: 'maybe', pattern: /\bmaybe\b/iu },
  { label: 'could', pattern: /\bcould(?!n['’]?t)\b/iu },
  { label: 'consider', pattern: /\bconsider\b/iu },
  { label: 'might', pattern: /\bmight(?!n['’]?t)\b/iu },
  { label: 'worth', pattern: /\bworth\b/iu },
  { label: 'idea', pattern: /\bidea\b/iu },
  { label: 'want to look', pattern: /\bwant(?:s|ed)? to look\b/iu }
]

const DEFINITE_PATTERNS: readonly RegExp[] = [
  /\bi will\b/i,
  /\bi'll\b/i,
  /\bwe will\b/i,
  /\bwe'll\b/i,
  /\bwe agreed\b/i,
  /\bagreed to\b/i,
  /\bgo ahead\b/i,
  /\bleft (?:it |that )?for\b/i,
  /\bcreate a ticket\b/i,
  /\badd everybody\b/i,
  /\badd everyone\b/i,
  /\bi can do\b/i,
  /\bplease\b/i,
  /\bleave\b.{0,80}\bto\b/i,
  /\bfor \w+ to (?:review|handle|do|take)\b/i
]

const PAST_COMPLETION_PATTERNS: readonly RegExp[] = [
  /\bmy main focus was\b/i,
  /\bwas to get\b/i,
  /\bwas looking (?:into|at)\b/i,
  /\bi (?:also )?reviewed\b/i,
  /\balready (?:reviewed|ready|done|finished|merged|completed)\b/i,
  /\b(?:are|were|was) already ready\b/i,
  /\bhad (?:already )?(?:reviewed|finished|done|completed)\b/i,
  /\bgot (?:everything |it )?ready\b/i
]

const DEFERRED_PATTERNS: readonly RegExp[] = [
  /\bnot (?:quite |yet )?ready\b/i,
  /\bbefore we do that\b/i,
  /\bnot until\b/i,
  /\bhouse in order\b/i,
  /\bdon['’]?t know if\b/i
]

const PLACEHOLDER_OWNER = /^(owner|me|them|us|we|all|everyone|everybody)$/i

export function contentTokens(text: string): string[] {
  const matches = text.toLowerCase().match(/[a-z0-9]+(?:'[a-z]+)?/g) ?? []
  const tokens: string[] = []
  const seen = new Set<string>()
  for (const raw of matches) {
    if (raw.length < 3 || STOPWORDS.has(raw)) continue
    const normalized = TOKEN_ALIASES[raw] ?? raw
    if (seen.has(normalized)) continue
    seen.add(normalized)
    tokens.push(normalized)
  }
  return tokens
}

function utteranceTokenSet(text: string): Set<string> {
  return new Set(contentTokens(text))
}

function setHasToken(set: Set<string>, token: string): boolean {
  if (set.has(token)) return true
  if (token.length < 4) return false
  for (const candidate of set) {
    if (candidate.length < 4) continue
    if (candidate.startsWith(token) || token.startsWith(candidate)) return true
  }
  return false
}

function ownerIsReal(owner: string | null): owner is string {
  return owner !== null && owner.trim().length > 0 && !PLACEHOLDER_OWNER.test(owner.trim())
}

export function parseExtractorMarkdown(markdown: string): ExtractedCommitment[] {
  const items: ExtractedCommitment[] = []
  for (const line of markdown.split(/\r?\n/u)) {
    const bullet = line.match(/^\s*[-*]\s+(.*)$/u)
    if (!bullet) continue
    const rest = (bullet[1] ?? '').trim()
    if (rest.length === 0) continue
    const parsed = parseExtractorLine(rest)
    if (parsed.action.length === 0) continue
    items.push({
      index: items.length + 1,
      raw: rest,
      ...parsed
    })
  }
  return items
}

function ownerParts(raw: string): string[] {
  return raw
    .split(/[,/&]|\band\b/iu)
    .map((part) => part.replace(/^owner\s*:?\s*/iu, '').trim())
    .filter((part) => ownerIsReal(part))
}

function parseExtractorLine(line: string): Pick<ExtractedCommitment, 'action' | 'owner' | 'rationale'> {
  const bold = line.match(/^\*\*(.+?)\*\*\s*(.*)$/u)
  const action = (bold ? bold[1] : line).trim()
  let remainder = (bold ? bold[2] : '').trim()
  let owner: string | null = null
  let rationale: string | null = null
  const ownerMatch = remainder.match(/^\(([^)]*)\)\s*(.*)$/u)
  if (ownerMatch) {
    const parts = ownerParts(ownerMatch[1] ?? '')
    owner = parts.length > 0 ? parts.join(', ') : null
    remainder = (ownerMatch[2] ?? '').trim()
  }
  const dash = remainder.match(/^(?:—|--|-)\s*(.*)$/u)
  if (dash) {
    const value = (dash[1] ?? '').trim()
    rationale = value.length > 0 ? value : null
  }
  return { action, owner, rationale }
}

function ownerPartGrounded(owner: string, utterances: readonly string[]): boolean {
  const needle = owner.trim().toLowerCase()
  if (needle.length === 0) return false
  const pattern = new RegExp(`\\b${escapeRegExp(needle)}\\b`, 'i')
  return utterances.some((utterance) => pattern.test(utterance))
}

function groundedOwner(owner: string | null, utterances: readonly string[]): string | null {
  if (!ownerIsReal(owner)) return null
  const kept = ownerParts(owner).filter((part) => ownerPartGrounded(part, utterances))
  return kept.length > 0 ? kept.join(', ') : null
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function groundedTokenCount(actionTokens: readonly string[], utteranceSets: readonly Set<string>[]): number {
  return actionTokens.filter((token) => utteranceSets.some((set) => setHasToken(set, token))).length
}

function actionIsGrounded(actionTokens: readonly string[], groundedCount: number): boolean {
  if (actionTokens.length === 0) return false
  if (actionTokens.length === 1) return groundedCount === 1
  const needed = Math.max(2, Math.ceil(actionTokens.length * 0.5))
  return groundedCount >= needed
}

function supportingIndices(
  actionTokens: readonly string[],
  utteranceSets: readonly Set<string>[]
): number[] {
  const scored = utteranceSets.map((set, index) => {
    const overlap = actionTokens.filter((token) => setHasToken(set, token)).length
    return { index, overlap }
  })
  const best = Math.max(0, ...scored.map((row) => row.overlap))
  if (best === 0) return []
  return scored.filter((row) => row.overlap === best).map((row) => row.index)
}

function hedgeHitsIn(text: string): string[] {
  const hits: string[] = []
  for (const check of HEDGE_CHECKS) {
    if (check.pattern.test(text)) hits.push(check.label)
  }
  return hits
}

function looksDefinite(text: string): boolean {
  if (DEFERRED_PATTERNS.some((pattern) => pattern.test(text))) return false
  return DEFINITE_PATTERNS.some((pattern) => pattern.test(text))
}

function looksPastCompletionText(text: string): boolean {
  if (looksDefinite(text)) return false
  return PAST_COMPLETION_PATTERNS.some((pattern) => pattern.test(text))
}

function windowedIndices(best: readonly number[], utteranceCount: number, radius: number): number[] {
  const seen = new Set<number>()
  const out: number[] = []
  for (const index of best) {
    const start = Math.max(0, index - radius)
    const end = Math.min(utteranceCount - 1, index + radius)
    for (let cursor = start; cursor <= end; cursor += 1) {
      if (seen.has(cursor)) continue
      seen.add(cursor)
      out.push(cursor)
    }
  }
  return out
}

function confirmationCount(
  actionTokens: readonly string[],
  utterances: readonly string[],
  utteranceSets: readonly Set<string>[],
  excluded: ReadonlySet<number>
): number {
  if (actionTokens.length === 0) return 0
  const needed = Math.min(2, actionTokens.length)
  let count = 0
  for (let index = 0; index < utterances.length; index += 1) {
    if (excluded.has(index)) continue
    const text = utterances[index] ?? ''
    if (!looksDefinite(text)) continue
    const overlap = actionTokens.filter((token) => setHasToken(utteranceSets[index] ?? new Set(), token)).length
    if (overlap >= needed) count += 1
  }
  return count
}

function emptyDecision(
  index: number,
  reason: VerifyReason,
  extra: Partial<VerifyDecision> = {}
): VerifyDecision {
  return {
    index,
    keep: false,
    reason,
    actionTokenCount: 0,
    groundedTokenCount: 0,
    supportingUtteranceCount: 0,
    hedgeHits: [],
    confirmationUtteranceCount: 0,
    ...extra
  }
}

export function renderVerifiedMarkdown(items: readonly ExtractedCommitment[]): string {
  if (items.length === 0) return ''
  return `${items
    .map((item) => {
      const owner = ownerIsReal(item.owner) ? ` (${item.owner})` : ''
      const rationale = item.rationale ? ` — ${item.rationale}` : ''
      return `* **${item.action}**${owner}${rationale}`
    })
    .join('\n')}\n`
}

export function verifyCommitments(
  markdown: string,
  utterances: readonly string[]
): VerifyResult {
  const extracted = parseExtractorMarkdown(markdown)
  const utteranceSets = utterances.map(utteranceTokenSet)
  const decisions: VerifyDecision[] = []
  const kept: ExtractedCommitment[] = []

  for (const item of extracted) {
    const actionTokens = contentTokens(item.action)
    if (actionTokens.length === 0 || item.action.trim().length === 0) {
      decisions.push(emptyDecision(item.index, 'empty_action'))
      continue
    }
    const groundedCount = groundedTokenCount(actionTokens, utteranceSets)
    const supportIdx = supportingIndices(actionTokens, utteranceSets)
    const supportingTexts = supportIdx.map((index) => utterances[index] ?? '')
    const windowIdx = windowedIndices(supportIdx, utterances.length, HEDGE_WINDOW)
    const windowTexts = windowIdx.map((index) => utterances[index] ?? '')
    const hedgeHits = [...new Set(windowTexts.flatMap(hedgeHitsIn))]
    const hedgedIdx = new Set(
      windowIdx.filter((_, position) => hedgeHitsIn(windowTexts[position] ?? '').length > 0)
    )
    const confirmations = confirmationCount(actionTokens, utterances, utteranceSets, hedgedIdx)
    const owner = groundedOwner(item.owner, utterances)
    const grounded = actionIsGrounded(actionTokens, groundedCount)
    const keptItem = owner === item.owner ? item : { ...item, owner }
    const base = {
      actionTokenCount: actionTokens.length,
      groundedTokenCount: groundedCount,
      supportingUtteranceCount: supportIdx.length,
      hedgeHits,
      confirmationUtteranceCount: confirmations
    }

    if (!grounded) {
      decisions.push({ index: item.index, keep: false, reason: 'ungrounded', ...base })
      continue
    }

    const pastCompletion =
      supportingTexts.length > 0 &&
      supportingTexts.every((text) => looksPastCompletionText(text))
    if (pastCompletion) {
      decisions.push({ index: item.index, keep: false, reason: 'past_completion', ...base })
      continue
    }

    if (hedgeHits.length > 0 && confirmations === 0) {
      decisions.push({ index: item.index, keep: false, reason: 'modality_promoted', ...base })
      continue
    }

    decisions.push({ index: item.index, keep: true, reason: 'kept', ...base })
    kept.push(keptItem)
  }

  return { extracted, decisions, kept }
}
