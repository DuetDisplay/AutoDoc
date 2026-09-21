import {
  areQuantitiesGrounded,
  extractQuantityMentions,
  quantityMentionsEquivalent
} from './notes-quantity-canonicalizer'
import {
  actionPredicatesConflict,
  actionPredicatesOverlap,
  actionSpeechActSupportsSummary
} from './notes-action-speech'
import { noteTextLooksCoherent } from './notes-coherence'
import type { Segment, Transcript } from '../../shared/types'
import { actionEvidenceNeighborhood, actionEvidenceTurns } from './notes-action-evidence'
import {
  isWindowsCatalogWriterEnabled,
  isWindowsTopicWriterEnabled,
  windowsNumberWordCompletionEnabled
} from './windows-notes-experiment'

export type WriterGroundingCategory =
  | 'decisions'
  | 'action_items'
  | 'information'
  | 'discussion'
  | 'status_updates'

export interface WriterGroundingDraft {
  title?: string
  content?: string
  deadline?: string | null
}

export interface WriterGroundingLine {
  startMs: number
  text: string
}

export interface GroundedWriterRecord {
  category: WriterGroundingCategory
  title: string
  content: string
  deadline: string | null
  sourceStartMs: number
  sourceEndMs: number
  salvaged: boolean
  actionContext?: {
    title: string
    sourceStartMs: number
    sourceEndMs: number
  }
}

/**
 * `verbatim` (macOS writer) expects near-verbatim claims and verifies lexical
 * anchoring, entity casing, and relationship markers against narrow cited
 * windows. `paraphrase` (Windows tight writer) verifies only the checkable
 * atoms — quantities, polarity, completion, platform terms, script sanity, and
 * a minimal citation-overlap guard — against wider synthesis windows, because
 * the tight writer compresses several lines into one claim by design.
 */
export type WriterGroundingMode = 'verbatim' | 'paraphrase'

const MAX_EVIDENCE_SPAN_MS = 30_000
const CITATION_NEIGHBOR_TOLERANCE_MS = 12_000
const CITATION_NEIGHBOR_LINE_LIMIT = 2
/** Tight-writer citations are coarse; paraphrase may look one extra nearby line. */
const PARAPHRASE_NEIGHBOR_TOLERANCE_MS = 20_000
const PARAPHRASE_NEIGHBOR_LINE_LIMIT = 3

const WORD_STOP = new Set([
  'about',
  'after',
  'again',
  'also',
  'and',
  'are',
  'based',
  'because',
  'been',
  'before',
  'being',
  'between',
  'compared',
  'currently',
  'from',
  'have',
  'indicating',
  'into',
  'meeting',
  'more',
  'most',
  'only',
  'particularly',
  'reported',
  'shows',
  'suggesting',
  'team',
  'than',
  'that',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'through',
  'under',
  'version',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'with',
  'without',
  'would'
])

const POSITIVE_DIRECTION =
  /\b(?:ahead|better|gain|gained|gains|higher|improve|improved|improving|increase|increased|increases|more|outperform|outperformed|rise|rose|rising|stronger|win|winning)\b/i
const NEGATIVE_DIRECTION =
  /\b(?:behind|decline|declined|decrease|decreased|drop|dropped|fewer|less|lose|losing|lower|weaker|worse)\b/i

const METRIC_GROUPS: readonly RegExp[] = [
  /\btrials?\b/i,
  /\b(?:cancels?|cancelled|canceled|cancellations?|cancel(?:lation)?\s+rate|churn)\b/i,
  /\b(?:convert(?:ed|ing)?|conversion)\b/i,
  /\brevenue\b/i,
  /\b(?:subscribers?|subscriptions?)\b/i,
  /\b(?:success|failure|failures)\b/i,
  /\b(?:price|pricing|cost|costs)\b/i,
  /\b(?:latency|lag)\b/i
]

const PLATFORM_TERMS = [
  'macos',
  'mac',
  'windows',
  'linux',
  'desktop',
  'web',
  'browser',
  'frontend',
  'backend',
  'server',
  'ios',
  'android',
  'new',
  'old',
  'older',
  'previous'
] as const

const DECISION_EVIDENCE =
  /\b(?:agreed?|approved?|chose|choose|decided?|go with|going with|we will (?:adopt|release|roll out|rollback|ship|use))\b/i
const DECISION_ASSERTION =
  /\b(?:agreed?|approved?|chose|decided?|decision|the team confirmed|we will)\b/i
const DECISION_NEGATION = /\b(?:not|never|won't|will\s+not|do\s+not|don't)\b/i
const DECISION_ACCEPTANCE =
  /^(?:agreed|okay(?:,?\s+sounds\s+good)?|sounds\s+good|that\s+works|yeah|yes|yep)(?:[.!?]|$)/i
const DECISION_PROPOSAL =
  /\b(?:how\s+about|plan(?:ning)?\s+to|propos(?:e|ed|ing)|recommend(?:ed|ing)?|right\s+(?:approach|idea|thinking)|should|want\s+to|we\s+could)\b/i

