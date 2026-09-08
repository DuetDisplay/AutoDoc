import { isWindowsTopicWriterEnabled, windowsPersonPattern } from './windows-notes-experiment'

const FIRST_PERSON_COMMITMENT =
  /\b(?:i(?:['’]ll|\s+will|\s+need\s+to|\s+have\s+to|\s+plan\s+to|\s+commit\s+to|\s+promise\s+to|(?:['’]m|\s+am)\s+(?:(?:going|gonna)\s+to|planning\s+to))|we(?:['’]ll|\s+will|\s+need\s+to|\s+have\s+to|\s+plan\s+to|(?:['’]re|\s+are)\s+(?:(?:going|gonna)\s+to|planning\s+to)))\b/iu

const SINGULAR_FIRST_PERSON_COMMITMENT =
  /\bi(?:['’]ll|\s+will|\s+need\s+to|\s+have\s+to|\s+plan\s+to|\s+commit\s+to|\s+promise\s+to|(?:['’]m|\s+am)\s+(?:(?:going|gonna)\s+to|planning\s+to))\b/iu

const FIRST_PERSON_ACTION_IN_PROGRESS =
  /\b(?:i(?:['’]m|\s+am)|we(?:['’]re|\s+are))\s+(?:adding|approving|asking|calling|checking|creating|deploying|documenting|emailing|following\s+up|monitoring|notifying|reminding|removing|scheduling|sending|watching|writing)\b/iu

