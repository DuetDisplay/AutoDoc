import { createHash } from 'node:crypto'
import type { MeetingSegments, Segment, Transcript } from '../../shared/types'
import { actionPredicatesOverlap, actionSpeechActSupportsSummary } from './notes-action-speech'
import { noteTextLooksCoherent } from './notes-coherence'
import { resolveSpeakerAwareOwner } from './notes-owner-attribution'
import { isPlausiblePersonOwner } from './notes-scan-markdown'

export interface RecoverExplicitTranscriptActionsOptions {
  /** The trusted label for transcript rows whose speaker is `[me]`. */
  localOwnerLabel?: string
}

export interface ExplicitTranscriptActionRecoveryResult {
  segments: MeetingSegments
  recoveredActionCount: number
  promotedActionCount: number
  dedupedRecoveredActionCount: number
}

type CandidateKind =
  | 'local-commitment'
  | 'unassigned-commitment'
  | 'unassigned-request'
  | 'named-assignment'
  | 'named-request'

interface ActionCandidate {
  kind: CandidateKind
  row: Transcript
  actionText: string
  provisionalOwner: string | null
  primaryAction: string
  objectTokens: Set<string>
}

interface ScopedContextualRequest {
  priorRow: Transcript
  requestRow: Transcript
  actionText: string
  title: string
  objectTokens: Set<string>
}

const LOCAL_COMMITMENT =
  /\bi(?:['’]ll|\s+will|\s+need\s+to|\s+have\s+to|\s+plan\s+to|\s+commit\s+to|\s+promise\s+to|(?:['’]m|\s+am)\s+(?:going\s+to|gonna(?:\s+to)?))\s+(?<action>.+)$/iu

const LET_ME_COMMITMENT = /\blet\s+me\s+(?!know\b)(?<action>.+)$/iu

const COLLECTIVE_COMMITMENT =
  /\bwe(?:['’]ll|\s+will|\s+need\s+to|\s+have\s+to|\s+plan\s+to|(?:['’]re|\s+are)\s+(?:going\s+to|gonna(?:\s+to)?|planning\s+to))\s+(?<action>.+)$/iu