const ASSERTION_NEGATION =
  /\b(?:not|never|no|none|neither|nor|without|cannot|can't|won't|wouldn't|couldn't|shouldn't|don't|doesn't|didn't|isn't|aren't|wasn't|weren't|hasn't|haven't|hadn't|fails?\s+to|failed\s+to|lacks?|lacking)\b/i

const NON_ASSERTIVE_MODALITY =
  /\b(?:maybe|might|may|could|can|should|would|possibly|perhaps|probably|seems?|appears?|likely|unlikely|i\s+think|i\s+guess|i\s+hope|not\s+sure|unclear|if|unless|whether|assuming|depending\s+on|pending|plans?|planned|planning|proposed|considering|whenever)\b/i

const LEADING_QUESTION = /^(?:do|does|did|is|are|was|were|can|could|would|will|should)\b/i

const ALTERNATIVE_ANCHOR_STOP = new Set([
  'a',
  'an',
  'and',
  'are',
  'be',
  'for',
  'from',
  'in',
  'is',
  'of',
  'on',
  'or',
  'the',
  'to',
  'via',
  'was',
  'were',
  'will',
  'with'
])

const ALTERNATIVE_PRIMARY_STOP = new Set([
  ...ALTERNATIVE_ANCHOR_STOP,
  'accepted',
  'accept',
  'another',
  'approved',
  'approv',
  'available',
  'choose',
  'chosen',
  'disabled',
  'disabl',
  'either',
  'enabled',
  'enabl',
  'granted',
  'grant',
  'provide',
  'provided',
  'provid',
  'ready',
  'select',
  'selected',
  'unavailable',
  'use',
  'used'
])

const ALTERNATIVE_PAYLOAD_PREFIX =
  /\b(?:via|through|using|by|either)\s+(?:a\s+|an\s+|the\s+|another\s+)?([^,;.!?]+)$/i

const POSITIVE_CLAIM_STATE =
  /\b(?:accepted|approved|available|enabled|granted|ready|succeeded|successful)\b/i
const NEGATIVE_CLAIM_STATE =
  /\b(?:absent|blocked|denied|disabled|failed|failing|missing|rejected|unavailable|unsuccessful)\b/i

const ASSERTIVE_COMPLETION = /\b(?:complete|completed|finished|passed|done)\b/i

const FUTURE_COMPLETION_PREFIX =
  /\b(?:will|would|may|might|could|should|going\s+to|scheduled\s+to|expected\s+to|plans?\s+to|hopes?\s+to)(?:\s+\p{L}+){0,3}\s*$/iu

const COMPLETION_ANCHOR_STOP = new Set(['complete', 'complet', 'done', 'finish', 'pass'])

const COMPLETION_SUBJECT_STOP = new Set([
  ...ALTERNATIVE_ANCHOR_STOP,
  ...COMPLETION_ANCHOR_STOP,
  'another',
  'app',
  'application',
  'beta',
  'build',
  'candidate',
  'client',
  'launch',
  'product',
  'qa',
  'rc',
  'release',
  'rollout',
  'smoke',
  'status',
  'test',
  'testing',
  'version'
])

const ANAPHORIC_COMPLETION = /^(?:it|this|that|they|these|those)\b/i

const PERCENTAGE_CONTEXT_STOP = new Set([
  'all',
  'and',
  'amount',
  'about',
  'approximately',
  'are',
  'around',
  'cent',
  'customer',
  'customers',
  'cover',
  'decreas',
  'decrease',
  'declin',
  'decline',
  'device',
  'devices',
  'from',
  'for',
  'gain',
  'has',
  'higher',
  'improv',
  'improve',
  'increas',
  'increase',
  'here',
  'item',
  'items',
  'level',
  'less',
  'lower',
  'metric',
  'more',
  'overall',
  'per',
  'people',
  'percent',
  'percentage',
  'person',
  'rate',
  'reach',
  'represent',
  'rise',
  'that',
  'the',
  'their',
  'there',
  'these',
  'this',
  'those',
  'total',
  'today',
  'tomorrow',
  'user',
  'users',
  'was',
  'were',
  'will',
  'with',
  'worse',
  'yesterday'
])

const CLAIM_SPLIT = new RegExp(
  `(?:[;!?]|\\.(?!\\d)|\\s+[—–]\\s+|,?\\s+(?:but|while|whereas)\\s+)`,
  'i'
)

const ASSOCIATED_CLAIM_BOUNDARY = /(?:,(?!\d)\s*|\s+and\s+)/gi

const SUBORDINATE_CLAIM_START =
  /^(?:after|although|because|before|due\s+to|even\s+if|if|once|so\s+that|unless|when|with|without)\b/i

const WINDOWS_DEPENDENT_CLAIM_START =
  /^(?:(?:but|while|whereas)\s+)?(?:after|although|because|before|due\s+to|even\s+if|if|once|only\s+if|provided\s+that|so\s+that|unless|until|when|while|with|without|in\s+order\s+to|leading\s+to|resulting\s+in|to\s+enable)\b/i

const PERIOD_ABBREVIATION =
  /(?:\b(?:mr|mrs|ms|dr|prof|sr|jr|st|rev|hon|capt|lt|sgt|gen|no|vs|etc|cf|approx|fig|dept|inc|ltd)\.|(?:\p{L}\.){2,}|\b\p{Lu}\.)$/iu

function isSentencePeriod(text: string, index: number): boolean {
  const following = text.slice(index + 1)
  if (!following.trim()) return true
  // Internal abbreviation/version/decimal punctuation is not a sentence end.
  if (!/^\s/u.test(following)) return false
  return !PERIOD_ABBREVIATION.test(text.slice(0, index + 1))
}

/** Keep qualifiers and parenthetical examples intact while isolating claims. */
function splitWindowsClaimBoundaries(text: string, boundary: RegExp): string[] {
  const clauses: string[] = []
  const grouping: string[] = []
  let scanned = 0
  let start = 0
  for (const match of text.matchAll(new RegExp(boundary.source, `${boundary.flags.replace(/g/g, '')}g`))) {
    const index = match.index ?? 0
    for (; scanned < index; scanned += 1) {
      const character = text[scanned]!
      if (character === '(' || character === '[') grouping.push(character)
      if ((character === ')' && grouping.at(-1) === '(') ||
          (character === ']' && grouping.at(-1) === '[')) grouping.pop()
    }
    if (grouping.length > 0) continue
    if (match[0] === '.' && !isSentencePeriod(text, index)) continue
    if (/\bwhile\b/i.test(match[0])) continue
    if (WINDOWS_DEPENDENT_CLAIM_START.test(text.slice(index + match[0].length).trimStart())) continue
    clauses.push(text.slice(start, index))
    start = index + match[0].length
  }
  clauses.push(text.slice(start))
  return clauses
}

function hasBalancedClaimGrouping(text: string): boolean {
  const grouping: string[] = []
  for (const character of text) {
    if (character === '(' || character === '[') grouping.push(character)
    if (character === ')' || character === ']') {
      if (grouping.pop() !== (character === ')' ? '(' : '[')) return false
    }
  }
  return grouping.length === 0
}

const RELATIONSHIP_MARKERS: ReadonlyArray<{
  summary: RegExp
  evidence: RegExp
  anchorMode?: 'overlap'
}> = [
  {
    summary: /\b(?:after|once|when)\b/i,
    evidence: /\b(?:after|once|when)\b/i,
    anchorMode: 'overlap'
  },
  { summary: /\bbefore\b/i, evidence: /\bbefore\b/i },
  { summary: /\bbecause\b/i, evidence: /\bbecause\b/i },
  { summary: /\bdue\s+to\b/i, evidence: /\bdue\s+to\b/i },
  {
    summary: /\b(?:drive|drives|drove|driven|driving)\b/i,
    evidence: /\b(?:drive|drives|drove|driven|driving)\b/i
  },
  {
    summary: /\b(?:lead|leads|led|leading)\s+to\b/i,
    evidence: /\b(?:lead|leads|led|leading)\s+to\b/i
  },
  {
    summary: /\b(?:result|results|resulted|resulting)\s+in\b/i,
    evidence: /\b(?:result|results|resulted|resulting)\s+in\b/i
  },
  {
    summary: /\b(?:cause|causes|caused|causing)\b/i,
    evidence: /\b(?:cause|causes|caused|causing)\b/i
  },
  {
    summary: /\b(?:at\s+the\s+cost\s+of|sacrific(?:e|ed|ing))\b/i,
    evidence: /\b(?:at\s+the\s+cost\s+of|sacrific(?:e|ed|ing))\b/i
  }
]

const RELATION_ANCHOR_STOP = new Set([
  'ahead',
  'better',
  'behind',
  'cause',
  'caus',
  'cost',
  'decrease',
  'decline',
  'drive',
  'driv',
  'drop',
  'fewer',
  'gain',
  'higher',
  'improve',
  'increase',
  'lead',
  'less',
  'lower',
  'more',
  'once',
  'result',
  'rise',
  'sacrifice',
  'sacrific',
  'worse'
])

const DECISION_OBJECT_STOP = new Set([
  'agree',
  'agre',
  'approve',
  'approv',
  'choose',
  'chose',
  'decide',
  'decid',
  'decision',
  'going',
  'will'
])

const PLANNED_ACTION_SUMMARY = /^\s*(?:plan|planned|planning)\b/i
const EXPLICIT_PLAN_SPEECH =
  /\b(?:(?:i|we)\s+plan\s+to|(?:i(?:['’]m|\s+am)|we(?:['’]re|\s+are))\s+planning\s+to|my\s+plan\s+is\s+to)\b/i
const PLAN_TOKEN_STOP = new Set(['plan', 'plann'])

const PLAN_PREFIX = /^\s*(?:plan|planned|planning)(?:\s+to)?\s+/i
const COORDINATED_ACTION_HEAD =
  '(?:add|approve|ask|build|call|check|collect|create|deploy|distribute|document|email|fix|follow\\s+up|gather|handle|implement|investigate|launch|monitor|notify|ping|prepare|reach\\s+out|release|remind|remove|review|roll\\s+out|schedule|send|share|ship|start|submit|test|update|watch|write)'
const COORDINATED_ACTION_BOUNDARY = new RegExp(`\\s+and\\s+(?=${COORDINATED_ACTION_HEAD}\\b)`, 'gi')

type ReleaseLifecycleFamily = 'launch' | 'release' | 'rollout' | 'ship'

const RELEASE_LIFECYCLE_PATTERNS: ReadonlyArray<{
  family: ReleaseLifecycleFamily
  pattern: RegExp
}> = [
  { family: 'launch', pattern: /\blaunch(?:ed|es|ing)?\b/i },
  { family: 'release', pattern: /\breleas(?:e|ed|es|ing)\b/i },
  { family: 'rollout', pattern: /\b(?:roll\s*out|rollout)(?:s)?\b/i },
  { family: 'ship', pattern: /\bship(?:ped|ping|s)?\b/i }
]

function normalizeToken(token: string): string {
  let normalized = token.toLowerCase()
  if (normalized.endsWith('ing') && normalized.length > 6) normalized = normalized.slice(0, -3)
  else if (normalized.endsWith('ed') && normalized.length > 5) normalized = normalized.slice(0, -2)
  else if (normalized.endsWith('es') && normalized.length > 5) normalized = normalized.slice(0, -2)
  else if (normalized.endsWith('s') && normalized.length > 5) normalized = normalized.slice(0, -1)
  return normalized
}

let activeTokenCache: Map<string, readonly string[]> | undefined
let activeGroundingCache: Map<string, boolean> | undefined

/** Cache only during one synchronous record validation; retain no meeting text afterward. */
function withGroundingCache<T>(validate: () => T): T {
  if (process.platform !== 'darwin' || activeTokenCache) return validate()
  activeTokenCache = new Map()
  activeGroundingCache = new Map()
  try {
    return validate()
  } finally {
    activeTokenCache = undefined
    activeGroundingCache = undefined
  }
}

function distinctiveTokens(text: string): Set<string> {
  const cached = activeTokenCache?.get(text)
  // Callers sometimes add/remove tokens, so never share a mutable Set.
  if (cached) return new Set(cached)
  const tokens = (text.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? [])
    .map(normalizeToken)
    .filter((token) => token.length >= 4 && !WORD_STOP.has(token))
  if (activeTokenCache && activeTokenCache.size < 512) activeTokenCache.set(text, tokens)
  return new Set(tokens)
}

function sharedTokenCount(left: Set<string>, right: Set<string>): number {
  let shared = 0
  for (const token of left) {
    if (right.has(token)) shared += 1
  }
  return shared
}

interface PlannedActionBranch {
  text: string
  action: string
  groundingText: string
}

function plannedActionBranches(text: string): PlannedActionBranch[] {
  const prefix = text.match(PLAN_PREFIX)?.[0]
  if (!prefix) return []

  COORDINATED_ACTION_BOUNDARY.lastIndex = 0
  const actions = text
    .slice(prefix.length)
    .split(COORDINATED_ACTION_BOUNDARY)
    .map((action) => action.trim())
    .filter(Boolean)
  if (actions.length < 2) return []

  return actions.map((action, index) => ({
    text: index === 0 ? `${prefix}${action}`.trim() : action,
    action,
    groundingText: `${prefix}${action}`.trim()
  }))
}

function actionPredicateAppears(action: string, evidence: string): boolean {
  return [...evidence.matchAll(/\b[A-Za-z]+\b/g)].some((match) =>
    actionPredicatesOverlap(action, evidence.slice(match.index ?? 0))
  )
}

function plannedActionBranchIsGrounded(branch: PlannedActionBranch, evidenceLine: string): boolean {
  if (!actionPredicateAppears(branch.action, evidenceLine)) return false

  const actionHead = branch.action.match(/^\s*([A-Za-z]+)/)?.[1]
  const actionHeadToken = actionHead ? normalizeToken(actionHead) : null
  const objectTokens = new Set(
    [...distinctiveTokens(branch.action)].filter((token) => token !== actionHeadToken)
  )
  if (objectTokens.size === 0) return false
  return (
    sharedTokenCount(objectTokens, distinctiveTokens(evidenceLine)) >=
    Math.min(2, objectTokens.size)
  )
}

function coordinatedPlanActionsAreGrounded(
  summary: string,
  evidenceLines: readonly WriterGroundingLine[]
): boolean {
  const branches = plannedActionBranches(summary)
  if (branches.length === 0) return true
  return branches.every((branch) =>
    evidenceLines.some((line) => plannedActionBranchIsGrounded(branch, line.text))
  )
}

function releaseLifecycleFamilies(text: string): Set<ReleaseLifecycleFamily> {
  return new Set(
    RELEASE_LIFECYCLE_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(
      ({ family }) => family
    )
  )
}

function releaseLifecycleLexicalBonus(
  summary: string,
  evidence: string,
  normallyShared: number
): number {
  const summaryFamilies = releaseLifecycleFamilies(summary)
  const evidenceFamilies = releaseLifecycleFamilies(evidence)
  if (summaryFamilies.size === 0 || evidenceFamilies.size === 0) return 0
  if (normallyShared > 0) return 0

  const sameFamily = [...summaryFamilies].some((family) => evidenceFamilies.has(family))
  const quantities = extractQuantityMentions(summary)
  const hasGroundedQuantity = quantities.length > 0 && quantitiesMatch(quantities, evidence)
  return sameFamily || hasGroundedQuantity ? 1 : 0
}

function hasClaimPredicate(text: string): boolean {
  return (
    directionPatterns(text).length > 0 ||
    extractQuantityMentions(text).length > 0 ||
    ASSERTIVE_COMPLETION.test(text) ||
    POSITIVE_CLAIM_STATE.test(text) ||
    NEGATIVE_CLAIM_STATE.test(text)
  )
}

function splitClaimClauses(text: string): string[] {
  const safeBoundaries = isWindowsTopicWriterEnabled()
  return (safeBoundaries ? splitWindowsClaimBoundaries(text, CLAIM_SPLIT) : text.split(CLAIM_SPLIT))
    .flatMap((clause) => {
      const claims: string[] = []
      let claimStart = 0
      ASSOCIATED_CLAIM_BOUNDARY.lastIndex = 0
      for (const match of clause.matchAll(ASSOCIATED_CLAIM_BOUNDARY)) {
        const boundaryIndex = match.index ?? 0
        const fragment = clause.slice(claimStart, boundaryIndex)
        const remainder = clause.slice(boundaryIndex + match[0].length)
        if (safeBoundaries && !hasBalancedClaimGrouping(clause.slice(0, boundaryIndex))) continue
        if (safeBoundaries && WINDOWS_DEPENDENT_CLAIM_START.test(remainder.trim())) continue
        if (SUBORDINATE_CLAIM_START.test(remainder.trim())) continue
        if (!hasClaimPredicate(fragment) || !hasClaimPredicate(remainder)) continue
        claims.push(fragment)
        claimStart = boundaryIndex + match[0].length
      }
      claims.push(clause.slice(claimStart))
      return claims
    })
    .map((clause) => clause.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

function evidenceClaimClauses(
  evidenceLines: readonly WriterGroundingLine[]
): Array<{ line: WriterGroundingLine; text: string; lineIndex: number; clauseIndex: number }> {
  return evidenceLines.flatMap((line, lineIndex) =>
    splitClaimClauses(line.text).map((text, clauseIndex) => ({
      line,
      text,
      lineIndex,
      clauseIndex
    }))
  )
}

function platformTerms(text: string): (typeof PLATFORM_TERMS)[number][] {
  return PLATFORM_TERMS.filter((term) => new RegExp(`\\b${term}\\b`, 'i').test(text))
}

function directionPatterns(text: string): RegExp[] {
  return [POSITIVE_DIRECTION, NEGATIVE_DIRECTION].filter((pattern) => pattern.test(text))
}

function quantitiesMatch(
  summaryMentions: ReturnType<typeof extractQuantityMentions>,
  evidenceText: string
): boolean {
  const evidenceMentions = extractQuantityMentions(evidenceText)
  return summaryMentions.every((summaryMention) =>
    evidenceMentions.some((evidenceMention) =>
      quantityMentionsEquivalent(summaryMention, evidenceMention)
    )
  )
}

function structuredClaimMatches(summaryClause: string, evidenceClause: string): boolean {
  const metrics = requiredMetricGroups(summaryClause)
  const terms = platformTerms(summaryClause)
  const directions = directionPatterns(summaryClause)
  const quantities = extractQuantityMentions(summaryClause)
  return (
    metrics.every((metric) => metric.test(evidenceClause)) &&
    terms.every((term) => new RegExp(`\\b${term}\\b`, 'i').test(evidenceClause)) &&
    directions.every((direction) => direction.test(evidenceClause)) &&
    quantitiesMatch(quantities, evidenceClause)
  )
}

function hasExplicitNegation(text: string): boolean {
  const withoutConversationalResponses = text
    .replace(/\bnot\s+only\b/gi, ' ')
    .replace(/\bno(?:\s+no)?\s+(?:fair|okay|right|sure|yeah|that(?:'s|\s+is))\b/gi, ' ')
    // "those without" / "users without" names the complement group; it is not
    // a claim-level negation the way "without evidence" or "did not" is.
    .replace(/\b(?:those|these|people|users|customers|ones)\s+without\b/gi, ' ')
    // Contrastive "relative, not absolute" pairs two poles; it does not flip
    // the surrounding quantitative claim.
    .replace(/\b[\p{L}]+,\s+not\s+[\p{L}]+\b/giu, ' ')
  return ASSERTION_NEGATION.test(withoutConversationalResponses)
}

function hasNonAssertiveModality(text: string): boolean {
  let comparable = text
  if (DECISION_EVIDENCE.test(comparable)) {
    comparable = comparable.replace(/\b(?:can|could|should|would)\b/gi, ' ')
  }
  // ASR often stutters a copula at a stitch ("are are that's the rate");
  // that is not an interrogative lead.
  const withoutAuxiliaryStutter = comparable
    .trim()
    .replace(/^(?:(?:is|are|was|were|do|does|did)\s+){2,}/i, '')
  return (
    NON_ASSERTIVE_MODALITY.test(comparable) || LEADING_QUESTION.test(withoutAuxiliaryStutter)
  )
}

function relevantEvidenceSpan(
  summaryClause: string,
  evidenceClause: string,
  leadWords = 8,
  preserveSingleLetterWords = false
): string {
  const summaryTokens = distinctiveTokens(summaryClause)
  const words = [...evidenceClause.matchAll(preserveSingleLetterWords ? /[a-z][a-z'-]*/gi : /[a-z][a-z'-]+/gi)]
  const sharedWordIndexes = words
    .map((match, index) => (summaryTokens.has(normalizeToken(match[0])) ? index : -1))
    .filter((index) => index >= 0)
  if (sharedWordIndexes.length === 0) return evidenceClause

  // Keep enough leading context to retain question/tentative markers such as
  // "do you think" while still excluding unrelated clauses in long ASR rows.
  const first = Math.max(0, Math.min(...sharedWordIndexes) - leadWords)
  const last = Math.min(words.length - 1, Math.max(...sharedWordIndexes) + 5)
  const start = words[first]?.index ?? 0
  const lastMatch = words[last]
  const end =
    lastMatch == null ? evidenceClause.length : (lastMatch.index ?? 0) + lastMatch[0].length
  return evidenceClause
    .slice(start, end)
    .replace(/\b(?:and|but|so)\s+(?=(?:maybe|might|perhaps|possibly|probably)\b)[\s\S]*$/i, '')
    .trim()
}

function assertionPolarityIsGrounded(
  summary: string,
  evidenceLines: readonly WriterGroundingLine[],
  // Paraphrase mode trims the lead so a negation stitched in from the previous
  // ASR sentence fragment does not flip the polarity of an unrelated claim.
  leadWords = 8,
  scoped = false,
  preserveSingleLetterWords = false
): boolean {
  // A hold can be definite while the event ending it remains uncertain. Only
  // compare these parts separately when the summary also retains the qualifier;
  // an unqualified claim must still face the complete conditional evidence.
  const compareOngoingQualifier = scoped && /\S\s+(?:until|while)\s+\S/iu.test(summary)
  const ongoingParts = (clause: string): string[] => {
    if (!compareOngoingQualifier) return [clause]
    for (const match of clause.matchAll(/\s+(?=(?:until|while)\b)/giu)) {
      const index = match.index ?? 0
      if (!hasBalancedClaimGrouping(clause.slice(0, index))) continue
      return [clause.slice(0, index), clause.slice(index).trimStart()]
    }
    return [clause]
  }
  const clauses = (text: string): string[] =>
    splitClaimClauses(scoped ? text.replace(/^\s*no,\s*/iu, '') : text).flatMap((clause) =>
      scoped ? clause.split(/,\s+(?:then\s+|with\s+(?=no\b)|(?=focusing\s+on\b))|\s+and\s+(?=remains?\s+undecided\b)/iu) : [clause]
    ).flatMap(ongoingParts)
  const evidenceClauses = evidenceLines.flatMap((line) => clauses(line.text).map((text) => ({ text })))

  return clauses(summary).every((summaryClause) => {
    const summaryTokens = distinctiveTokens(summaryClause)
    if (summaryTokens.size === 0) return true

    const scored = evidenceClauses.map(({ text }) => {
      // Preserve the entire clause in the line-cited experiment. Cutting the
      // first four words could remove an "if"/"unless" governing the claim.
      const relevantText = scoped ? text : relevantEvidenceSpan(summaryClause, text, leadWords, preserveSingleLetterWords)
      return {
        text: relevantText,
        shared: sharedTokenCount(summaryTokens, distinctiveTokens(relevantText))
      }
    })
    const bestShared = Math.max(0, ...scored.map((candidate) => candidate.shared))
    if (bestShared === 0) return true

    const negated = (text: string): boolean => hasExplicitNegation(text) || (scoped && /\b(?:undecided|unapproved)\b/iu.test(text))
    const summaryNegated = negated(summaryClause)
    const nonAssertive = (text: string): boolean =>
      (compareOngoingQualifier && /^(?:until|while)\b/iu.test(text)) || hasNonAssertiveModality(scoped
      ? text.replace(/\bso\s+(?:that\s+)?(?:we|they|you|i)\s+can\s+/giu, 'so ')
      : text)
    const summaryNonAssertive = nonAssertive(summaryClause)
    return scored.some(
      (candidate) =>
        candidate.shared === bestShared &&
        negated(candidate.text) === summaryNegated &&
        (summaryNonAssertive || !nonAssertive(candidate.text) ||
          // A prescribed question in a script describes its intended focus;
          // it does not make the preceding commitment tentative.
          (scoped && /^focusing\s+on\b/iu.test(summaryClause) &&
            /\bshould\s+(?:ask|focus|cover|include)\b/iu.test(candidate.text) &&
            !/\b(?:if|unless|might|maybe|perhaps)\b/iu.test(candidate.text)))
    )
  })
}

/** Bind asserted states and contrastive quantity subjects, not just shared nouns. */
function windowsClaimBindingsAreGrounded(summary: string, lines: readonly WriterGroundingLine[]): boolean {
  const evidence = evidenceClaimClauses(lines).flatMap(({ text }) => text.split(/,\s+then\s+/iu))
  const allTokens = distinctiveTokens(evidence.join(' '))
  return splitClaimClauses(summary).every((clause) => {
    const states = clause.match(/\b(?:approved|available|enabled|disabled|rejected)\b/giu) ?? []
    if (!hasNonAssertiveModality(clause) && states.some((state) =>
      !evidence.some((text) => new RegExp(`\\b${state === 'approved' ? 'approv(?:ed|ing|e|es)' : state}\\b`, 'iu').test(text) &&
        hasExplicitNegation(text) === hasExplicitNegation(clause) && !hasNonAssertiveModality(text))
    )) return false
    const mentions = extractQuantityMentions(clause)
    const metrics = requiredMetricGroups(clause)
    // Apply subject contrast only to single-quantity claims with a repeated
    // metric. A combined registration/target fact legitimately spans clauses.
    if (mentions.length !== 1 || metrics.length === 0 ||
        evidence.filter((text) => metrics.some((metric) => metric.test(text)) && extractQuantityMentions(text).length > 0).length < 2) return true
    const summaryTokens = distinctiveTokens(clause)
    return mentions.every((mention) => evidence.some((text) => {
      if (!extractQuantityMentions(text).some((other) => quantityMentionsEquivalent(mention, other))) return false
      const localTokens = distinctiveTokens(text)
      // A subject explicitly named elsewhere in this citation cannot borrow
      // this clause's quantity merely because both clauses mention a rate.
      return [...summaryTokens].every((token) => !allTokens.has(token) || localTokens.has(token))
    }))
  })
}

function alternativeAnchorTokens(text: string): Set<string> {
  const anchors = new Set(
    (text.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? [])
      .map(normalizeToken)
      .filter((token) => token.length >= 2 && !ALTERNATIVE_ANCHOR_STOP.has(token))
  )
  for (const quantity of extractQuantityMentions(text)) {
    anchors.add(`quantity:${quantity.canonical}`)
  }
  return anchors
}

type ClaimState = 'negative' | 'neutral' | 'positive'

function claimState(text: string): ClaimState {
  if (hasExplicitNegation(text) || NEGATIVE_CLAIM_STATE.test(text)) return 'negative'
  if (POSITIVE_CLAIM_STATE.test(text)) return 'positive'
  return 'neutral'
}

function alternativePrimaryAnchor(text: string): string | null {
  const quantity = extractQuantityMentions(text)[0]
  if (quantity) return `quantity:${quantity.canonical}`

  const payload = text.match(ALTERNATIVE_PAYLOAD_PREFIX)?.[1] ?? text
  const token = (payload.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? [])
    .map(normalizeToken)
    .find((candidate) => candidate.length >= 2 && !ALTERNATIVE_PRIMARY_STOP.has(candidate))
  return token ?? null
}

function alternativeAnchorAppears(anchor: string, evidenceClause: string): boolean {
  if (!anchor.startsWith('quantity:')) {
    return alternativeAnchorTokens(evidenceClause).has(anchor)
  }

  const canonical = anchor.slice('quantity:'.length)
  return extractQuantityMentions(evidenceClause).some((mention) => mention.canonical === canonical)
}

function relationshipRequirementsAreGrounded(
  summaryClause: string,
  evidenceClause: string
): boolean {
  return RELATIONSHIP_MARKERS.every(
    ({ summary: summaryPattern, evidence: evidencePattern }) =>
      !summaryPattern.test(summaryClause) || evidencePattern.test(evidenceClause)
  )
}

function explicitAlternativesAreGrounded(
  summary: string,
  evidenceLines: readonly WriterGroundingLine[],
  skipTentativeClauses = false
): boolean {
  const evidenceClauses = evidenceClaimClauses(evidenceLines)

  return splitClaimClauses(summary).every((summaryClause) => {
    const alternatives = summaryClause
      .split(/\bor\b/i)
      .map((alternative) => alternative.trim())
      .filter(Boolean)
    if (alternatives.length < 2) return true
    // A tentative option list ("unclear whether A or B") asserts nothing firm.
    if (skipTentativeClauses && hasNonAssertiveModality(summaryClause)) return true

    const directStates = alternatives.map(claimState)
    const inheritedStates = new Set(directStates.filter((state) => state !== 'neutral'))
    const inheritedState = inheritedStates.size === 1 ? [...inheritedStates][0]! : 'neutral'
    const inheritedStateIsAmbiguous = inheritedStates.size > 1
    const summaryAllowsTentative = hasNonAssertiveModality(summaryClause)

    return alternatives.every((alternative, index) => {
      const anchor = alternativePrimaryAnchor(alternative)
      if (!anchor) return false
      const directState = directStates[index] ?? 'neutral'
      if (directState === 'neutral' && inheritedStateIsAmbiguous) return false
      const expectedState = directState === 'neutral' ? inheritedState : directState

      return evidenceClauses.some(({ text: evidenceClause }) => {
        if (!alternativeAnchorAppears(anchor, evidenceClause)) return false
        if (!structuredClaimMatches(alternative, evidenceClause)) return false
        if (expectedState !== 'neutral' && claimState(evidenceClause) !== expectedState)
          return false
        if (!summaryAllowsTentative && hasNonAssertiveModality(evidenceClause)) return false
        return relationshipRequirementsAreGrounded(summaryClause, evidenceClause)
      })
    })
  })
}

function hasNonFutureCompletion(text: string): boolean {
  const completionPattern = /\b(?:complete|completed|finished|passed|done)\b/gi
  for (const match of text.matchAll(completionPattern)) {
    const prefix = text.slice(Math.max(0, (match.index ?? 0) - 80), match.index)
    if (FUTURE_COMPLETION_PREFIX.test(prefix)) continue
    if (hasExplicitNegation(text) || hasNonAssertiveModality(text)) continue
    return true
  }
  return false
}

function completionSubjectTokens(text: string): Set<string> {
  const quantities = windowsNumberWordCompletionEnabled() ? extractQuantityMentions(text) : []
  let lexicalText = text
  for (const mention of [...quantities].reverse()) {
    lexicalText = lexicalText.slice(0, mention.start) + ' ' + lexicalText.slice(mention.end)
  }
  const tokens = new Set(
    (lexicalText.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? [])
      .map(normalizeToken)
      .filter((token) => token.length >= 2 && !COMPLETION_SUBJECT_STOP.has(token))
  )
  // Preserve numeric subjects, including one-digit counts, across written/spoken forms.
  for (const mention of quantities) tokens.add(`quantity:${mention.canonical}`)
  return tokens
}

function completionSubjectIsSupported(
  summaryClause: string,
  evidenceContext: string,
  requireExplicitPlatform: boolean
): boolean {
  const summaryPlatforms = platformTerms(summaryClause)
  const evidencePlatforms = platformTerms(evidenceContext)
  const hasEverySummaryPlatform = summaryPlatforms.every((term) => evidencePlatforms.includes(term))

  if (summaryPlatforms.length > 0 && evidencePlatforms.length > 0 && !hasEverySummaryPlatform) {
    return false
  }
  if (requireExplicitPlatform && summaryPlatforms.length > 0 && !hasEverySummaryPlatform) {
    return false
  }

  if (windowsNumberWordCompletionEnabled()) {
    const summaryQuantities = extractQuantityMentions(summaryClause)
    const evidenceQuantities = extractQuantityMentions(evidenceContext)
    // A mixed cohort such as "18 of 24 passed" cannot support picking either count
    // as the completed subject. Compare within this predicate, never the full citation.
    if (summaryQuantities.length > 0 && (
      summaryQuantities.length !== evidenceQuantities.length ||
      !areQuantitiesGrounded(summaryClause, evidenceContext, { consumeEvidenceMentions: true })
    )) return false
  }

  const platformSet = new Set<string>(summaryPlatforms)
  const summarySubjects = new Set(
    [...completionSubjectTokens(summaryClause)].filter((token) => !platformSet.has(token))
  )
  const evidenceSubjects = completionSubjectTokens(evidenceContext)
  const hasEverySummarySubject = [...summarySubjects].every((subject) =>
    evidenceSubjects.has(subject)
  )

  // A matching broad platform is not enough to bind completion to a specific
  // product/build on that platform. When the summary names a discriminating
  // subject, require that subject in the completed clause as well.
  if (summarySubjects.size > 0) return hasEverySummarySubject
  if (summaryPlatforms.length > 0) return hasEverySummaryPlatform
  return true
}

function completionClaimsAreGrounded(
  summary: string,
  evidenceLines: readonly WriterGroundingLine[]
): boolean {
  const evidenceClauses = evidenceClaimClauses(evidenceLines)

  return splitClaimClauses(summary).every((summaryClause) => {
    if (
      !ASSERTIVE_COMPLETION.test(summaryClause) ||
      hasExplicitNegation(summaryClause) ||
      hasNonAssertiveModality(summaryClause)
    ) {
      return true
    }

    return evidenceClauses.some(({ text: evidenceClause }, index) => {
      if (!hasNonFutureCompletion(evidenceClause)) return false

      const directPlatforms = platformTerms(evidenceClause)
      if (completionSubjectIsSupported(summaryClause, evidenceClause, directPlatforms.length > 0)) {
        return true
      }

      if (!ANAPHORIC_COMPLETION.test(evidenceClause.trim())) return false
      const precedingClause = evidenceClauses[index - 1]?.text
      return (
        precedingClause != null &&
        completionSubjectIsSupported(summaryClause, precedingClause, true)
      )
    })
  })
}

function percentageContextIsGrounded(summary: string, evidence: string): boolean {
  const tokens = (text: string): Set<string> =>
    new Set(
      (text.toLowerCase().match(/[a-z]{3,}/g) ?? [])
        .map(normalizeToken)
        .filter((token) => !PERCENTAGE_CONTEXT_STOP.has(token))
    )
  return sharedTokenCount(tokens(summary), tokens(evidence)) >= 1
}

function requiredMetricGroups(summary: string): RegExp[] {
  return METRIC_GROUPS.filter((pattern) => pattern.test(summary))
}

function quantitiesBindToTheirMetrics(
  summary: string,
  evidenceLines: readonly WriterGroundingLine[]
): boolean {
  const evidenceClauses = evidenceClaimClauses(evidenceLines)

  return splitClaimClauses(summary).every((summaryClause) => {
    const mentions = extractQuantityMentions(summaryClause)
    if (mentions.length === 0) return true
    const metrics = requiredMetricGroups(summaryClause)
    const terms = platformTerms(summaryClause)
    const directions = directionPatterns(summaryClause)
    const summaryTokens = distinctiveTokens(summaryClause)

    return mentions.every((summaryMention) =>
      evidenceClauses.some(({ text: evidenceClause }) => {
        const quantityMatches = extractQuantityMentions(evidenceClause).some((evidenceMention) =>
          quantityMentionsEquivalent(summaryMention, evidenceMention)
        )
        if (!quantityMatches) return false
        if (
          summaryMention.kind === 'percentage' &&
          metrics.length === 0 &&
          !percentageContextIsGrounded(summaryClause, evidenceClause)
        ) {
          return false
        }
        if (!structuredClaimMatches(summaryClause, evidenceClause)) return false
        if (metrics.length > 0 || terms.length > 0 || directions.length > 0) return true
        if (summaryMention.kind === 'ratio') return true
        const shared = sharedTokenCount(summaryTokens, distinctiveTokens(evidenceClause))
        return shared + releaseLifecycleLexicalBonus(summaryClause, evidenceClause, shared) >= 1
      })
    )
  })
}

function splitPlatformClaims(summary: string): string[] {
  return splitClaimClauses(summary)
}

function platformClaimsAreGrounded(
  summary: string,
  evidenceLines: readonly WriterGroundingLine[]
): boolean {
  const evidenceClauses = evidenceClaimClauses(evidenceLines)
  return splitPlatformClaims(summary).every((clause) => {
    const terms = platformTerms(clause)
    if (terms.length === 0) return true

    const quantities = extractQuantityMentions(clause)
    const metrics = requiredMetricGroups(clause)
    const directions = directionPatterns(clause)

    return evidenceClauses.some(({ text: evidenceClause }) => {
      const lineQuantities = extractQuantityMentions(evidenceClause)
      return (
        terms.every((term) => new RegExp(`\\b${term}\\b`, 'i').test(evidenceClause)) &&
        quantities.every((quantity) =>
          lineQuantities.some((candidate) => quantityMentionsEquivalent(quantity, candidate))
        ) &&
        metrics.every((metric) => metric.test(evidenceClause)) &&
        directions.every((direction) => direction.test(evidenceClause))
      )
    })
  })
}

function directionsBindToTheirMetrics(
  summary: string,
  evidenceLines: readonly WriterGroundingLine[]
): boolean {
  const evidenceClauses = evidenceClaimClauses(evidenceLines)
  return splitClaimClauses(summary).every((summaryClause) => {
    const directions = directionPatterns(summaryClause)
    if (directions.length === 0) return true
    return evidenceClauses.some(
      ({ text: evidenceClause }) =>
        structuredClaimMatches(summaryClause, evidenceClause) &&
        directions.every((direction) => direction.test(evidenceClause))
    )
  })
}

/** "new"/"old" are synthesis modifiers, not platforms; paraphrase mode skips them. */
const GENERIC_PLATFORM_MODIFIERS = new Set(['new', 'old', 'older', 'previous'])

function platformTermsAreGrounded(
  summary: string,
  evidence: string,
  corePlatformsOnly = false
): boolean {
  const normalizedSummary = summary.toLowerCase()
  const normalizedEvidence = evidence.toLowerCase()
  return PLATFORM_TERMS.every(
    (term) =>
      (corePlatformsOnly && GENERIC_PLATFORM_MODIFIERS.has(term)) ||
      !new RegExp(`\\b${term}\\b`).test(normalizedSummary) ||
      new RegExp(`\\b${term}\\b`).test(normalizedEvidence)
  )
}

function uppercaseEntitiesAreGrounded(summary: string, evidence: string): boolean {
  const entities = summary.match(/\b[A-Z][A-Z0-9-]{1,}\b/g) ?? []
  return entities.every((entity) =>
    new RegExp(`\\b${entity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(evidence)
  )
}

const CAPITALIZED_ENTITY_EXEMPTIONS = new Set([
  'A',
  'An',
  'The',
  'On',
  'In',
  'For',
  'After',
  'Before',
  'Begin',
  'More',
  'Higher',
  'Lower',
  'New',
  'Old',
  'Current',
  'Local',
  'Build',
  'Version',
  'Trial',
  'Need',
  'Add',
  'Ask',
  'Check',
  'Create',
  'Review',
  'Send',
  'Approve',
  'Watch',
  'Handle',
  'Data',
  'Feature',
  'Gather',
  'Release',
  'Plan',
  'Planned'
])

function capitalizedEntitiesAreGrounded(summary: string, evidence: string): boolean {
  const entities = [...summary.matchAll(/\b[A-Z][a-z][A-Za-z0-9-]*\b/g)]
  return entities.every((match) => {
    const entity = match[0]
    // Capitalization at the beginning of prose is grammar, not entity evidence.
    if ((match.index ?? 0) === 0) return true
    return (
      CAPITALIZED_ENTITY_EXEMPTIONS.has(entity) ||
      new RegExp(`\\b${entity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(evidence)
    )
  })
}

function relationshipAnchorTokens(text: string): Set<string> {
  return new Set([...distinctiveTokens(text)].filter((token) => !RELATION_ANCHOR_STOP.has(token)))
}

function relationshipMarkersAreGrounded(
  summary: string,
  evidenceLines: readonly WriterGroundingLine[]
): boolean {
  const evidenceClauses = evidenceClaimClauses(evidenceLines)
  return splitClaimClauses(summary).every((summaryClause) =>
    RELATIONSHIP_MARKERS.every(
      ({ summary: summaryPattern, evidence: evidencePattern, anchorMode }) => {
        if (!summaryPattern.test(summaryClause)) return true
        if (/\bor\b/i.test(summaryClause)) return true
        const anchors = relationshipAnchorTokens(summaryClause)
        const candidateClauses =
          anchorMode === 'overlap' && evidenceLines.length > 1
            ? [
                ...evidenceClauses,
                {
                  line: evidenceLines[0]!,
                  text: evidenceLines.map((line) => line.text).join(' '),
                  lineIndex: 0,
                  clauseIndex: 0
                }
              ]
            : evidenceClauses
        return candidateClauses.some(({ text: evidenceClause }) => {
          if (!evidencePattern.test(evidenceClause)) return false
          if (!structuredClaimMatches(summaryClause, evidenceClause)) return false
          const evidenceTokens = relationshipAnchorTokens(evidenceClause)
          const shared = [...anchors].filter((token) => evidenceTokens.has(token)).length
          const lifecycleOverlap =
            releaseLifecycleFamilies(summaryClause).size > 0 &&
            releaseLifecycleFamilies(evidenceClause).size > 0
              ? 1
              : 0
          return anchorMode === 'overlap'
            ? shared + lifecycleOverlap >= Math.min(2, anchors.size)
            : shared === anchors.size
        })
      }
    )
  )
}

function hasMixedScriptToken(text: string): boolean {
  return (text.match(/\p{L}+/gu) ?? []).some(
    (token) =>
      /\p{Script=Latin}/u.test(token) && /(?:\p{Script=Greek}|\p{Script=Cyrillic})/u.test(token)
  )
}

function purposeTailsAreGrounded(summary: string, evidence: string): boolean {
  const purposeStart = summary.search(/\b(?:in order to|to enable|so that)\b/i)
  if (purposeStart < 0) return true

  const purpose = summary.slice(purposeStart)
  const marker = purpose.match(/^\b(?:in order to|to enable|so that)\b/i)?.[0]
  if (!marker || !new RegExp(`\\b${marker.replace(/\s+/g, '\\s+')}\\b`, 'i').test(evidence)) {
    return false
  }

  const purposeTokens = distinctiveTokens(purpose)
  const evidenceTokens = distinctiveTokens(evidence)
  return [...purposeTokens].every((token) => evidenceTokens.has(token))
}

const FAILURE_PREDICATE = /\b(?:fail(?:ed|ing|s)?|failures?|unsuccessful)\b/giu
const STATED_FAILURE_NOUN =
  /\b(?:is|are|was|were|confirmed|recorded|identified|reported|found)\s+(?:(?:a|the|confirmed|actual)\s+)*failures?\b|\bfailures?\s+(?:is|are|was|were)\s+confirmed\b/iu

function isAffirmativeFailureClaim(text: string): boolean {
  if (!/\b(?:fail(?:ed|ing|s)?|unsuccessful)\b/iu.test(text) && !STATED_FAILURE_NOUN.test(text)) return false
  // "Failed to compile" asserts failure; "did not fail to compile" does not.
  if (hasExplicitNegation(text.replace(/\bfail(?:ed|s)?\s+to\b/giu, ' ')) ||
      hasNonAssertiveModality(text) || /\b(?:unconfirmed|awaiting|suspected|potential|possible)\b/iu.test(text)) return false
  return [...text.matchAll(FAILURE_PREDICATE)].some((match) => {
    const prefix = text.slice(Math.max(0, (match.index ?? 0) - 80), match.index)
    return !FUTURE_COMPLETION_PREFIX.test(prefix)
  })
}

/** A failure outcome needs affirmative evidence for that subject and cohort. */
function windowsFailureClaimsAreGrounded(
  summary: string,
  evidenceLines: readonly WriterGroundingLine[]
): boolean {
  const evidenceClauses = evidenceClaimClauses(evidenceLines)
  const subject = (text: string): string => text.replace(FAILURE_PREDICATE, ' ').replace(/\bconfirmed\b/giu, ' ')
  // Bind letter labels such as "Build A", not a sentence-initial article "A".
  const letterIdentifiers = (text: string): string[] =>
    [...text.matchAll(/\b[\p{L}][\p{L}\d-]+\s+([A-Z])\b/gu)].map((match) => match[1]!)
  return splitClaimClauses(summary).every((summaryClause) => {
    if (!isAffirmativeFailureClaim(summaryClause)) return true
    const negativeAction = /\bfail(?:ed|s)?\s+to\b/iu.exec(summaryClause)
    if (negativeAction) {
      // Negative-action paraphrases also have explicit forms such as "does not
      // update". Keep subject/cohort binding here; scoped polarity checks the
      // paraphrase rather than requiring the source to repeat the word "fail".
      const summarySubject = summaryClause.slice(0, negativeAction.index)
      return evidenceClauses.some(({ text }) => {
        const negative = /\b(?:fail(?:ed|s)?\s+to|(?:do|does|did|has|have|had)\s+not|don't|doesn't|didn't|hasn't|haven't|hadn't)\b/iu.exec(text)
        if (!negative || hasNonAssertiveModality(text)) return false
        if (/^\s*(?:fail(?:ed|s)?|not|never)\b/iu.test(text.slice(negative.index + negative[0].length))) return false
        const evidenceSubject = text.slice(0, negative.index)
        return !hasExplicitNegation(evidenceSubject) &&
          !FUTURE_COMPLETION_PREFIX.test(evidenceSubject) &&
          completionSubjectIsSupported(summarySubject, evidenceSubject, true) &&
          letterIdentifiers(summarySubject).every((identifier) => letterIdentifiers(evidenceSubject).includes(identifier))
      })
    }
    return evidenceClauses.some(({ text }) =>
      isAffirmativeFailureClaim(text) &&
      completionSubjectIsSupported(subject(summaryClause), subject(text), true) &&
      letterIdentifiers(summaryClause).every((identifier) => letterIdentifiers(text).includes(identifier))
    )
  })
}

function windowsPurposeIsGrounded(summary: string, evidence: string): boolean {
  const purpose = summary.match(/\b(?:created|drafted|written|released|sent|designed|updated|raised|lowered)\b[\s\S]*?\bto\s+([a-z][\s\S]*)/iu)?.[1]
  if (!purpose) return true
  const tokens = distinctiveTokens(purpose)
  if (tokens.size === 0) return true
  const shared = sharedTokenCount(tokens, distinctiveTokens(evidence))
  return shared >= Math.min(3, tokens.size) && shared / tokens.size >= 0.7
}

function textIsGrounded(
  summary: string,
  evidenceLines: readonly WriterGroundingLine[],
  allowAcceptedProposal = false,
  mode: WriterGroundingMode = 'verbatim',
  preserveSingleLetterWords = false
): boolean {
  if (!activeGroundingCache) {
    return evaluateTextGrounding(
      summary,
      evidenceLines,
      allowAcceptedProposal,
      mode,
      preserveSingleLetterWords
    )
  }
  const key = JSON.stringify([
    summary,
    evidenceLines.map((line) => [line.startMs, line.text]),
    allowAcceptedProposal,
    mode,
    preserveSingleLetterWords
  ])
  const cached = activeGroundingCache.get(key)
  if (cached !== undefined) return cached
  const grounded = evaluateTextGrounding(
    summary,
    evidenceLines,
    allowAcceptedProposal,
    mode,
    preserveSingleLetterWords
  )
  if (activeGroundingCache.size < 512) activeGroundingCache.set(key, grounded)
  return grounded
}

function evaluateTextGrounding(
  summary: string,
  evidenceLines: readonly WriterGroundingLine[],
  allowAcceptedProposal = false,
  mode: WriterGroundingMode = 'verbatim',
  preserveSingleLetterWords = false
): boolean {
  const trimmed = summary.replace(/\s+/g, ' ').trim()
  if (!trimmed || evidenceLines.length === 0) return false
  if (hasMixedScriptToken(trimmed)) return false
  const evidence = evidenceLines.map((line) => line.text).join(' ')

  if (mode === 'paraphrase') {
    if (!explicitAlternativesAreGrounded(trimmed, evidenceLines, true)) return false
    if (!completionClaimsAreGrounded(trimmed, evidenceLines)) return false
    if (isWindowsTopicWriterEnabled() && !windowsFailureClaimsAreGrounded(trimmed, evidenceLines)) return false
    if (
      !assertionPolarityIsGrounded(trimmed, evidenceLines, 4, isWindowsTopicWriterEnabled()) &&
      !(allowAcceptedProposal && decisionEvidenceSupportsSummary(trimmed, evidenceLines) &&
        (!isWindowsTopicWriterEnabled() || !/\b(?:if|unless|depending\s+on)\b/iu.test(evidence)))
    ) {
      return false
    }
    if (!areQuantitiesGrounded(trimmed, evidence, { allowDerivedQuantities: true })) return false
    if (isWindowsTopicWriterEnabled() && !windowsClaimBindingsAreGrounded(trimmed, evidenceLines)) return false
    if (isWindowsCatalogWriterEnabled() && /\b(?:because|due\s+to|resulting\s+in|so\s+that|in\s+order\s+to)\b/iu.test(trimmed) &&
        !relationshipMarkersAreGrounded(trimmed, evidenceLines)) return false
    if (isWindowsCatalogWriterEnabled() && !windowsPurposeIsGrounded(trimmed, evidence)) return false
    if (!platformTermsAreGrounded(trimmed, evidence, true)) return false
    // Zero distinctive-token overlap means the citation resolved to unrelated
    // speech; any real synthesis shares at least one anchor with its source.
    const summaryTokens = distinctiveTokens(trimmed)
    if (summaryTokens.size === 0) return true
    const shared = sharedTokenCount(summaryTokens, distinctiveTokens(evidence))
    return shared + releaseLifecycleLexicalBonus(trimmed, evidence, shared) >= 1
  }

  if (!explicitAlternativesAreGrounded(trimmed, evidenceLines)) return false
  if (!completionClaimsAreGrounded(trimmed, evidenceLines)) return false
  if (
    !assertionPolarityIsGrounded(trimmed, evidenceLines, 8, false, preserveSingleLetterWords) &&
    !(allowAcceptedProposal && decisionEvidenceSupportsSummary(trimmed, evidenceLines))
  ) {
    return false
  }
  if (!areQuantitiesGrounded(trimmed, evidence)) return false
  if (!quantitiesBindToTheirMetrics(trimmed, evidenceLines)) return false
  if (!directionsBindToTheirMetrics(trimmed, evidenceLines)) return false
  if (!platformTermsAreGrounded(trimmed, evidence)) return false
  if (!platformClaimsAreGrounded(trimmed, evidenceLines)) return false
  if (!uppercaseEntitiesAreGrounded(trimmed, evidence)) return false
  if (!capitalizedEntitiesAreGrounded(trimmed, evidence)) return false
  if (!purposeTailsAreGrounded(trimmed, evidence)) return false
  if (!relationshipMarkersAreGrounded(trimmed, evidenceLines)) return false
  if (!coordinatedPlanActionsAreGrounded(trimmed, evidenceLines)) return false

  const summaryTokens = distinctiveTokens(trimmed)
  const evidenceTokens = distinctiveTokens(evidence)
  const normallyShared = sharedTokenCount(summaryTokens, evidenceTokens)
  const shared = normallyShared + releaseLifecycleLexicalBonus(trimmed, evidence, normallyShared)
  // A typed quantity whose metric/subject binding passed above is already a
  // strong lexical anchor, including short anaphoric rows such as "about 10%."
  if (extractQuantityMentions(trimmed).length > 0) return true
  if (summaryTokens.size <= 3) return shared >= 1
  const coverage = shared / summaryTokens.size
  return shared >= 2 && (coverage >= 0.2 || shared >= 4)
}

function evidenceWindows<T extends WriterGroundingLine>(
  lines: readonly T[],
  maxLines = 3,
  maxSpanMs = MAX_EVIDENCE_SPAN_MS
): T[][] {
  const windows: T[][] = []
  for (let start = 0; start < lines.length; start += 1) {
    for (let end = start; end < lines.length; end += 1) {
      if (end - start >= maxLines) break
      if (lines[end]!.startMs - lines[start]!.startMs > maxSpanMs) break
      windows.push(lines.slice(start, end + 1))
    }
  }
  return windows
}

function bestGroundedWindow(
  text: string,
  lines: readonly WriterGroundingLine[],
  allowAcceptedProposal = false,
  mode: WriterGroundingMode = 'verbatim'
): WriterGroundingLine[] | null {
  const summaryTokens = distinctiveTokens(text)
  const windows =
    mode === 'paraphrase' ? evidenceWindows(lines, 6, 60_000) : evidenceWindows(lines)
  const candidates = windows
    .filter((window) => textIsGrounded(text, window, allowAcceptedProposal, mode))
    .map((window) => {
      const evidenceTokens = distinctiveTokens(window.map((line) => line.text).join(' '))
      return {
        window,
        shared: sharedTokenCount(summaryTokens, evidenceTokens),
        span: window[window.length - 1]!.startMs - window[0]!.startMs
      }
    })

  candidates.sort((left, right) => right.shared - left.shared || left.span - right.span)
  return candidates[0]?.window ?? null
}

/**
 * An action's object may be named in its title and introduced before the
 * commitment. Keep that context within the writer's citation instead of
 * testing the title against the shortest body-only window. This cannot admit
 * a rejected body, salvage a discarded claim, or search outside citedLines.
 */
function actionTitleWindow(
  title: string,
  bodyWindow: WriterGroundingLine[],
  citedLines: readonly WriterGroundingLine[],
  mode: WriterGroundingMode
): WriterGroundingLine[] {
  const tokens = distinctiveTokens(title)
  const overlap = (window: readonly WriterGroundingLine[]): number =>
    sharedTokenCount(tokens, distinctiveTokens(window.map((line) => line.text).join(' ')))
  let best = bodyWindow
  let bestShared = overlap(best)
  if (bestShared === tokens.size) return best
  const windows =
    mode === 'paraphrase' ? evidenceWindows(citedLines, 6, 60_000) : evidenceWindows(citedLines)
  for (const window of windows) {
    // Keep every original supporting row, including simultaneous speakers.
    if (!bodyWindow.every((line) => window.includes(line))) continue
    const shared = overlap(window)
    if (shared <= bestShared || !textIsGrounded(title, window, false, mode)) continue
    best = window
    bestShared = shared
  }
  return best
}

interface ConservativeClauseCandidate {
  content: string
  groundingText: string
  plannedContext?: string
}

const VERBATIM_INCOMPLETE_END =
  /\b(?:and|as|because|but|for|he|if|of|or|she|that|the|their|them|then|this|to|we|when|with|you)\s*$/i
const VERBATIM_LOW_SIGNAL =
  /^(?:all\s+right|got\s+it|okay|right|sounds\s+good|thank\s+you|thanks|yeah|yep)[.!?]*$/i
const VAGUE_PASSIVE_FUTURE =
  /^(?:data|details?|feedback|information|results?|status|updates?)\s+(?:may|might|will|would)\s+be\s+(?:collected|gathered|reviewed|shared|used)\.?$/i

function bestVerbatimEvidenceCandidate(
  draftText: string,
  citedLines: readonly WriterGroundingLine[]
): { content: string; window: WriterGroundingLine[]; salvaged: true } | null {
  const draftTokens = distinctiveTokens(draftText)
  if (draftTokens.size === 0) return null

  const candidates = evidenceClaimClauses(citedLines)
    .filter(({ text }) => {
      const compact = text.replace(/\s+/g, ' ').trim()
      const wordCount = compact.match(/[A-Za-z]+/g)?.length ?? 0
      return (
        compact.length >= 12 &&
        compact.length <= 280 &&
        wordCount >= 4 &&
        noteTextLooksCoherent(compact) &&
        !VERBATIM_LOW_SIGNAL.test(compact) &&
        !VERBATIM_INCOMPLETE_END.test(compact) &&
        !SUBORDINATE_CLAIM_START.test(compact)
      )
    })
    .map(({ line, text }) => {
      const compact = text.replace(/\s+/g, ' ').trim()
      const evidenceTokens = distinctiveTokens(compact)
      return {
        content: compact,
        window: [line],
        salvaged: true as const,
        shared: sharedTokenCount(draftTokens, evidenceTokens),
        coverage: sharedTokenCount(draftTokens, evidenceTokens) / draftTokens.size
      }
    })
    .filter(
      (candidate) =>
        candidate.shared >= Math.min(2, draftTokens.size) &&
        (candidate.coverage >= 0.2 || candidate.shared >= 4) &&
        claimBindingsAreSafe(draftText, candidate.window) &&
        textIsGrounded(candidate.content, candidate.window)
    )
    .sort(
      (left, right) =>
        right.shared - left.shared ||
        right.coverage - left.coverage ||
        left.content.length - right.content.length
    )

  const best = candidates[0]
  return best ? { content: best.content, window: best.window, salvaged: best.salvaged } : null
}

function claimBindingsAreSafe(
  summary: string,
  evidenceLines: readonly WriterGroundingLine[]
): boolean {
  const evidence = evidenceLines.map((line) => line.text).join(' ')
  return (
    explicitAlternativesAreGrounded(summary, evidenceLines) &&
    completionClaimsAreGrounded(summary, evidenceLines) &&
    assertionPolarityIsGrounded(summary, evidenceLines) &&
    areQuantitiesGrounded(summary, evidence) &&
    quantitiesBindToTheirMetrics(summary, evidenceLines) &&
    directionsBindToTheirMetrics(summary, evidenceLines) &&
    platformTermsAreGrounded(summary, evidence) &&
    platformClaimsAreGrounded(summary, evidenceLines) &&
    uppercaseEntitiesAreGrounded(summary, evidence) &&
    capitalizedEntitiesAreGrounded(summary, evidence) &&
    purposeTailsAreGrounded(summary, evidence) &&
    relationshipMarkersAreGrounded(summary, evidenceLines) &&
    coordinatedPlanActionsAreGrounded(summary, evidenceLines)
  )
}

function splitConservativeClauses(content: string): ConservativeClauseCandidate[] {
  const safeBoundaries = isWindowsTopicWriterEnabled()
  const hasCoordinatedPlan = plannedActionBranches(content).length > 0
  const clauses = (safeBoundaries
    ? splitWindowsClaimBoundaries(content, /(?:[;!?]|\.(?!\d)|\s+[—–]\s+|,\s+(?=(?:but|while|whereas)\b))/i)
    : content.split(
      /(?:;|\.(?!\d)|\s+[—–]\s+|,\s+(?=(?:but|while|whereas|with)\b)|\s+(?=(?:after|because|due\s+to|in\s+order\s+to|leading\s+to|resulting\s+in|so\s+that|to\s+enable)\b))/i
    ))
    .flatMap((clause) => (!safeBoundaries && hasCoordinatedPlan ? clause.split(/\s+(?=without\b)/i) : [clause]))
    .map((clause) => clause.replace(/\s+/g, ' ').trim())
    .filter((clause) => clause.length >= 8)
    .filter((clause) => !SUBORDINATE_CLAIM_START.test(clause))

  const candidates: ConservativeClauseCandidate[] = []
  for (const clause of clauses) {
    candidates.push({ content: clause, groundingText: clause })
    // A trailing qualifier can govern every planned action or only the last.
    // Keep the authored plan intact on Windows instead of guessing that scope.
    if (safeBoundaries) continue
    for (const branch of plannedActionBranches(clause)) {
      candidates.push({
        content: branch.text,
        groundingText: branch.groundingText,
        plannedContext: clause
      })
    }
  }
  return candidates.filter(
    (candidate, index) =>
      candidates.findIndex(
        (other) =>
          other.content === candidate.content && other.groundingText === candidate.groundingText
      ) === index
  )
}

function linesForCitedRange<T extends WriterGroundingLine>(
  transcriptLines: readonly T[],
  startMs: number,
  endMs: number,
  toleranceMs = CITATION_NEIGHBOR_TOLERANCE_MS,
  lineLimit = CITATION_NEIGHBOR_LINE_LIMIT
): T[] {
  const firstIndex = transcriptLines.findIndex(
    (line) => line.startMs >= startMs && line.startMs <= endMs
  )
  if (firstIndex < 0) return []

  let lastIndex = firstIndex
  while (
    lastIndex + 1 < transcriptLines.length &&
    transcriptLines[lastIndex + 1]!.startMs <= endMs
  ) {
    lastIndex += 1
  }

  let expandedFirstIndex = firstIndex
  for (let count = 0; count < lineLimit && expandedFirstIndex > 0; count += 1) {
    if (
      transcriptLines[expandedFirstIndex]!.startMs -
        transcriptLines[expandedFirstIndex - 1]!.startMs >
      toleranceMs
    ) {
      break
    }
    expandedFirstIndex -= 1
  }

  let expandedLastIndex = lastIndex
  for (
    let count = 0;
    count < lineLimit && expandedLastIndex + 1 < transcriptLines.length;
    count += 1
  ) {
    if (
      transcriptLines[expandedLastIndex + 1]!.startMs - transcriptLines[expandedLastIndex]!.startMs >
      toleranceMs
    ) {
      break
    }
    expandedLastIndex += 1
  }

  return transcriptLines.slice(expandedFirstIndex, expandedLastIndex + 1)
}

function groundedDeadline(deadline: string | null | undefined, evidence: string): string | null {
  const trimmed = deadline?.replace(/\s+/g, ' ').trim()
  if (!trimmed) return null
  if (!areQuantitiesGrounded(trimmed, evidence)) return null

  const tokens = distinctiveTokens(trimmed)
  const evidenceTokens = distinctiveTokens(evidence)
  if (tokens.size === 0) {
    const normalizedDeadline = trimmed
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
    const normalizedEvidence = evidence
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
    return normalizedDeadline && normalizedEvidence.includes(normalizedDeadline) ? trimmed : null
  }
  return [...tokens].every((token) => evidenceTokens.has(token)) ? trimmed : null
}

function decisionObjectTokens(text: string): Set<string> {
  return new Set([...distinctiveTokens(text)].filter((token) => !DECISION_OBJECT_STOP.has(token)))
}

function decisionEvidenceSupportsSummary(
  summary: string,
  evidenceLines: readonly WriterGroundingLine[]
): boolean {
  const summaryObjects = decisionObjectTokens(summary)
  if (summaryObjects.size === 0) return false

  const clauses = evidenceClaimClauses(evidenceLines)
  const directlySupported = clauses.some(({ text: evidenceClause }) => {
    if (!DECISION_EVIDENCE.test(evidenceClause) || DECISION_NEGATION.test(evidenceClause)) {
      return false
    }
    const shared = sharedTokenCount(summaryObjects, decisionObjectTokens(evidenceClause))
    const requiredShared = Math.min(2, summaryObjects.size)
    return shared >= requiredShared && shared / summaryObjects.size >= 0.5
  })
  if (directlySupported) return true

  const supportedByAcceptedProposal = clauses.some((acceptance) => {
    if (!DECISION_ACCEPTANCE.test(acceptance.text) || DECISION_NEGATION.test(acceptance.text)) {
      return false
    }
    return clauses.some((proposal) => {
      if (
        proposal.lineIndex >= acceptance.lineIndex ||
        acceptance.lineIndex - proposal.lineIndex > 2 ||
        !DECISION_PROPOSAL.test(proposal.text) ||
        DECISION_NEGATION.test(proposal.text)
      ) {
        return false
      }
      const shared = sharedTokenCount(summaryObjects, decisionObjectTokens(proposal.text))
      const requiredShared = Math.min(2, summaryObjects.size)
      return shared >= requiredShared && shared / summaryObjects.size >= 0.5
    })
  })
  return supportedByAcceptedProposal
}

function actionBodyGroundingTokens(text: string): Set<string> {
  const tokens = distinctiveTokens(text)
  for (const acronym of text.match(/\b[A-Z][A-Z0-9-]{1,}\b/g) ?? []) {
    tokens.add(acronym.toLowerCase())
  }
  return tokens
}

function explicitPlanSupportsActionBody(
  summary: string,
  evidence: string,
  plannedContext: string = summary
): boolean {
  if (!PLANNED_ACTION_SUMMARY.test(plannedContext) || !EXPLICIT_PLAN_SPEECH.test(evidence)) {
    return false
  }
  const summaryObjects = new Set(
    [...actionBodyGroundingTokens(summary)].filter((token) => !PLAN_TOKEN_STOP.has(token))
  )
  if (summaryObjects.size === 0) return false
  const shared = sharedTokenCount(summaryObjects, actionBodyGroundingTokens(evidence))
  return shared >= Math.min(2, summaryObjects.size)
}

function resolveCategory(
  category: WriterGroundingCategory,
  title: string,
  content: string,
  evidenceLines: readonly WriterGroundingLine[],
  plannedContext?: string
): WriterGroundingCategory | null {
  if (category === 'action_items') {
    if (VERBATIM_INCOMPLETE_END.test(content)) return null
    const evidence = evidenceLines.map((line) => line.text).join(' ')
    if (evidenceLines.some((line) => actionSpeechActSupportsSummary(line.text, content)) ||
      explicitPlanSupportsActionBody(content, evidence, plannedContext)) return category
    if (isWindowsTopicWriterEnabled() && decisionEvidenceSupportsSummary(content, evidenceLines)) return 'decisions'
    return null
  }
  if (category !== 'decisions') return category
  if (decisionEvidenceSupportsSummary(`${title} ${content}`, evidenceLines)) return category
  if (isWindowsTopicWriterEnabled()) {
    // Negative approvals and unresolved choices are useful grounded facts,
    // even when the writer put them in the decision bucket. Never turn a
    // positive invented approval into a fact through this fallback.
    if (/\b(?:not\s+approved|no\s+\w+\s+is\s+approved|undecided|unapproved|postpon(?:e|ed|ing)|defer(?:red|ring)?)\b/iu.test(content)) {
      return /\b(?:undecided|unapproved|not\s+approved)\b/iu.test(content) ? 'discussion' : 'information'
    }
  }
  return DECISION_ASSERTION.test(`${title} ${content}`) ? null : 'information'
}

/**
 * Conservative writer boundary shared across platforms. It never invents
 * replacement prose: when a bundled record is unsafe, it may retain one
 * verbatim grounded clause and discard the rest. macOS calls it with exact
 * line-ID citations; Windows calls it (behind its grounding flag) with the
 * resolved tight-tuple source range.
 */
export function sanitizeWriterRecords(
  category: WriterGroundingCategory,
  draft: WriterGroundingDraft,
  citedRange: { startMs: number; endMs: number },
  transcriptLines: readonly WriterGroundingLine[],
  mode: WriterGroundingMode = 'verbatim'
): GroundedWriterRecord[] {
  return withGroundingCache(() =>
    evaluateWriterRecords(category, draft, citedRange, transcriptLines, mode)
  )
}

function evaluateWriterRecords(
  category: WriterGroundingCategory,
  draft: WriterGroundingDraft,
  citedRange: { startMs: number; endMs: number },
  transcriptLines: readonly WriterGroundingLine[],
  mode: WriterGroundingMode = 'verbatim'
): GroundedWriterRecord[] {
  const title = draft.title?.replace(/\s+/g, ' ').trim() ?? ''
  const content = draft.content?.replace(/\s+/g, ' ').trim() ?? ''
  if (!title || !content || !noteTextLooksCoherent(content)) return []

  const startMs = Math.min(citedRange.startMs, citedRange.endMs)
  const endMs = Math.max(citedRange.startMs, citedRange.endMs)
  const exactCitedLines = transcriptLines.filter(
    (line) => line.startMs >= startMs && line.startMs <= endMs
  )
  if (exactCitedLines.length === 0) return []

  const evaluate = (citedLines: readonly WriterGroundingLine[]): GroundedWriterRecord[] => {
    const allowAcceptedProposal = category === 'decisions'
    const wholeWindow = bestGroundedWindow(content, citedLines, allowAcceptedProposal, mode)
    const candidates: Array<{
      content: string
      window: WriterGroundingLine[]
      salvaged: boolean
      plannedContext?: string
    }> = wholeWindow
      ? [{ content, window: wholeWindow, salvaged: false }]
      : splitConservativeClauses(content)
          .flatMap((clause) => {
            const window = bestGroundedWindow(
              clause.groundingText,
              citedLines,
              allowAcceptedProposal,
              mode
            )
            return window
              ? [
                  {
                    content: clause.content,
                    window,
                    plannedContext: clause.plannedContext
                  }
                ]
              : []
          })
          .map((candidate) => ({ ...candidate, salvaged: true }))

    const recordsForCandidates = (records: typeof candidates): GroundedWriterRecord[] =>
      records
        .flatMap((candidate) => {
          if (isWindowsTopicWriterEnabled() && !hasBalancedClaimGrouping(candidate.content)) return []
          if (candidate.salvaged && VAGUE_PASSIVE_FUTURE.test(candidate.content)) return []
          if (!noteTextLooksCoherent(candidate.content)) return []
          if (isWindowsTopicWriterEnabled() && /\b(?:until|unless|if|after|before|because)\s*$/iu.test(candidate.content)) return []
          if (isWindowsCatalogWriterEnabled() && /^to\s+(?:clarify|improve|avoid|prevent|reduce|ensure|explain)\b/iu.test(candidate.content)) return []
          const evidence = candidate.window.map((line) => line.text).join(' ')
          const selectedTitle =
            !candidate.salvaged && textIsGrounded(title, candidate.window, false, mode)
              ? title
              : candidate.content
          const resolvedCategory = resolveCategory(
            category,
            selectedTitle,
            candidate.content,
            candidate.window,
            candidate.plannedContext
          )
          if (!resolvedCategory) return []

          // Apply only after the original content/category checks succeeded.
          // Use the original explicit citation, not neighboring-line salvage,
          // to avoid borrowing a title's subject from a nearby unrelated task.
          const titleWindow = mode === 'verbatim' && resolvedCategory === 'action_items' && !candidate.salvaged &&
            title !== selectedTitle && candidate.window.every((line) => exactCitedLines.includes(line))
            ? actionTitleWindow(title, candidate.window, exactCitedLines, mode)
            : candidate.window

          return [
            {
              category: resolvedCategory,
              title: selectedTitle,
              content: candidate.content,
              deadline: groundedDeadline(draft.deadline, evidence),
              sourceStartMs: candidate.window[0]!.startMs,
              sourceEndMs: candidate.window[candidate.window.length - 1]!.startMs,
              salvaged: candidate.salvaged,
              ...(titleWindow !== candidate.window ? {
                actionContext: {
                  title,
                  sourceStartMs: titleWindow[0]!.startMs,
                  sourceEndMs: titleWindow[titleWindow.length - 1]!.startMs
                }
              } : {})
            }
          ]
        })
        .slice(0, category === 'action_items' ? 1 : 2)

    const groundedRecords = recordsForCandidates(candidates)
    if (groundedRecords.length > 0) return groundedRecords

    // A paraphrase can be lexically grounded yet still fail the stricter
    // action/decision speech-act check. In that case, preserve a safe cited
    // clause instead of losing the supported source fact altogether.
    const verbatim = bestVerbatimEvidenceCandidate(content, citedLines)
    if (!verbatim || category === 'decisions') return []
    if (category === 'action_items' && actionPredicatesConflict(content, verbatim.content)) {
      return []
    }
    return recordsForCandidates([verbatim])
  }

  const exactRecords = evaluate(exactCitedLines)
  const recordLimit = category === 'action_items' ? 1 : 2
  if (exactRecords.length >= recordLimit) return exactRecords

  // The 4B writer occasionally ends a citation one local line early or late.
  // Supplement a partially grounded multi-clause information record from
  // nearby lines. Paraphrase uses a wider gap (20s / 3 lines) because tight
  // citations are coarse resolved ranges; verbatim/Mac stay at 12s / 2.
  const neighboringLines = linesForCitedRange(
    transcriptLines,
    startMs,
    endMs,
    mode === 'paraphrase' ? PARAPHRASE_NEIGHBOR_TOLERANCE_MS : CITATION_NEIGHBOR_TOLERANCE_MS,
    mode === 'paraphrase' ? PARAPHRASE_NEIGHBOR_LINE_LIMIT : CITATION_NEIGHBOR_LINE_LIMIT
  )
  if (neighboringLines.length === exactCitedLines.length) return exactRecords

  const neighboringRecords = evaluate(neighboringLines)
  const groundedWhole = neighboringRecords.find(
    (record) => !record.salvaged && record.content === content
  )
  if (groundedWhole) return [groundedWhole]

  const combined = [...exactRecords]
  for (const record of neighboringRecords) {
    if (combined.some((candidate) => candidate.content === record.content)) continue
    combined.push(record)
  }
  return combined
    .sort(
      (left, right) =>
        content.indexOf(left.content) - content.indexOf(right.content) ||
        left.sourceStartMs - right.sourceStartMs
    )
    .slice(0, recordLimit)
}

/**
 * Next Steps only: validate the existing writer's complete action against its
 * local evidence. Canonical writer records and their summary ranking are not
 * changed. No prose is generated and no grounding threshold is lowered.
 */
export function refineWriterAction(
  draft: Segment,
  transcript: readonly Transcript[]
): { segment: Segment; commitmentRows: Transcript[]; contextRows: Transcript[] } | null {
  return withGroundingCache(() => evaluateWriterAction(draft, transcript))
}

function evaluateWriterAction(
  draft: Segment,
  transcript: readonly Transcript[]
): { segment: Segment; commitmentRows: Transcript[]; contextRows: Transcript[] } | null {
  if (draft.category !== 'action_item' || !draft.title?.trim() || !draft.content?.trim())
    return null
  if (
    !Number.isFinite(draft.sourceStartMs) ||
    !Number.isFinite(draft.sourceEndMs) ||
    draft.sourceStartMs < 0 ||
    draft.sourceEndMs < draft.sourceStartMs
  )
    return null
  const content = draft.content.trim()
  // A stranded preposition in an embedded question is complete speech; the
  // general fragment detector deliberately does not attempt this grammar.
  const hasStrandedQuestion =
    /\bwhere\s+.{1,80}\b(?:is|are|was|were|[\p{L}]+['’](?:s|re))\s+at[.!?]*$/iu.test(content)
  if (
    !noteTextLooksCoherent(
      hasStrandedQuestion ? content.replace(/\s+at([.!?]*)$/iu, '$1') : content
    )
  )
    return null
  const rows = transcript.filter((row) => row.meetingId === draft.meetingId)
  const nearby = actionEvidenceNeighborhood(rows, draft.sourceStartMs, draft.sourceEndMs)
  const inCitation = (row: Transcript): boolean =>
    row.startMs >= draft.sourceStartMs && row.startMs <= draft.sourceEndMs
  const citedRows = nearby.filter(inCitation)
  if (!citedRows.length) return null
  // ASR may split one continuous sentence into several short rows. Retain the
  // same 30-second limit while allowing six rows, as used by the tight writer.
  const windows = evidenceWindows(nearby, 6).sort((a, b) => a.length - b.length)
  for (const window of windows) {
    // Keep the writer's complete citation. Selecting a tiny overlapping window
    // can omit a qualifier or validate only the generic words of a longer task.
    if (!citedRows.every((row) => window.includes(row))) continue
    const speech = actionEvidenceTurns(window).filter(
      (turn) =>
        turn.rows.some(inCitation) &&
        actionSpeechActSupportsSummary(turn.text, content, undefined, true)
    )
    if (!speech.length) continue
    // Retain single-letter words such as "I" when finding the relevant span;
    // dropping I turns "I will ..." into an apparent "will ...?" question.
    if (!textIsGrounded(content, window, false, 'verbatim', true)) continue
    const title =
      textIsGrounded(draft.title, window) && !actionPredicatesConflict(draft.title, content)
        ? draft.title
        : content
    // Include the bounded neighboring context when linking the task back to
    // speech, so a resolved subject introduced before the commitment is visible.
    const citationWindow =
      windows
        .filter(
          (candidate) =>
            candidate[0].startMs <= window[0].startMs &&
            candidate[candidate.length - 1].startMs >= window[window.length - 1].startMs
        )
        .at(-1) ?? window
    return {
      segment: {
        ...draft,
        title,
        content,
        deadline: groundedDeadline(
          draft.deadline,
          rows
            .filter(inCitation)
            .map((row) => row.text)
            .join(' ')
        ),
        sourceStartMs: citationWindow[0].startMs,
        sourceEndMs: Math.max(...citationWindow.map((row) => row.endMs))
      },
      commitmentRows: speech.flatMap((turn) => turn.rows),
      contextRows: nearby
    }
  }
  return null
}

/** Classifies literal source evidence without rewriting its text. */
export function classifyLiteralWriterEvidence(
  category: WriterGroundingCategory,
  content: string,
  lines: readonly WriterGroundingLine[]
): WriterGroundingCategory {
  // This caller supplies literal source text, not a generated claim. Category
  // selection still needs speech-act support; failure must not rewrite text.
  return resolveCategory(category, content, content, lines) ?? 'information'
}

/**
 * Reports each grounding check independently against the record's best-matching
 * evidence window. Diagnostic only: sanitizeWriterRecords remains the boundary.
 */
export function diagnoseWriterRecord(
  category: WriterGroundingCategory,
  draft: WriterGroundingDraft,
  citedRange: { startMs: number; endMs: number },
  transcriptLines: readonly WriterGroundingLine[],
  windowShape: { maxLines: number; maxSpanMs: number } = { maxLines: 3, maxSpanMs: 30_000 }
): {
  citedLineCount: number
  bestWindow: string[]
  checks: Record<string, boolean>
  resolvedCategory: WriterGroundingCategory | null
} | null {
  const title = draft.title?.replace(/\s+/g, ' ').trim() ?? ''
  const content = draft.content?.replace(/\s+/g, ' ').trim() ?? ''
  const startMs = Math.min(citedRange.startMs, citedRange.endMs)
  const endMs = Math.max(citedRange.startMs, citedRange.endMs)
  const citedLines = linesForCitedRange(transcriptLines, startMs, endMs)
  if (!title || !content || citedLines.length === 0) return null

  const summaryTokens = distinctiveTokens(content)
  const windows = evidenceWindows(citedLines, windowShape.maxLines, windowShape.maxSpanMs)
  const scored = windows
    .map((window) => ({
      window,
      shared: sharedTokenCount(
        summaryTokens,
        distinctiveTokens(window.map((line) => line.text).join(' '))
      )
    }))
    .sort((left, right) => right.shared - left.shared)
  const best = scored[0]?.window ?? citedLines
  const evidence = best.map((line) => line.text).join(' ')
  const shared = scored[0]?.shared ?? 0
  const lexicalShared = shared + releaseLifecycleLexicalBonus(content, evidence, shared)

  return {
    citedLineCount: citedLines.length,
    bestWindow: best.map((line) => line.text),
    checks: {
      coherent: noteTextLooksCoherent(content),
      alternatives: explicitAlternativesAreGrounded(content, best),
      completion: completionClaimsAreGrounded(content, best),
      polarity: assertionPolarityIsGrounded(content, best),
      quantities: areQuantitiesGrounded(content, evidence),
      quantityBinding: quantitiesBindToTheirMetrics(content, best),
      directionBinding: directionsBindToTheirMetrics(content, best),
      platformTerms: platformTermsAreGrounded(content, evidence),
      platformClaims: platformClaimsAreGrounded(content, best),
      uppercaseEntities: uppercaseEntitiesAreGrounded(content, evidence),
      capitalizedEntities: capitalizedEntitiesAreGrounded(content, evidence),
      purposeTails: purposeTailsAreGrounded(content, evidence),
      relationships: relationshipMarkersAreGrounded(content, best),
      coordinatedPlans: coordinatedPlanActionsAreGrounded(content, best),
      lexicalAnchor:
        extractQuantityMentions(content).length > 0 ||
        (summaryTokens.size <= 3
          ? lexicalShared >= 1
          : lexicalShared >= 2 && (lexicalShared / summaryTokens.size >= 0.2 || lexicalShared >= 4))
    },
    resolvedCategory: resolveCategory(category, title, content, best)
  }
}

/** Convenience for focused callers; production parsing keeps up to two grounded clauses. */
export function sanitizeWriterRecord(
  category: WriterGroundingCategory,
  draft: WriterGroundingDraft,
  citedRange: { startMs: number; endMs: number },
  transcriptLines: readonly WriterGroundingLine[],
  mode: WriterGroundingMode = 'verbatim'
): GroundedWriterRecord | null {
  return sanitizeWriterRecords(category, draft, citedRange, transcriptLines, mode)[0] ?? null
}