const SINGULAR_FIRST_PERSON_ACTION_IN_PROGRESS =
  /\bi(?:['’]m|\s+am)\s+(?:adding|approving|asking|calling|checking|creating|deploying|documenting|emailing|following\s+up|monitoring|notifying|reminding|removing|scheduling|sending|watching|writing)\b/iu

const LET_ME_COMMITMENT = /\blet\s+me\s+(?!know\b)/iu

const FIRST_PERSON_PLAN = /\bmy\s+plan\s+is\s+to\b/iu

const NAMED_ASSIGNMENT =
  /\b[A-Z][a-z]{1,}(?:\s+[A-Z][a-z]{1,})?\s+(?:will|must|needs?\s+to|is\s+(?:going|gonna)\s+to|owns?|is\s+responsible\s+for|agreed\s+to|committed\s+to|plans?\s+to)\b/u

const DIRECT_REQUEST =
  /\b(?:(?:[A-Z][a-z]{1,}(?:\s+[A-Z][a-z]{1,})?\s*[,;:—-]\s*)?please\b|(?:can|could|would|will)\s+you\b)/iu

const MAKE_SURE_REQUEST = /\b(?:just\s+)?make\s+sure\s+(?:that\s+|you\s+)?/iu

const IMPERATIVE_ACTION =
  /^\s*(?:please\s+)?(?:add|approve|ask|call|check|create|deploy|distribute|document|email|fix|follow\s+up|handle|implement|investigate|monitor|notify|ping|prepare|reach\s+out|release|remind|remove|review|roll\s+out|schedule|send|share|ship|start|submit|test|update|watch|write)\b/iu

const ACTION_NEGATION =
  /\b(?:not|never|cannot|can't|won't|wouldn't|couldn't|shouldn't|don't|doesn't|didn't|do\s+not|does\s+not|did\s+not|will\s+not|would\s+not|could\s+not|should\s+not|no\s+need\s+to)\b/iu

const REPORTED_SPEECH_PREFIX =
  /\b(?:according\s+to|(?:[\p{L}'’-]+\s+){0,2}(?:said|says|told|mentioned|wrote|asked|replied|promised))\b/iu

const RELATION_STOPWORDS = new Set([
  'about',
  'after',
  'again',
  'also',
  'before',
  'being',
  'could',
  'going',
  'have',
  'into',
  'just',
  'need',
  'once',
  'should',
  'that',
  'their',
  'there',
  'these',
  'they',
  'this',
  'those',
  'will',
  'with',
  'would'
])

const ACTION_VERB_FAMILIES: ReadonlyArray<{
  canonical: string
  pattern: RegExp
}> = [
  {
    canonical: 'add',
    pattern: /^(?:add|added|adding|include|included|including|put|extend|extended)$/i
  },
  {
    canonical: 'approve',
    pattern:
      /^(?:approve|approves|approved|approving|authorize|authorizes|authorized|authorizing|give|gives|gave|given|giving|grant|grants|granted|granting|provide|provides|provided|providing)$/i
  },
  {
    canonical: 'contact',
    pattern: /^(?:ask|asked|asking|contact|contacted|follow|followed|ping|pinged|remind|reminded)$/i
  },
  { canonical: 'call', pattern: /^(?:call|calls|called|calling)$/i },
  {
    canonical: 'check',
    pattern: /^(?:check|checked|checking|review|reviewed|reviewing|verify|verified)$/i
  },
  {
    canonical: 'create',
    pattern: /^(?:build|built|create|created|creating|draft|drafted|make|made|prepare|prepared)$/i
  },
  { canonical: 'deploy', pattern: /^(?:deploy|deploys|deployed|deploying)$/i },
  {
    canonical: 'document',
    pattern: /^(?:document|documents|documented|documenting)$/i
  },
  { canonical: 'email', pattern: /^(?:email|emails|emailed|emailing)$/i },
  { canonical: 'monitor', pattern: /^(?:monitor|monitors|monitored|monitoring)$/i },
  { canonical: 'notify', pattern: /^(?:notify|notifies|notified|notifying)$/i },
  { canonical: 'remove', pattern: /^(?:remove|removes|removed|removing)$/i },
  {
    canonical: 'schedule',
    pattern: /^(?:schedule|schedules|scheduled|scheduling)$/i
  },
  { canonical: 'send', pattern: /^(?:distribute|distributed|send|sent|share|shared)$/i },
  { canonical: 'release', pattern: /^(?:release|released|rollout|ship|shipped)$/i },
  { canonical: 'update', pattern: /^(?:change|changed|update|updated)$/i },
  { canonical: 'fix', pattern: /^(?:fix|fixed|resolve|resolved)$/i },
  { canonical: 'handle', pattern: /^(?:handle|handled|own|owned)$/i },
  { canonical: 'implement', pattern: /^(?:implement|implemented)$/i },
  { canonical: 'investigate', pattern: /^(?:investigate|investigated)$/i },
  { canonical: 'submit', pattern: /^(?:submit|submitted)$/i },
  { canonical: 'start', pattern: /^(?:begin|began|start|started|starting)$/i },
  { canonical: 'test', pattern: /^(?:test|tested|testing)$/i },
  { canonical: 'watch', pattern: /^(?:watch|watched|watching)$/i },
  { canonical: 'write', pattern: /^(?:write|writes|wrote|written|writing)$/i }
]

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

const GENERIC_ACTION_OBJECT_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'back',
  'it',
  'me',
  'my',
  'our',
  'that',
  'the',
  'their',
  'them',
  'these',
  'they',
  'this',
  'those',
  'us',
  'we',
  'you',
  'your'
])

const EXPLICIT_GENERIC_ACTION_TAILS = [
  /\b(?:i(?:['’]ll|\s+will|\s+need\s+to|\s+have\s+to|\s+plan\s+to|\s+commit\s+to|\s+promise\s+to|(?:['’]m|\s+am)\s+(?:(?:going|gonna)\s+to|planning\s+to))|we(?:['’]ll|\s+will|\s+need\s+to|\s+have\s+to|\s+plan\s+to|(?:['’]re|\s+are)\s+(?:(?:going|gonna)\s+to|planning\s+to)))\s+(?<action>.+)$/iu,
  /\b(?:i(?:['’]m|\s+am)|we(?:['’]re|\s+are))\s+(?<action>(?:adding|approving|asking|calling|checking|creating|deploying|documenting|emailing|following\s+up|monitoring|notifying|reminding|removing|scheduling|sending|watching|writing)\b.+)$/iu,
  /\bmy\s+plan\s+is\s+to\s+(?<action>.+)$/iu,
  /\blet\s+me\s+(?!know\b)(?<action>.+)$/iu,
  /\b[A-Z][a-z]{1,}(?:\s+[A-Z][a-z]{1,})?\s+(?:will|must|needs?\s+to|is\s+(?:going|gonna)\s+to|owns?|is\s+responsible\s+for|agreed\s+to|committed\s+to|plans?\s+to)\s+(?<action>.+)$/u,
  /\b(?:[A-Z][a-z]{1,}(?:\s+[A-Z][a-z]{1,})?\s*[,;:—-]\s*)?(?:please\s+|(?:can|could|would|will)\s+you\s+)(?<action>.+)$/iu
] as const

const EMBEDDED_SPEECH_ACT_MARKER =
  /\b(?:i|we)(?:['’]ll|\s+will|\s+need\s+to|\s+have\s+to|\s+plan\s+to|(?:['’]m|\s+am|['’]re|\s+are)\s+(?:(?:going|gonna)\s+to|planning\s+(?:to|on)))\s+/giu

function normalizeActionToken(token: string): string {
  let normalized = token.toLowerCase()
  if (normalized.endsWith('ing') && normalized.length > 6) normalized = normalized.slice(0, -3)
  else if (normalized.endsWith('ed') && normalized.length > 5) normalized = normalized.slice(0, -2)
  else if (normalized.endsWith('es') && normalized.length > 5) normalized = normalized.slice(0, -2)
  else if (normalized.endsWith('s') && normalized.length > 5) normalized = normalized.slice(0, -1)
  return normalized
}

function actionRelationTokens(text: string, excludedLiteral?: string): Set<string> {
  let comparable = text.toLowerCase()
  if (excludedLiteral) comparable = comparable.replaceAll(excludedLiteral.toLowerCase(), ' ')

  return new Set(
    (comparable.match(/[\p{L}\p{N}]{4,}/gu) ?? [])
      .map((token) => {
        const family = ACTION_VERB_FAMILIES.find((candidate) => candidate.pattern.test(token))
        return family?.canonical ?? normalizeActionToken(token)
      })
      .filter((token) => !RELATION_STOPWORDS.has(token))
  )
}

function actionVerbFamilies(text: string): Set<string> {
  const words = text.match(/[A-Za-z]+/g) ?? []
  const families = new Set<string>()
  for (const word of words) {
    const family = ACTION_VERB_FAMILIES.find((candidate) => candidate.pattern.test(word))
    if (family) families.add(family.canonical)
  }
  return families
}

function genericVerbForms(word: string): Set<string> {
  const normalized = word.toLocaleLowerCase()
  const forms = new Set([normalized])
  if (normalized.endsWith('ies') && normalized.length > 4) {
    forms.add(`${normalized.slice(0, -3)}y`)
  } else if (normalized.endsWith('ied') && normalized.length > 4) {
    forms.add(`${normalized.slice(0, -3)}y`)
  } else if (normalized.endsWith('ing') && normalized.length > 5) {
    const stem = normalized.slice(0, -3)
    forms.add(stem)
    forms.add(`${stem}e`)
  } else if (normalized.endsWith('ed') && normalized.length > 4) {
    const stem = normalized.slice(0, -2)
    forms.add(stem)
    forms.add(`${stem}e`)
  } else if (normalized.endsWith('es') && normalized.length > 4) {
    forms.add(normalized.slice(0, -2))
  } else if (normalized.endsWith('s') && normalized.length > 3) {
    forms.add(normalized.slice(0, -1))
  }
  return forms
}

function leadingGenericActionWord(text: string): string | null {
  const word =
    text
      .trim()
      .match(/^\p{L}[\p{L}'’-]*/u)?.[0]
      ?.toLocaleLowerCase() ?? ''
  if (
    word.length < 2 ||
    GENERIC_ACTION_HEAD_STOPWORDS.has(word) ||
    /^(?:i|he|her|him|it|me|she|that|them|they|this|us|we|you)$/iu.test(word)
  ) {
    return null
  }
  return word
}

function genericActionObjectTokens(text: string, actionWord: string): Set<string> {
  const actionForms = genericVerbForms(actionWord)
  return new Set(
    (text.match(/[\p{L}\p{N}]+/gu) ?? [])
      .map((word) => word.toLocaleLowerCase())
      .filter(
        (word) =>
          word.length >= 3 &&
          !actionForms.has(word) &&
          !GENERIC_ACTION_OBJECT_STOPWORDS.has(word) &&
          !GENERIC_ACTION_HEAD_STOPWORDS.has(word)
      )
  )
}

function explicitGenericAction(clause: string): {
  verbForms: Set<string>
  objectTokens: Set<string>
} | null {
  const action = explicitActionTail(clause)
  if (!action) return null

  const verb = leadingGenericActionWord(action)
  if (!verb) return null
  const objectTokens = genericActionObjectTokens(action, verb)
  if (objectTokens.size === 0) return null
  return { verbForms: genericVerbForms(verb), objectTokens }
}

function explicitActionTail(clause: string): string | null {
  for (const pattern of EXPLICIT_GENERIC_ACTION_TAILS) {
    pattern.lastIndex = 0
    const match = windowsPersonPattern(pattern).exec(clause)
    const action = match?.groups?.action?.trim() ?? ''
    if (!match || !action || REPORTED_SPEECH_PREFIX.test(clause.slice(0, match.index))) continue
    return action
  }
  return null
}

function namedResponsibilityObject(clause: string, owner: string): string | null {
  const escapedOwner = owner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(
    `\\b${escapedOwner}\\s+(?:owns?|is\\s+responsible\\s+for)\\s+(?<object>.+)$`,
    'iu'
  ).exec(clause)
  return match?.groups?.object?.trim() || null
}

export function actionPredicatesOverlap(left: string, right: string): boolean {
  const leftHead = leadingGenericActionWord(explicitActionTail(left) ?? left)
  const rightHead = leadingGenericActionWord(explicitActionTail(right) ?? right)
  if (!leftHead || !rightHead) return false

  const leftFamily = ACTION_VERB_FAMILIES.find((candidate) =>
    candidate.pattern.test(leftHead)
  )?.canonical
  const rightFamily = ACTION_VERB_FAMILIES.find((candidate) =>
    candidate.pattern.test(rightHead)
  )?.canonical
  if (leftFamily || rightFamily) return leftFamily != null && leftFamily === rightFamily

  const rightForms = genericVerbForms(rightHead)
  return [...genericVerbForms(leftHead)].some((form) => rightForms.has(form))
}

/** True only when both action heads map to known, incompatible verb families. */
export function actionPredicatesConflict(left: string, right: string): boolean {
  const leftHead = leadingGenericActionWord(explicitActionTail(left) ?? left)
  const rightHead = leadingGenericActionWord(explicitActionTail(right) ?? right)
  if (!leftHead || !rightHead) return false

  const leftFamily = ACTION_VERB_FAMILIES.find((candidate) =>
    candidate.pattern.test(leftHead)
  )?.canonical
  const rightFamily = ACTION_VERB_FAMILIES.find((candidate) =>
    candidate.pattern.test(rightHead)
  )?.canonical
  return leftFamily != null && rightFamily != null && leftFamily !== rightFamily
}

function splitClauses(text: string): string[] {
  return text
    .split(/[.!?;\n]+/u)
    .map((clause) => clause.trim())
    .filter(Boolean)
}

function splitEmbeddedSpeechActs(clause: string): string[] {
  const matches = [...clause.matchAll(EMBEDDED_SPEECH_ACT_MARKER)]
  if (matches.length < 2) return [clause]
  return matches.map((match, index) =>
    clause.slice(match.index ?? 0, matches[index + 1]?.index ?? clause.length).trim()
  )
}

function hasUnreportedUnnegatedMatch(clause: string, pattern: RegExp): boolean {
  const match = windowsPersonPattern(pattern).exec(clause)
  if (!match || REPORTED_SPEECH_PREFIX.test(clause.slice(0, match.index))) return false
  const nearby = clause.slice(Math.max(0, match.index - 32), match.index + match[0].length + 80)
  return !ACTION_NEGATION.test(nearby)
}

export function hasExplicitFirstPersonCommitment(text: string): boolean {
  return splitClauses(text).some(
    (clause) =>
      hasUnreportedUnnegatedMatch(clause, FIRST_PERSON_COMMITMENT) ||
      hasUnreportedUnnegatedMatch(clause, FIRST_PERSON_ACTION_IN_PROGRESS) ||
      hasUnreportedUnnegatedMatch(clause, FIRST_PERSON_PLAN) ||
      hasUnreportedUnnegatedMatch(clause, LET_ME_COMMITMENT)
  )
}

/** Only commitments by the captured local individual, never collective `we`. */
export function hasExplicitSingularFirstPersonCommitment(text: string): boolean {
  return splitClauses(text).some(
    (clause) =>
      hasUnreportedUnnegatedMatch(clause, SINGULAR_FIRST_PERSON_COMMITMENT) ||
      hasUnreportedUnnegatedMatch(clause, SINGULAR_FIRST_PERSON_ACTION_IN_PROGRESS) ||
      hasUnreportedUnnegatedMatch(clause, FIRST_PERSON_PLAN) ||
      hasUnreportedUnnegatedMatch(clause, LET_ME_COMMITMENT)
  )
}

export function explicitActionSpeechActClauses(text: string): string[] {
  return splitClauses(text)
    .flatMap(splitEmbeddedSpeechActs)
    .filter(
      (clause) =>
        hasUnreportedUnnegatedMatch(clause, FIRST_PERSON_COMMITMENT) ||
        hasUnreportedUnnegatedMatch(clause, FIRST_PERSON_ACTION_IN_PROGRESS) ||
        hasUnreportedUnnegatedMatch(clause, FIRST_PERSON_PLAN) ||
        hasUnreportedUnnegatedMatch(clause, LET_ME_COMMITMENT) ||
        hasUnreportedUnnegatedMatch(clause, NAMED_ASSIGNMENT) ||
        hasUnreportedUnnegatedMatch(clause, DIRECT_REQUEST) ||
        hasUnreportedUnnegatedMatch(clause, MAKE_SURE_REQUEST) ||
        hasUnreportedUnnegatedMatch(clause, IMPERATIVE_ACTION)
    )
}

/**
 * Requires an explicit speech act and the same action vocabulary. A single
 * strong verb is sufficient only for terse pronominal commitments such as
 * "I'll approve it"; otherwise two shared action/object tokens are required.
 */
export function actionSpeechActSupportsSummary(
  evidenceText: string,
  summaryText: string,
  excludedLiteral?: string
): boolean {
  const summaryTokens = actionRelationTokens(summaryText, excludedLiteral)
  if (summaryTokens.size === 0) return false

  return explicitActionSpeechActClauses(evidenceText).some((clause) => {
    const summaryVerbs = actionVerbFamilies(summaryText)
    if (summaryVerbs.size > 0 && actionPredicatesOverlap(summaryText, clause)) {
      const evidenceTokens = actionRelationTokens(clause, excludedLiteral)
      const shared = [...evidenceTokens].filter((token) => summaryTokens.has(token))
      if (shared.length >= 2) return true
      if (evidenceTokens.size === 1 && shared.length === 1) return true
    }

    // Named ownership assigns responsibility for an object without naming the
    // implementation verb. Permit that only while verifying that exact named
    // owner (callers pass excludedLiteral), never for general action creation.
    if (excludedLiteral) {
      const responsibilityObject = namedResponsibilityObject(clause, excludedLiteral)
      if (responsibilityObject) {
        const responsibilityTokens = actionRelationTokens(responsibilityObject)
        const sharedObjects = [...responsibilityTokens].filter((token) => summaryTokens.has(token))
        if (sharedObjects.length >= Math.min(2, responsibilityTokens.size)) return true
      }
    }

    const genericAction = explicitGenericAction(clause)
    const summaryHead = leadingGenericActionWord(isWindowsTopicWriterEnabled()
      ? explicitActionTail(summaryText) ?? summaryText
      : summaryText)
    if (!genericAction || !summaryHead) return false
    const summaryHeadForms = genericVerbForms(summaryHead)
    if (![...genericAction.verbForms].some((form) => summaryHeadForms.has(form))) return false

    const summaryObjects = genericActionObjectTokens(summaryText, summaryHead)
    return [...genericAction.objectTokens].some((token) => summaryObjects.has(token))
  })
}