const EMBEDDED_COMMITMENT_MARKER =
  /\b(?<subject>i|we)(?:['’]ll|\s+will|\s+need\s+to|\s+have\s+to|\s+plan\s+to|(?:['’]m|\s+am|['’]re|\s+are)\s+(?:going\s+to|gonna(?:\s+to)?|planning\s+(?:to|on)))\s+/giu
const EMBEDDED_ACTION_BOUNDARY =
  /(?:,\s*|\s+)(?:and\s+then|but\s+(?:then|what)|no\s+hurt\s+feelings|you\s+know)\b/iu

const DIRECT_REQUEST =
  /^(?:(?:please|Please)\s+|(?:(?:can|Can)|(?:could|Could)|(?:would|Would)|(?:will|Will))\s+you\s+)(?<action>.+)$/u

const NAMED_ASSIGNMENT =
  /\b(?<owner>[A-Z][a-z]{1,}(?:\s+[A-Z][a-z]{1,})?)\s+(?:will|must|needs?\s+to|is\s+(?:going\s+to|gonna(?:\s+to)?)|agreed\s+to|committed\s+to|plans?\s+to)\s+(?<action>.+)$/u

const NAMED_REQUEST =
  /\b(?<owner>[A-Z][a-z]{1,}(?:\s+[A-Z][a-z]{1,})?)\s*[,;:—-]\s*(?:(?:please|Please)\s+|(?:(?:can|Can)|(?:could|Could)|(?:will|Will))\s+you\s+)(?<action>.+)$/u

const ACTION_NEGATION =
  /\b(?:not|never|cannot|can't|won't|wouldn't|couldn't|shouldn't|don't|doesn't|didn't|do\s+not|does\s+not|did\s+not|will\s+not|would\s+not|could\s+not|should\s+not|no\s+need\s+to)\b/iu

const TENTATIVE_OR_CONDITIONAL =
  /\b(?:maybe|might|probably|possibly|perhaps|ideally|hopefully|i\s+think|i\s+guess|i\s+hope|i\s+expect|don['’]t\s+think|do\s+you\s+think|not\s+sure|if|unless|whether|depending\s+on|(?:he|she|they)\s+said)\b/iu

const REPORTED_SPEECH_PREFIX =
  /\b(?:according\s+to|(?:[\p{L}'’-]+\s+){0,2}(?:said|says|told|mentioned|wrote|asked|replied|promised))\b/iu

const COLLECTIVE_OWNER_TOKENS = new Set([
  'board',
  'company',
  'customer',
  'department',
  'design',
  'engineering',
  'everyone',
  'finance',
  'group',
  'leadership',
  'legal',
  'management',
  'marketing',
  'operations',
  'ops',
  'product',
  'qa',
  'sales',
  'security',
  'support',
  'team',
  'vendor'
])

const ORGANIZATION_NAME_MARKERS = new Set([
  'app',
  'application',
  'bot',
  'company',
  'corp',
  'corporation',
  'department',
  'division',
  'group',
  'inc',
  'labs',
  'llc',
  'platform',
  'service',
  'services',
  'software',
  'studio',
  'system',
  'systems',
  'team',
  'technologies',
  'technology',
  'tool',
  'workspace'
])

const GENERIC_ACTION_HEAD_STOPWORDS = new Set([
  'am',
  'are',
  'be',
  'been',
  'being',
  'can',
  'could',
  'did',
  'does',
  'done',
  'go',
  'going',
  'got',
  'had',
  'has',
  'have',
  'hope',
  'is',
  'just',
  'may',
  'might',
  'must',
  'need',
  'plan',
  'should',
  'think',
  'try',
  'want',
  'will',
  'would'
])

const ACTION_LEADING_MODIFIERS = new Set(['definitely', 'just', 'really', 'uh', 'um'])
const ACTION_LEADING_FILLERS =
  /^(?:(?:also|always|definitely|just|like|oh|okay|really|uh+|um+|well|yeah)\b[,\s]*|go\s+ahead\s+and\s+)+/iu

const ACTION_FAMILIES: ReadonlyArray<{ canonical: string; pattern: RegExp }> = [
  { canonical: 'add', pattern: /^(?:add|include|put|extend)$/iu },
  {
    canonical: 'approve',
    pattern:
      /^(?:approve|approves|approved|approving|authorize|authorizes|authorized|authorizing|give|gives|gave|given|giving|grant|grants|granted|granting|provide|provides|provided|providing)$/iu
  },
  { canonical: 'contact', pattern: /^(?:ask|contact|follow|ping|remind)$/iu },
  { canonical: 'call', pattern: /^(?:call|calls|called|calling)$/iu },
  { canonical: 'check', pattern: /^(?:check|review|verify)$/iu },
  { canonical: 'create', pattern: /^(?:build|create|draft|make|prepare)$/iu },
  { canonical: 'deploy', pattern: /^(?:deploy|deploys|deployed|deploying)$/iu },
  {
    canonical: 'document',
    pattern: /^(?:document|documents|documented|documenting)$/iu
  },
  { canonical: 'email', pattern: /^(?:email|emails|emailed|emailing)$/iu },
  { canonical: 'monitor', pattern: /^(?:monitor|monitors|monitored|monitoring)$/iu },
  { canonical: 'notify', pattern: /^(?:notify|notifies|notified|notifying)$/iu },
  { canonical: 'remove', pattern: /^(?:remove|removes|removed|removing)$/iu },
  {
    canonical: 'schedule',
    pattern: /^(?:schedule|schedules|scheduled|scheduling)$/iu
  },
  { canonical: 'send', pattern: /^(?:distribute|send|share)$/iu },
  { canonical: 'release', pattern: /^(?:release|rollout|ship)$/iu },
  { canonical: 'update', pattern: /^(?:change|update)$/iu },
  { canonical: 'fix', pattern: /^(?:fix|resolve)$/iu },
  { canonical: 'handle', pattern: /^(?:handle|own)$/iu },
  { canonical: 'implement', pattern: /^implement$/iu },
  { canonical: 'investigate', pattern: /^investigate$/iu },
  { canonical: 'submit', pattern: /^submit$/iu },
  { canonical: 'start', pattern: /^(?:begin|start)$/iu },
  { canonical: 'test', pattern: /^test$/iu },
  { canonical: 'watch', pattern: /^watch$/iu },
  { canonical: 'write', pattern: /^(?:write|writes|wrote|written|writing)$/iu }
]

const OBJECT_STOPWORDS = new Set([
  'ago',
  'all',
  'after',
  'again',
  'and',
  'about',
  'answer',
  'any',
  'before',
  'back',
  'because',
  'bit',
  'done',
  'for',
  'from',
  'guy',
  'guys',
  'have',
  'her',
  'him',
  'later',
  'me',
  'into',
  'it',
  'just',
  'meeting',
  'more',
  'much',
  'nice',
  'one',
  'ones',
  'option',
  'options',
  'our',
  'once',
  'people',
  'please',
  'same',
  'right',
  'something',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'they',
  'those',
  'this',
  'through',
  'today',
  'tomorrow',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'up',
  'update',
  'updated',
  'updates',
  'us',
  'very',
  'when',
  'where',
  'what',
  'which',
  'while',
  'with',
  'you',
  'your'
])

const INCOMPLETE_TRAILING_FRAGMENT =
  /\b(?:and|as|because|but|for|he|her|him|if|it|of|or|she|that|the|their|them|they|this|to|we|when|whenever|with|you)\s*$/iu

const PURPOSE_OR_RESULT_DETAIL = /\b(?:just\s+to|in\s+order\s+to|so\s+that|to\s+find\s+out)\b/iu
const TEMPORAL_DETAIL = /\b(?:after|before|by|once|today|tomorrow|when)\b/iu
const REPEATED_ADJACENT_WORD = /\b([\p{L}]{2,})\s+\1\b/iu
const BROKEN_MIXED_ALPHANUMERIC =
  /\b(?=[\p{L}\p{N}]*\p{L})(?=[\p{L}\p{N}]*\p{N})[\p{L}\p{N}]{5,}\b/gu

const NON_DELIVERABLE_ACTION_HEAD = /^(?:hear|know|let|repeat|say|see|tell|understand)\b/iu
const UNRESOLVED_INTERROGATIVE_ACTION =
  /^(?:check|determine|review|verify)\s+(?:how|what|who|why)\b/iu
const DEICTIC_LOOK_ACTION = /^(?:look|take\s+(?:a\s+)?look)\s+(?:at\s+)?(?:it|that|this)\b/iu
const MALFORMED_DO_ACTION = /^do\s+(?:is|like)\b/iu
const RUN_ON_BACKCHANNEL =
  /\b(?:does\s+it\s+does\s+it|okay\s+all\s+right|thank\s+thank|thank\s+you\s+very\s+much)\b/iu
const BROKEN_PREPOSITION_SEQUENCE =
  /\b(?:into\s+to|with\s+on|at\s+at|by\s+by|for\s+for|from\s+from|in\s+in|of\s+of|on\s+on|to\s+to|with\s+with)\b/iu
const BROKEN_DETAIL_PHRASE = /\bof\s+more\s+detail\b/iu
const DEICTIC_WORKING_CHECK =
  /^(?:(?:double[- ]?)?check(?:\s+and)?|make\s+sure)\b[\s\S]*\b(?:it|that|this|everything)\b[\s\S]*\bworking\s*$/iu
const DEICTIC_DO_ACTION = /^do\s+(?:it|that|this)\b/iu
const UNSCOPED_SOCIAL_ACTION =
  /^(?:catch\s+up|meet|speak|talk)(?:\s+(?:to|with))?(?:\s+(?:him|her|me|them|us|you))?(?:\s+(?:again|later|today|tomorrow))?(?:\s+(?:and|at|during|in)\s+(?:stand\s*up|the\s+meeting))?\s*$/iu
const DEICTIC_SOCIAL_ACTION =
  /^(?:catch\s+up|speak|talk)\s+(?:to|with)\s+(?:him|her|them|you)\s+about\s+(?:it|that|this)\b/iu
/** "I'll take a look" with no object commits to nothing a reader can act on. */
const OBJECTLESS_LOOK_ACTION = /^(?:take\s+(?:a\s+)?look|have\s+a\s+look|look)\s*$/iu
/** Conversational status promises carry no deliverable. */
const SOCIAL_STATUS_PROMISE =
  /^keep\s+(?:each\s+other|everyone|him|her|me|them|us|you)\s+(?:posted|updated|in\s+the\s+loop)\b/iu
/** Presentational speech ("here's ...") introduces content, it does not commit to work. */
const PRESENTATIONAL_ACTION_HEAD = /^here(?:'s|\s+is)\b/iu

const SCOPED_PRONOUN_REQUEST =
  /\b(?:just\s+)?make\s+sure\s+(?:that\s+)?(?:you\s+)?(?:do|apply|handle)\s+(?:it|that)\s+for\s+(?<scope>both\s+.+)$/iu
const PRIOR_APPROVAL_ACTION =
  /\b(?:give|grant|provide)\s+(?:[\p{L}'’-]+\s+){0,3}(?<object>approval|access|permission|authorization)\b/iu
const PRIOR_WAIT_FOR_REACH_OUT = /\bwait\b[\s\S]*\b(?:them|they)\s+reach(?:ing)?\s+out\b/iu
const CONTEXTUAL_REQUEST_MAX_GAP_MS = 15_000

const PROMOTABLE_BUCKETS = ['information', 'discussion', 'statusUpdates'] as const

function splitClauses(text: string): string[] {
  return text
    .split(/[.!?;\n]+/u)
    .map((clause) => clause.trim())
    .filter(Boolean)
}

function normalizedWords(text: string): string[] {
  return (text.match(/[\p{L}\p{N}]+/gu) ?? []).map((word) => word.toLocaleLowerCase())
}

function actionFamilyForWord(word: string): string | null {
  return ACTION_FAMILIES.find((family) => family.pattern.test(word))?.canonical ?? null
}

function genericActionKey(word: string): string | null {
  const normalized = word.toLocaleLowerCase()
  if (
    !/^\p{L}[\p{L}'’-]{1,}$/u.test(normalized) ||
    GENERIC_ACTION_HEAD_STOPWORDS.has(normalized) ||
    /^(?:he|her|him|i|it|me|she|that|them|they|this|us|we|you)$/iu.test(normalized)
  ) {
    return null
  }
  return `lexical:${normalized}`
}

function primaryActionFamily(actionText: string): string | null {
  const words = normalizedWords(actionText)
    .filter((word) => !ACTION_LEADING_MODIFIERS.has(word))
    .slice(0, 3)
  if (words.length === 0) return null
  return actionFamilyForWord(words[0]) ?? genericActionKey(words[0])
}

function actionObjectTokens(
  actionText: string,
  owner?: string | null,
  excludedAction?: string | null
): Set<string> {
  const excludedOwnerTokens = new Set(normalizedWords(owner ?? ''))
  const excludedLexicalAction = excludedAction?.startsWith('lexical:')
    ? excludedAction.slice('lexical:'.length)
    : null
  const rawWords = actionText.match(/[\p{L}\p{N}]+/gu) ?? []
  return new Set(
    rawWords
      .filter((word) => word.length >= 3 || /^[A-Z0-9]{2,}$/u.test(word))
      .map((word) => word.toLocaleLowerCase())
      .filter(
        (word) =>
          !excludedOwnerTokens.has(word) &&
          !OBJECT_STOPWORDS.has(word) &&
          word !== excludedLexicalAction &&
          actionFamilyForWord(word) === null
      )
  )
}

function namedObjectTokens(
  actionText: string,
  owner?: string | null,
  excludedAction?: string | null
): Set<string> {
  const excludedOwnerTokens = new Set(normalizedWords(owner ?? ''))
  const excludedLexicalAction = excludedAction?.startsWith('lexical:')
    ? excludedAction.slice('lexical:'.length)
    : null
  return new Set(
    (actionText.match(/\p{Lu}\p{Ll}{1,}/gu) ?? [])
      .map((word) => word.toLocaleLowerCase())
      .filter(
        (word) =>
          !excludedOwnerTokens.has(word) &&
          word !== excludedLexicalAction &&
          actionFamilyForWord(word) === null
      )
  )
}

function hasConflictingNamedObjects(
  candidate: ActionCandidate,
  summary: string,
  excludedOwner?: string
): boolean {
  const candidateNames = namedObjectTokens(
    candidate.actionText,
    candidate.provisionalOwner,
    candidate.primaryAction
  )
  const summaryNames = namedObjectTokens(summary, excludedOwner, candidate.primaryAction)
  return (
    candidateNames.size > 0 &&
    summaryNames.size > 0 &&
    ![...candidateNames].some((name) => summaryNames.has(name))
  )
}

function regexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function ownerHasOrganizationContext(
  owner: string,
  meetingId: string,
  transcriptRows: readonly Transcript[]
): boolean {
  const ownerTokens = normalizedWords(owner)
  if (
    ownerTokens.some(
      (token) => COLLECTIVE_OWNER_TOKENS.has(token) || ORGANIZATION_NAME_MARKERS.has(token)
    )
  ) {
    return true
  }

  const literal = regexLiteral(owner)
  const beforeOwner = new RegExp(
    `\\b(?:in|inside|into|on|through|using|via|within)\\s+(?:the\\s+)?${literal}\\b`,
    'iu'
  )
  const afterOwner = new RegExp(
    `\\b${literal}\\s+(?:app|application|bot|company|department|division|group|integration|platform|service|software|system|team|tool|workspace)\\b`,
    'iu'
  )
  return transcriptRows.some(
    (row) =>
      row.meetingId === meetingId && (beforeOwner.test(row.text) || afterOwner.test(row.text))
  )
}

function ownerHasHumanContext(
  owner: string,
  meetingId: string,
  transcriptRows: readonly Transcript[]
): boolean {
  const literal = regexLiteral(owner)
  const personInteraction = new RegExp(
    `\\b(?:ask|asked|call|called|contact|contacted|email|emailed|message|messaged|ping|pinged|remind|reminded|tell|told|thank|thanked)\\s+${literal}\\b`,
    'iu'
  )
  const speechAttribution = new RegExp(
    `\\b${literal}\\s+(?:asked|replied|said|says|told|wrote)\\b`,
    'iu'
  )
  const possessive = new RegExp(`\\b${literal}['’]s\\b`, 'iu')
  const directAddress = new RegExp(
    `(?:^|[.!?]\\s+)${literal}\\s*[,;:—-]\\s*(?:please\\b|can\\s+you\\b|could\\s+you\\b|will\\s+you\\b)`,
    'iu'
  )
  return transcriptRows.some(
    (row) =>
      row.meetingId === meetingId &&
      (personInteraction.test(row.text) ||
        speechAttribution.test(row.text) ||
        possessive.test(row.text) ||
        directAddress.test(row.text))
  )
}

function isPlausibleExplicitOwner(
  owner: string,
  kind: Extract<CandidateKind, 'named-assignment' | 'named-request'>,
  row: Transcript,
  transcriptRows: readonly Transcript[],
  existingOwnerLabels: ReadonlySet<string>
): boolean {
  if (
    !isPlausiblePersonOwner(owner) ||
    ownerHasOrganizationContext(owner, row.meetingId, transcriptRows)
  ) {
    return false
  }

  const tokens = owner.trim().split(/\s+/u)
  // A direct-address request is itself person context. A third-person single
  // token is ambiguous (person, product, department), so require independent
  // human usage elsewhere in the same meeting before assigning it as a person.
  return (
    kind === 'named-request' ||
    tokens.length > 1 ||
    existingOwnerLabels.has(owner.toLocaleLowerCase()) ||
    ownerHasHumanContext(owner, row.meetingId, transcriptRows)
  )
}

function matchingTail(
  clause: string,
  pattern: RegExp
): { actionText: string; prefix: string; owner?: string } | null {
  pattern.lastIndex = 0
  let match = pattern.exec(clause)
  let actionText = match?.groups?.action?.trim() ?? ''
  if (!match || !actionText) return null
  let prefix = clause.slice(0, match.index)

  // ASR commonly repeats a commitment after a filler: "I'll uh, I'll send".
  // Keep the last complete speech act rather than treating the nested prefix
  // as part of the action itself.
  for (let depth = 0; depth < 2; depth += 1) {
    pattern.lastIndex = 0
    const nested = pattern.exec(actionText)
    const nestedAction = nested?.groups?.action?.trim() ?? ''
    if (!nested || !nestedAction) break
    prefix += ` ${actionText.slice(0, nested.index)}`
    match = nested
    actionText = nestedAction
  }
  return {
    actionText,
    prefix,
    owner: match.groups?.owner?.trim()
  }
}

function embeddedCommitmentMatches(
  clause: string
): Array<{ subject: 'i' | 'we'; actionText: string; prefix: string }> {
  const matches = [...clause.matchAll(EMBEDDED_COMMITMENT_MARKER)]
  if (matches.length < 2) return []

  return matches.flatMap((match, index) => {
    const start = (match.index ?? 0) + match[0].length
    const end = matches[index + 1]?.index ?? clause.length
    let actionText = clause
      .slice(start, end)
      .replace(/^(?:uh+|um+|yeah|okay)[,\s]+/iu, '')
      .trim()
    const boundary = actionText.search(EMBEDDED_ACTION_BOUNDARY)
    if (boundary >= 0) actionText = actionText.slice(0, boundary).trim()
    if (!actionText) return []
    return [
      {
        subject: match.groups?.subject?.toLocaleLowerCase() === 'we' ? 'we' : 'i',
        actionText,
        prefix: clause.slice(Math.max(0, (match.index ?? 0) - 64), match.index)
      }
    ]
  })
}

function actionCore(actionText: string): string {
  const purposeStart = actionText.search(/\b(?:just\s+to|in\s+order\s+to|so\s+that|because)\b/iu)
  return (purposeStart >= 0 ? actionText.slice(0, purposeStart) : actionText).trim()
}

function cleanActionText(actionText: string): string {
  return actionText
    .replace(ACTION_LEADING_FILLERS, '')
    .replace(/\b(?:uh+|um+)\b[,\s]*/giu, ' ')
    .replace(/\s+/gu, ' ')
    .replace(/\b([\p{L}]{2,})(?:\s+\1)+\b/giu, '$1')
    .trim()
}

function candidateFromMatch(
  kind: CandidateKind,
  row: Transcript,
  match: { actionText: string; prefix: string; owner?: string },
  provisionalOwner: string | null
): ActionCandidate | null {
  const cleanedActionText = cleanActionText(match.actionText)
  const core = actionCore(cleanedActionText)
  if (
    !cleanedActionText ||
    !noteTextLooksCoherent(cleanedActionText) ||
    ACTION_NEGATION.test(core) ||
    REPORTED_SPEECH_PREFIX.test(match.prefix) ||
    TENTATIVE_OR_CONDITIONAL.test(match.prefix) ||
    TENTATIVE_OR_CONDITIONAL.test(core) ||
    INCOMPLETE_TRAILING_FRAGMENT.test(core) ||
    NON_DELIVERABLE_ACTION_HEAD.test(core) ||
    UNRESOLVED_INTERROGATIVE_ACTION.test(core) ||
    DEICTIC_LOOK_ACTION.test(core) ||
    DEICTIC_WORKING_CHECK.test(core) ||
    DEICTIC_DO_ACTION.test(core) ||
    MALFORMED_DO_ACTION.test(core) ||
    RUN_ON_BACKCHANNEL.test(core) ||
    BROKEN_PREPOSITION_SEQUENCE.test(core) ||
    BROKEN_DETAIL_PHRASE.test(core) ||
    UNSCOPED_SOCIAL_ACTION.test(core) ||
    DEICTIC_SOCIAL_ACTION.test(core) ||
    OBJECTLESS_LOOK_ACTION.test(core) ||
    SOCIAL_STATUS_PROMISE.test(core) ||
    PRESENTATIONAL_ACTION_HEAD.test(core)
  ) {
    return null
  }

  const primaryAction = primaryActionFamily(core)
  if (!primaryAction) return null

  const objectTokens = actionObjectTokens(core, match.owner, primaryAction)
  if (objectTokens.size === 0) return null
  if (
    kind === 'unassigned-commitment' &&
    primaryAction.startsWith('lexical:') &&
    objectTokens.size < 2
  ) {
    return null
  }

  return {
    kind,
    row,
    actionText: cleanedActionText,
    provisionalOwner,
    primaryAction,
    objectTokens
  }
}

function candidatesForRow(
  row: Transcript,
  localOwnerLabel: string,
  transcriptRows: readonly Transcript[],
  existingOwnerLabels: ReadonlySet<string>
): ActionCandidate[] {
  if (!Number.isFinite(row.startMs) || !Number.isFinite(row.endMs) || row.startMs > row.endMs) {
    return []
  }

  const candidates: ActionCandidate[] = []
  for (const clause of splitClauses(row.text)) {
    const embeddedMatches = embeddedCommitmentMatches(clause)
    if (embeddedMatches.length > 0) {
      for (const match of embeddedMatches) {
        const localSingular =
          row.speaker.trim().toLocaleLowerCase() === 'me' && match.subject === 'i'
        const candidate = candidateFromMatch(
          localSingular ? 'local-commitment' : 'unassigned-commitment',
          row,
          match,
          localSingular ? localOwnerLabel : null
        )
        if (candidate) candidates.push(candidate)
      }
      continue
    }

    let acceptedLocalCandidate = false
    if (row.speaker.trim().toLocaleLowerCase() === 'me') {
      for (const pattern of [LOCAL_COMMITMENT, LET_ME_COMMITMENT]) {
        const match = matchingTail(clause, pattern)
        if (!match) continue
        const candidate = candidateFromMatch('local-commitment', row, match, localOwnerLabel)
        if (candidate) {
          candidates.push(candidate)
          acceptedLocalCandidate = true
        }
        break
      }
    }

    if (acceptedLocalCandidate) continue

    for (const pattern of [LOCAL_COMMITMENT, COLLECTIVE_COMMITMENT]) {
      const match = matchingTail(clause, pattern)
      if (!match) continue
      const candidate = candidateFromMatch('unassigned-commitment', row, match, null)
      if (candidate) candidates.push(candidate)
      break
    }

    const namedAssignment = matchingTail(clause, NAMED_ASSIGNMENT)
    if (
      namedAssignment?.owner &&
      isPlausibleExplicitOwner(
        namedAssignment.owner,
        'named-assignment',
        row,
        transcriptRows,
        existingOwnerLabels
      )
    ) {
      const candidate = candidateFromMatch(
        'named-assignment',
        row,
        namedAssignment,
        namedAssignment.owner
      )
      if (candidate) candidates.push(candidate)
    }

    const namedRequest = matchingTail(clause, NAMED_REQUEST)
    if (
      namedRequest?.owner &&
      isPlausibleExplicitOwner(
        namedRequest.owner,
        'named-request',
        row,
        transcriptRows,
        existingOwnerLabels
      )
    ) {
      const candidate = candidateFromMatch('named-request', row, namedRequest, namedRequest.owner)
      if (candidate) candidates.push(candidate)
    } else {
      const directRequest = matchingTail(clause, DIRECT_REQUEST)
      if (directRequest) {
        const candidate = candidateFromMatch('unassigned-request', row, directRequest, null)
        if (candidate) candidates.push(candidate)
      }
    }
  }
  return candidates
}

function capitalizeAction(text: string): string {
  const trimmed = text.trim().replace(/^[,;:—-]+\s*/u, '')
  if (!trimmed) return ''
  return `${trimmed[0].toLocaleUpperCase()}${trimmed.slice(1)}`
}

function actionTitle(actionText: string): string {
  const core = actionCore(actionText).replace(/[,.:—-]+$/u, '')
  const capped = core.length <= 96 ? core : core.slice(0, 96).replace(/\s+\S*$/u, '')
  return capitalizeAction(capped)
}

function actionContent(actionText: string): string {
  const capitalized = capitalizeAction(actionText).replace(/\s+/gu, ' ').trim()
  if (!capitalized) return ''
  return /[.!?]$/u.test(capitalized) ? capitalized : `${capitalized}.`
}

function cleanScopedTargets(rawScope: string): string | null {
  const scope = rawScope
    .split(/[.!?;\n]/u, 1)[0]!
    .replace(/\b(?:uh+|um+)\b/giu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  if (!/^both\s+/iu.test(scope)) return null
  const targets = scope.replace(/^both\s+/iu, '').split(/\s+and\s+/iu)
  if (targets.length !== 2 || targets.some((target) => normalizedWords(target).length === 0)) {
    return null
  }
  return `both ${targets.map((target) => target.trim()).join(' and ')}`
}

function scopedContextualRequests(
  transcriptRows: readonly Transcript[]
): ScopedContextualRequest[] {
  const rows = transcriptRows
    .filter(
      (row) =>
        Number.isFinite(row.startMs) && Number.isFinite(row.endMs) && row.startMs <= row.endMs
    )
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs)
  const requests: ScopedContextualRequest[] = []

  for (let index = 1; index < rows.length; index += 1) {
    const requestRow = rows[index]!
    if (requestRow.speaker.trim().toLocaleLowerCase() !== 'me') continue
    const requestMatch = SCOPED_PRONOUN_REQUEST.exec(requestRow.text)
    const requestPrefix = requestMatch ? requestRow.text.slice(0, requestMatch.index) : ''
    if (
      !requestMatch ||
      ACTION_NEGATION.test(requestRow.text) ||
      REPORTED_SPEECH_PREFIX.test(requestPrefix) ||
      TENTATIVE_OR_CONDITIONAL.test(requestPrefix)
    ) {
      continue
    }
    const scope = requestMatch?.groups?.scope ? cleanScopedTargets(requestMatch.groups.scope) : null
    if (!scope) continue

    const priorRow = rows[index - 1]!
    if (
      priorRow.meetingId !== requestRow.meetingId ||
      requestRow.startMs - priorRow.endMs > CONTEXTUAL_REQUEST_MAX_GAP_MS ||
      ACTION_NEGATION.test(priorRow.text) ||
      !PRIOR_WAIT_FOR_REACH_OUT.test(priorRow.text)
    ) {
      continue
    }
    const priorAction = PRIOR_APPROVAL_ACTION.exec(priorRow.text)
    const object = priorAction?.groups?.object?.toLocaleLowerCase()
    if (!object) continue

    const title = `Give ${object} for ${scope}`
    const actionText = `${title} after they reach out.`
    const objectTokens = actionObjectTokens(actionText)
    if (objectTokens.size === 0) continue
    requests.push({ priorRow, requestRow, title, actionText, objectTokens })
  }

  return requests
}

function scopedRequestSegment(request: ScopedContextualRequest): Segment {
  const digest = createHash('sha256')
    .update(
      [
        request.requestRow.meetingId,
        request.priorRow.startMs,
        request.requestRow.endMs,
        request.actionText.toLocaleLowerCase()
      ].join('\n')
    )
    .digest('hex')
    .slice(0, 16)
  return {
    id: `recovered-action:${digest}`,
    meetingId: request.requestRow.meetingId,
    category: 'action_item',
    topic: null,
    title: request.title,
    content: request.actionText,
    assignee: null,
    deadline: null,
    sourceStartMs: request.priorRow.startMs,
    sourceEndMs: request.requestRow.endMs
  }
}

function isScopedRequestDuplicate(request: ScopedContextualRequest, segment: Segment): boolean {
  const summary = segmentSummary(segment)
  return (
    actionPredicatesOverlap(request.actionText, summary) &&
    objectContainment(request.objectTokens, actionObjectTokens(summary)) >= 0.6
  )
}

function candidateId(candidate: ActionCandidate): string {
  const digest = createHash('sha256')
    .update(
      [
        candidate.row.meetingId,
        candidate.row.startMs,
        candidate.row.endMs,
        candidate.provisionalOwner?.toLocaleLowerCase() ?? 'unassigned',
        candidate.actionText.toLocaleLowerCase()
      ].join('\n')
    )
    .digest('hex')
    .slice(0, 16)
  return `recovered-action:${digest}`
}

function candidateSegment(candidate: ActionCandidate): Segment {
  return {
    id: candidateId(candidate),
    meetingId: candidate.row.meetingId,
    category: 'action_item',
    topic: null,
    title: actionTitle(candidate.actionText),
    content: actionContent(candidate.actionText),
    assignee: candidate.provisionalOwner,
    deadline: null,
    sourceStartMs: candidate.row.startMs,
    sourceEndMs: candidate.row.endMs
  }
}

function segmentSummary(segment: Segment): string {
  return `${segment.title} ${segment.content}`.trim()
}

function overlapsRow(segment: Segment, row: Transcript): boolean {
  return (
    segment.meetingId === row.meetingId &&
    Number.isFinite(segment.sourceStartMs) &&
    Number.isFinite(segment.sourceEndMs) &&
    segment.sourceStartMs <= row.endMs &&
    segment.sourceEndMs >= row.startMs
  )
}

function isExistingActionDuplicate(candidate: ActionCandidate, segment: Segment): boolean {
  const summary = segmentSummary(segment)
  return (
    !hasConflictingNamedObjects(candidate, summary, segment.assignee ?? undefined) &&
    actionPredicatesOverlap(candidate.actionText, summary) &&
    actionSpeechActSupportsSummary(candidate.row.text, summary, segment.assignee ?? undefined) &&
    objectContainment(
      candidate.objectTokens,
      actionObjectTokens(summary, segment.assignee ?? undefined, candidate.primaryAction)
    ) >= 0.6
  )
}

function isCandidateDuplicate(left: ActionCandidate, right: ActionCandidate): boolean {
  return (
    (left.provisionalOwner?.toLocaleLowerCase() ?? '') ===
      (right.provisionalOwner?.toLocaleLowerCase() ?? '') &&
    !hasConflictingNamedObjects(left, right.actionText, right.provisionalOwner ?? undefined) &&
    !hasConflictingNamedObjects(right, left.actionText, left.provisionalOwner ?? undefined) &&
    actionPredicatesOverlap(left.actionText, right.actionText) &&
    objectContainment(left.objectTokens, right.objectTokens) >= 0.6
  )
}

function candidateQuality(candidate: ActionCandidate): number {
  const text = candidate.actionText.trim()
  const coreWords = normalizedWords(actionCore(text)).length
  let score = Math.min(candidate.objectTokens.size, 4) * 2

  if (/[.!?]$/u.test(text)) score += 3
  if (INCOMPLETE_TRAILING_FRAGMENT.test(text)) score -= 8
  else score += 4
  if (PURPOSE_OR_RESULT_DETAIL.test(text)) score += 2
  if (TEMPORAL_DETAIL.test(text)) score += 1
  if (REPEATED_ADJACENT_WORD.test(text)) score -= 3
  score -= Math.min(text.match(BROKEN_MIXED_ALPHANUMERIC)?.length ?? 0, 2) * 3
  if (coreWords > 20) score -= 4
  if (coreWords > 35) score -= 4
  if (text.length <= 180) score += 1

  return score
}

function dedupeCandidates(candidates: readonly ActionCandidate[]): {
  candidates: ActionCandidate[]
  dedupedCount: number
} {
  const selected: ActionCandidate[] = []
  let dedupedCount = 0

  for (const candidate of candidates) {
    const duplicateIndex = selected.findIndex((existing) =>
      isCandidateDuplicate(candidate, existing)
    )
    if (duplicateIndex < 0) {
      selected.push(candidate)
      continue
    }

    dedupedCount += 1
    if (candidateQuality(candidate) > candidateQuality(selected[duplicateIndex]!)) {
      selected[duplicateIndex] = candidate
    }
  }

  selected.sort(
    (left, right) =>
      left.row.startMs - right.row.startMs ||
      left.row.endMs - right.row.endMs ||
      left.actionText.localeCompare(right.actionText)
  )
  return { candidates: selected, dedupedCount }
}

function objectContainment(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  const denominator = Math.min(left.size, right.size)
  if (denominator === 0) return 0
  const shared = [...left].filter((token) => right.has(token)).length
  return shared / denominator
}

function isActionShapedWriterText(text: string, expectedAction: string): boolean {
  return splitClauses(text).some((clause) => {
    if (matchingTail(clause, LOCAL_COMMITMENT) || matchingTail(clause, LET_ME_COMMITMENT)) {
      return true
    }
    if (matchingTail(clause, NAMED_ASSIGNMENT) || matchingTail(clause, NAMED_REQUEST)) {
      return true
    }
    const primaryAction = primaryActionFamily(clause)
    return (
      primaryAction === expectedAction &&
      actionObjectTokens(clause, undefined, primaryAction).size > 0
    )
  })
}

function isPromotable(candidate: ActionCandidate, segment: Segment): boolean {
  const summary = segmentSummary(segment)
  if (!overlapsRow(segment, candidate.row)) return false
  if (hasConflictingNamedObjects(candidate, summary, segment.assignee ?? undefined)) return false
  if (
    !isActionShapedWriterText(segment.title, candidate.primaryAction) &&
    !isActionShapedWriterText(segment.content, candidate.primaryAction)
  ) {
    return false
  }
  if (!actionPredicatesOverlap(candidate.actionText, summary)) return false
  return (
    objectContainment(
      candidate.objectTokens,
      actionObjectTokens(summary, undefined, candidate.primaryAction)
    ) >= 0.6
  )
}

function removeAt<T>(values: readonly T[], index: number): T[] {
  return [...values.slice(0, index), ...values.slice(index + 1)]
}

function resolvedCandidateOwner(
  candidate: ActionCandidate,
  segment: Segment,
  transcriptRows: readonly Transcript[],
  localOwnerLabel: string
): string | null {
  if (!candidate.provisionalOwner) return null
  if (candidate.kind === 'local-commitment') return localOwnerLabel
  return resolveSpeakerAwareOwner(segment, transcriptRows, localOwnerLabel)
}

/**
 * Recovers explicit transcript commitments and requests. Individual owners are
 * retained only when independently verifiable; remote or collective speech is
 * kept unassigned rather than pretending `[them]` is diarization. The function
 * is pure and platform-neutral; callers decide where to enable it.
 */
export function recoverExplicitTranscriptActions(
  segments: MeetingSegments,
  transcriptRows: readonly Transcript[],
  options: RecoverExplicitTranscriptActionsOptions = {}
): ExplicitTranscriptActionRecoveryResult {
  const localOwnerLabel = options.localOwnerLabel?.trim() || 'Me'
  let recoveredActionCount = 0
  let promotedActionCount = 0
  let dedupedRecoveredActionCount = 0

  const augmented: MeetingSegments = {
    decisions: [...segments.decisions],
    actionItems: [...segments.actionItems],
    information: [...segments.information],
    discussion: [...segments.discussion],
    statusUpdates: [...segments.statusUpdates]
  }

  const existingOwnerLabels = new Set(
    augmented.actionItems.flatMap((segment) => {
      const owner = segment.assignee?.trim().toLocaleLowerCase()
      return owner ? [owner] : []
    })
  )
  const rawCandidates = transcriptRows
    .flatMap((row) => candidatesForRow(row, localOwnerLabel, transcriptRows, existingOwnerLabels))
    .sort(
      (left, right) =>
        left.row.startMs - right.row.startMs ||
        left.row.endMs - right.row.endMs ||
        left.actionText.localeCompare(right.actionText)
    )
  const candidateSelection = dedupeCandidates(rawCandidates)
  const candidates = candidateSelection.candidates
  dedupedRecoveredActionCount += candidateSelection.dedupedCount

  for (const candidate of candidates) {
    const recovered = candidateSegment(candidate)
    const resolvedOwner = resolvedCandidateOwner(
      candidate,
      recovered,
      transcriptRows,
      localOwnerLabel
    )
    if (candidate.provisionalOwner && !resolvedOwner) continue
    recovered.assignee = resolvedOwner

    const duplicateActionIndex = augmented.actionItems.findIndex((segment) =>
      isExistingActionDuplicate(candidate, segment)
    )
    if (duplicateActionIndex >= 0) {
      const duplicate = augmented.actionItems[duplicateActionIndex]!
      if (
        candidate.kind === 'named-assignment' &&
        !duplicate.assignee?.trim() &&
        overlapsRow(duplicate, candidate.row)
      ) {
        const enriched = { ...duplicate, assignee: resolvedOwner }
        const confirmedOwner = resolveSpeakerAwareOwner(enriched, transcriptRows, localOwnerLabel)
        if (confirmedOwner === resolvedOwner) {
          augmented.actionItems[duplicateActionIndex] = enriched
        }
      }
      dedupedRecoveredActionCount += 1
      continue
    }

    let promoted = false
    for (const bucket of PROMOTABLE_BUCKETS) {
      const index = augmented[bucket].findIndex((segment) => isPromotable(candidate, segment))
      if (index < 0) continue

      const source = augmented[bucket][index]
      const promotedSegment: Segment = {
        ...source,
        category: 'action_item',
        assignee: candidate.provisionalOwner
      }
      const promotedOwner = resolvedCandidateOwner(
        candidate,
        promotedSegment,
        transcriptRows,
        localOwnerLabel
      )
      if (candidate.provisionalOwner && !promotedOwner) continue

      promotedSegment.assignee = promotedOwner
      augmented[bucket] = removeAt(augmented[bucket], index)
      augmented.actionItems.push(promotedSegment)
      promotedActionCount += 1
      promoted = true
      break
    }

    if (promoted) continue
    augmented.actionItems.push(recovered)
    recoveredActionCount += 1
  }

  for (const request of scopedContextualRequests(transcriptRows)) {
    if (augmented.actionItems.some((segment) => isScopedRequestDuplicate(request, segment))) {
      dedupedRecoveredActionCount += 1
      continue
    }
    augmented.actionItems.push(scopedRequestSegment(request))
    recoveredActionCount += 1
  }

  return {
    segments: augmented,
    recoveredActionCount,
    promotedActionCount,
    dedupedRecoveredActionCount
  }
}
