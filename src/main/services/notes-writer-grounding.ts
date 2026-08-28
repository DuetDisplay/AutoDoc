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

export interface GroundedMacWriterRecord {
  category: WriterGroundingCategory
  title: string
  content: string
  deadline: string | null
  sourceStartMs: number
  sourceEndMs: number
  salvaged: boolean
}

const MAX_EVIDENCE_SPAN_MS = 30_000
const CITATION_NEIGHBOR_TOLERANCE_MS = 12_000
const CITATION_NEIGHBOR_LINE_LIMIT = 2

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

function distinctiveTokens(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? [])
      .map(normalizeToken)
      .filter((token) => token.length >= 4 && !WORD_STOP.has(token))
  )
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
  return text
    .split(CLAIM_SPLIT)
    .flatMap((clause) => {
      const claims: string[] = []
      let claimStart = 0
      ASSOCIATED_CLAIM_BOUNDARY.lastIndex = 0
      for (const match of clause.matchAll(ASSOCIATED_CLAIM_BOUNDARY)) {
        const boundaryIndex = match.index ?? 0
        const fragment = clause.slice(claimStart, boundaryIndex)
        const remainder = clause.slice(boundaryIndex + match[0].length)
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
  return ASSERTION_NEGATION.test(withoutConversationalResponses)
}

function hasNonAssertiveModality(text: string): boolean {
  let comparable = text
  if (DECISION_EVIDENCE.test(comparable)) {
    comparable = comparable.replace(/\b(?:can|could|should|would)\b/gi, ' ')
  }
  return NON_ASSERTIVE_MODALITY.test(comparable) || LEADING_QUESTION.test(comparable.trim())
}

function relevantEvidenceSpan(summaryClause: string, evidenceClause: string): string {
  const summaryTokens = distinctiveTokens(summaryClause)
  const words = [...evidenceClause.matchAll(/[a-z][a-z'-]+/gi)]
  const sharedWordIndexes = words
    .map((match, index) => (summaryTokens.has(normalizeToken(match[0])) ? index : -1))
    .filter((index) => index >= 0)
  if (sharedWordIndexes.length === 0) return evidenceClause

  // Keep enough leading context to retain question/tentative markers such as
  // "do you think" while still excluding unrelated clauses in long ASR rows.
  const first = Math.max(0, Math.min(...sharedWordIndexes) - 8)
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
  evidenceLines: readonly WriterGroundingLine[]
): boolean {
  const evidenceClauses = evidenceClaimClauses(evidenceLines)

  return splitClaimClauses(summary).every((summaryClause) => {
    const summaryTokens = distinctiveTokens(summaryClause)
    if (summaryTokens.size === 0) return true

    const scored = evidenceClauses.map(({ text }) => {
      const relevantText = relevantEvidenceSpan(summaryClause, text)
      return {
        text: relevantText,
        shared: sharedTokenCount(summaryTokens, distinctiveTokens(relevantText))
      }
    })
    const bestShared = Math.max(0, ...scored.map((candidate) => candidate.shared))
    if (bestShared === 0) return true

    const summaryNegated = hasExplicitNegation(summaryClause)
    const summaryNonAssertive = hasNonAssertiveModality(summaryClause)
    return scored.some(
      (candidate) =>
        candidate.shared === bestShared &&
        hasExplicitNegation(candidate.text) === summaryNegated &&
        (summaryNonAssertive || !hasNonAssertiveModality(candidate.text))
    )
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
  evidenceLines: readonly WriterGroundingLine[]
): boolean {
  const evidenceClauses = evidenceClaimClauses(evidenceLines)

  return splitClaimClauses(summary).every((summaryClause) => {
    const alternatives = summaryClause
      .split(/\bor\b/i)
      .map((alternative) => alternative.trim())
      .filter(Boolean)
    if (alternatives.length < 2) return true

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
  return new Set(
    (text.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? [])
      .map(normalizeToken)
      .filter((token) => token.length >= 2 && !COMPLETION_SUBJECT_STOP.has(token))
  )
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

function platformTermsAreGrounded(summary: string, evidence: string): boolean {
  const normalizedSummary = summary.toLowerCase()
  const normalizedEvidence = evidence.toLowerCase()
  return PLATFORM_TERMS.every(
    (term) =>
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

function textIsGrounded(
  summary: string,
  evidenceLines: readonly WriterGroundingLine[],
  allowAcceptedProposal = false
): boolean {
  const trimmed = summary.replace(/\s+/g, ' ').trim()
  if (!trimmed || evidenceLines.length === 0) return false
  if (hasMixedScriptToken(trimmed)) return false
  const evidence = evidenceLines.map((line) => line.text).join(' ')
  if (!explicitAlternativesAreGrounded(trimmed, evidenceLines)) return false
  if (!completionClaimsAreGrounded(trimmed, evidenceLines)) return false
  if (
    !assertionPolarityIsGrounded(trimmed, evidenceLines) &&
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

function evidenceWindows(lines: readonly WriterGroundingLine[]): WriterGroundingLine[][] {
  const windows: WriterGroundingLine[][] = []
  for (let start = 0; start < lines.length; start += 1) {
    for (let end = start; end < lines.length; end += 1) {
      if (end - start >= 3) break
      if (lines[end]!.startMs - lines[start]!.startMs > MAX_EVIDENCE_SPAN_MS) break
      windows.push(lines.slice(start, end + 1))
    }
  }
  return windows
}

function bestGroundedWindow(
  text: string,
  lines: readonly WriterGroundingLine[],
  allowAcceptedProposal = false
): WriterGroundingLine[] | null {
  const summaryTokens = distinctiveTokens(text)
  const candidates = evidenceWindows(lines)
    .filter((window) => textIsGrounded(text, window, allowAcceptedProposal))
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
  const hasCoordinatedPlan = plannedActionBranches(content).length > 0
  const clauses = content
    .split(
      /(?:;|\.(?!\d)|\s+[—–]\s+|,\s+(?=(?:but|while|whereas|with)\b)|\s+(?=(?:after|because|due\s+to|in\s+order\s+to|leading\s+to|resulting\s+in|so\s+that|to\s+enable)\b))/i
    )
    .flatMap((clause) => (hasCoordinatedPlan ? clause.split(/\s+(?=without\b)/i) : [clause]))
    .map((clause) => clause.replace(/\s+/g, ' ').trim())
    .filter((clause) => clause.length >= 8)
    .filter((clause) => !SUBORDINATE_CLAIM_START.test(clause))

  const candidates: ConservativeClauseCandidate[] = []
  for (const clause of clauses) {
    candidates.push({ content: clause, groundingText: clause })
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

function linesForCitedRange(
  transcriptLines: readonly WriterGroundingLine[],
  startMs: number,
  endMs: number
): WriterGroundingLine[] {
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
  for (let count = 0; count < CITATION_NEIGHBOR_LINE_LIMIT && expandedFirstIndex > 0; count += 1) {
    if (
      transcriptLines[expandedFirstIndex]!.startMs -
        transcriptLines[expandedFirstIndex - 1]!.startMs >
      CITATION_NEIGHBOR_TOLERANCE_MS
    ) {
      break
    }
    expandedFirstIndex -= 1
  }

  let expandedLastIndex = lastIndex
  for (
    let count = 0;
    count < CITATION_NEIGHBOR_LINE_LIMIT && expandedLastIndex + 1 < transcriptLines.length;
    count += 1
  ) {
    if (
      transcriptLines[expandedLastIndex + 1]!.startMs -
        transcriptLines[expandedLastIndex]!.startMs >
      CITATION_NEIGHBOR_TOLERANCE_MS
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
    return evidenceLines.some((line) => actionSpeechActSupportsSummary(line.text, content)) ||
      explicitPlanSupportsActionBody(content, evidence, plannedContext)
      ? category
      : null
  }
  if (category !== 'decisions') return category
  if (decisionEvidenceSupportsSummary(`${title} ${content}`, evidenceLines)) return category
  return DECISION_ASSERTION.test(`${title} ${content}`) ? null : 'information'
}

/**
 * Conservative macOS writer boundary. It never invents replacement prose: when
 * a bundled record is unsafe, it may retain one verbatim grounded clause and
 * discard the rest. Windows does not call this function.
 */
export function sanitizeMacWriterRecords(
  category: WriterGroundingCategory,
  draft: WriterGroundingDraft,
  citedRange: { startMs: number; endMs: number },
  transcriptLines: readonly WriterGroundingLine[]
): GroundedMacWriterRecord[] {
  const title = draft.title?.replace(/\s+/g, ' ').trim() ?? ''
  const content = draft.content?.replace(/\s+/g, ' ').trim() ?? ''
  if (!title || !content || !noteTextLooksCoherent(content)) return []

  const startMs = Math.min(citedRange.startMs, citedRange.endMs)
  const endMs = Math.max(citedRange.startMs, citedRange.endMs)
  const exactCitedLines = transcriptLines.filter(
    (line) => line.startMs >= startMs && line.startMs <= endMs
  )
  if (exactCitedLines.length === 0) return []

  const evaluate = (citedLines: readonly WriterGroundingLine[]): GroundedMacWriterRecord[] => {
    const allowAcceptedProposal = category === 'decisions'
    const wholeWindow = bestGroundedWindow(content, citedLines, allowAcceptedProposal)
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
              allowAcceptedProposal
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

    const recordsForCandidates = (records: typeof candidates): GroundedMacWriterRecord[] =>
      records
        .flatMap((candidate) => {
          if (candidate.salvaged && VAGUE_PASSIVE_FUTURE.test(candidate.content)) return []
          if (!noteTextLooksCoherent(candidate.content)) return []
          const evidence = candidate.window.map((line) => line.text).join(' ')
          const selectedTitle =
            !candidate.salvaged && textIsGrounded(title, candidate.window)
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

          return [
            {
              category: resolvedCategory,
              title: selectedTitle,
              content: candidate.content,
              deadline: groundedDeadline(draft.deadline, evidence),
              sourceStartMs: candidate.window[0]!.startMs,
              sourceEndMs: candidate.window[candidate.window.length - 1]!.startMs,
              salvaged: candidate.salvaged
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
  // Supplement a partially grounded multi-clause information record from at
  // most two nearby lines. Action records never borrow a second candidate.
  // All grounding, binding, and 30-second checks still apply afterward.
  const neighboringLines = linesForCitedRange(transcriptLines, startMs, endMs)
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

/** Convenience for focused callers; production parsing keeps up to two grounded clauses. */
export function sanitizeMacWriterRecord(
  category: WriterGroundingCategory,
  draft: WriterGroundingDraft,
  citedRange: { startMs: number; endMs: number },
  transcriptLines: readonly WriterGroundingLine[]
): GroundedMacWriterRecord | null {
  return sanitizeMacWriterRecords(category, draft, citedRange, transcriptLines)[0] ?? null
}
