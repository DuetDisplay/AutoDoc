/**
 * Ask AI turn classifier (AD-83).
 *
 * One place that decides what *kind* of conversational turn the user just sent,
 * resolving coreference against the ordered list of recordings the user was last
 * shown. This replaces the scattered, overlapping predicates that previously lived
 * in `chat-ipc.ts` (acknowledgement detection, count-confirmation gating, ordinal
 * extraction, implicit-follow-up detection, fresh-search-term detection, etc.),
 * each of which maintained its own drifting vocabulary.
 *
 * Design goals:
 *   - Single, ordered precedence so a turn resolves to exactly one kind.
 *   - Shared lexicon (no duplicated word lists).
 *   - Deterministic coreference against the *presented* ordered list, including
 *     ordinal-vs-quantity disambiguation, "first/last", and title references.
 *   - Affirmations answering a clarification are never mistaken for "thanks".
 */
import { extractQuestionTerms } from './chat-retrieval'
import { normalizeRecordingSearchText } from './recording-title'

export interface ChatTurnSession {
  /** Ordered recording ids the user was last shown (most recent first). */
  recordingIds: string[]
  /** Ordered recording titles, parallel to recordingIds. */
  recordingTitles: string[]
  /** Number of calendar meetings in the last presented calendar list. */
  calendarEventCount: number
  /** Recordings currently in focus from the prior turn (drill-down target). */
  focusedRecordingIds: string[]
  /** True when the previous assistant turn asked a clarifying question. */
  lastTurnWasClarification: boolean
}

export interface ChatHistoryTurn {
  role: 'user' | 'assistant'
  content: string
}

export type ClassifiedTurn =
  | { kind: 'acknowledgement' }
  | { kind: 'smalltalk'; topic: 'greeting' | 'capability' }
  | { kind: 'count_confirmation'; scope: 'recording' | 'calendar'; referencedCount: number | null }
  | { kind: 'reference'; meetingIds: string[]; followUp: boolean }
  | { kind: 'scoped_followup'; meetingIds: string[] }
  | { kind: 'new_retrieval' }

// ---------------------------------------------------------------------------
// Shared lexicon (single source of truth for all routing vocabulary)
// ---------------------------------------------------------------------------

/** Words that, on their own, signal gratitude / closing pleasantries. */
const ACKNOWLEDGEMENT_TERMS = new Set([
  'amazing',
  'appreciate',
  'appreciated',
  'awesome',
  'brilliant',
  'cheers',
  'cool',
  'excellent',
  'fantastic',
  'good',
  'got',
  'great',
  'helpful',
  'it',
  'lovely',
  'much',
  'neat',
  'nice',
  'no',
  'ok',
  'okay',
  'perfect',
  'sounds',
  'super',
  'sweet',
  'ta',
  'thank',
  'thanks',
  'thankyou',
  'thx',
  'ty',
  'wonderful',
  'worries',
  'you'
])

/** Greeting / small-talk openers that do not need retrieval or the model. */
const GREETING_TERMS = new Set([
  'afternoon',
  'evening',
  'greetings',
  'hello',
  'hey',
  'heya',
  'hi',
  'hiya',
  'howdy',
  'morning',
  'sup',
  'there',
  'yo'
])

/** Words that affirm a prior assistant question (distinct from gratitude). */
const AFFIRMATION_TERMS = new Set([
  'affirmative',
  'correct',
  'right',
  'sure',
  'yea',
  'yeah',
  'yep',
  'yes',
  'yup'
])

/** Cues that the user is asking us to do or fetch something. */
const REQUEST_CUE =
  /\b(can|could|would|will|please|show|list|give|pull|open|find|search|tell|explain|summarize|summary|summarise|recap|describe|display|what|which|who|whom|when|where|why|how|check|help|need|want)\b/

/** Cues that name meeting data the user wants. */
const MEETING_DATA_CUE =
  /\b(actions?|action items?|agenda|assigned|blockers?|calendar|calls?|decisions?|deadlines?|discussed|details?|meetings?|notes?|owners?|recordings?|risks?|schedule|standups?|status|syncs?|tasks?|todos?|transcripts?)\b/

/** Generic follow-up vocabulary that does NOT count as a fresh search term. */
const GENERIC_FOLLOWUP_TERMS = new Set([
  'action',
  'actions',
  'assigned',
  'blocker',
  'blockers',
  'deadline',
  'deadlines',
  'decision',
  'decisions',
  'detail',
  'details',
  'due',
  'item',
  'items',
  'more',
  'next',
  'note',
  'notes',
  'owner',
  'owners',
  'owns',
  'recap',
  'risk',
  'risks',
  'status',
  'step',
  'steps',
  'summary',
  'summarize',
  'task',
  'tasks',
  'todo',
  'todos',
  'transcript',
  'transcripts',
  // pleasantries that may be glued onto a follow-up
  'appreciate',
  'awesome',
  'can',
  'cheers',
  'cool',
  'could',
  'got',
  'great',
  'ok',
  'okay',
  'please',
  'show',
  'sounds',
  'thank',
  'thanks',
  'thx',
  'ty',
  'would',
  'you'
])

/** Referential anchors that indicate a reference to a prior list item. */
const REFERENTIAL_ANCHOR =
  /\b(one|ones|recording|recordings|meeting|meetings|call|calls|standup|standups|sync|syncs|note|notes|item|items)\b/

const ORDINAL_WORDS: Record<string, number> = {
  first: 0,
  second: 1,
  third: 2,
  fourth: 3,
  fifth: 4,
  sixth: 5,
  seventh: 6,
  eighth: 7,
  ninth: 8,
  tenth: 9
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10
}

/** Generic title tokens that never count as a distinctive title reference. */
const GENERIC_TITLE_TOKENS = new Set([
  'and',
  'call',
  'calls',
  'fixture',
  'meeting',
  'meetings',
  'recording',
  'recordings',
  'review',
  'standup',
  'standups',
  'sync',
  'syncs',
  'the',
  'with'
])

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function classifyChatTurn(
  question: string,
  history: ChatHistoryTurn[],
  session: ChatTurnSession
): ClassifiedTurn {
  const normalized = normalizeRecordingSearchText(question)
  if (!normalized) return { kind: 'new_retrieval' }

  // 1. A question that opens a brand-new scope is always a fresh retrieval.
  if (startsNewScope(normalized)) return { kind: 'new_retrieval' }

  const tokens = normalized.split(' ').filter(Boolean)
  const hasPriorAssistantTurn = history.some((message) => message.role === 'assistant')

  // 2. Pure acknowledgement ("thanks", "ok cool", "much appreciated").
  if (isAcknowledgement(normalized, tokens, hasPriorAssistantTurn, session)) {
    return { kind: 'acknowledgement' }
  }

  // 2b. Greetings / small talk ("hey", "good morning", "what can you do?").
  const smalltalk = classifySmalltalk(normalized, tokens)
  if (smalltalk) return smalltalk

  // 3. Count confirmation ("so four then?", "only 4?", "is that all of them?").
  const countConfirmation = classifyCountConfirmation(normalized, session)
  if (countConfirmation) return countConfirmation

  // 4. Direct coreference to a specific prior list item ("the second one",
  //    "the last one", "the calendar auth one").
  const referencedIds = resolveCoreference(normalized, question, session)
  if (referencedIds && referencedIds.length > 0) {
    return {
      kind: 'reference',
      meetingIds: referencedIds,
      followUp: !hasFreshSearchTerms(normalized)
    }
  }

  // 5. Implicit follow-up that reuses the prior scope ("anything else?",
  //    "show action items") without naming a specific item.
  const scopedIds = resolveScopedFollowUp(normalized, session)
  if (scopedIds.length > 0) return { kind: 'scoped_followup', meetingIds: scopedIds }

  // 6. Everything else is a fresh retrieval.
  return { kind: 'new_retrieval' }
}

// ---------------------------------------------------------------------------
// Precedence helpers
// ---------------------------------------------------------------------------

function startsNewScope(normalized: string): boolean {
  if (
    /\b(all recordings|every recording|recording inventory|library|all meetings|every meeting)\b/.test(
      normalized
    )
  ) {
    return true
  }
  if (
    /\b(today|yesterday|last week|this week|this month|last month|upcoming|tomorrow)\b/.test(
      normalized
    )
  ) {
    return true
  }
  if (/\bnext (week|month|meeting|call)\b/.test(normalized)) return true
  // "what/which meetings ..." inventory style openers start a new scope.
  if (/\b(how many|number of)\b.*\b(meetings?|recordings?|calls?)\b/.test(normalized)) return true
  return false
}

function isAcknowledgement(
  normalized: string,
  tokens: string[],
  hasPriorAssistantTurn: boolean,
  session: ChatTurnSession
): boolean {
  if (tokens.length === 0 || tokens.length > 8) return false
  if (REQUEST_CUE.test(normalized) || MEETING_DATA_CUE.test(normalized)) return false

  // An affirmation answering a clarifying question is NOT a "thank you".
  const hasAffirmation = tokens.some((token) => AFFIRMATION_TERMS.has(token))
  if (hasAffirmation && session.lastTurnWasClarification) return false

  const leftover = tokens.filter(
    (token) => !ACKNOWLEDGEMENT_TERMS.has(token) && !AFFIRMATION_TERMS.has(token)
  )
  if (leftover.length > 0) return false

  // Pure-affirmation turns ("yes", "yep") are not acknowledgements on their own.
  const hasGratitudeTerm = tokens.some((token) => ACKNOWLEDGEMENT_TERMS.has(token))
  if (!hasGratitudeTerm) return false

  const mentionsThanks = tokens.some((token) => isThanksToken(token))
  if (!hasPriorAssistantTurn && !mentionsThanks) return false

  return true
}

function classifySmalltalk(
  normalized: string,
  tokens: string[]
): Extract<ClassifiedTurn, { kind: 'smalltalk' }> | null {
  // Capability / identity questions are small talk even though they read as requests.
  if (
    /\b(what can you do|what do you do|what can you help|who are you|what are you|how do you work|what is this|what are your capabilities)\b/.test(
      normalized
    )
  ) {
    return { kind: 'smalltalk', topic: 'capability' }
  }

  if (tokens.length === 0 || tokens.length > 8) return null
  if (MEETING_DATA_CUE.test(normalized)) return null

  // Well-being / greeting phrases ("how are you?") read as requests because of
  // "how", so they are matched before the generic request-cue guard.
  const hasGreetingPhrase =
    /\b(good morning|good afternoon|good evening|how are you|how are things|how have you been|hows it going|how is it going|whats up|hope you|nice to meet|long time)\b/.test(
      normalized
    )
  if (hasGreetingPhrase && tokens.length <= 6) return { kind: 'smalltalk', topic: 'greeting' }

  if (REQUEST_CUE.test(normalized)) return null

  const hasGreetingWord = tokens.some((token) => GREETING_TERMS.has(token))
  if (!hasGreetingWord) return null

  // Every remaining token must be a greeting/pleasantry filler — otherwise it is
  // a real prompt that merely opens with "hi".
  const leftover = tokens.filter(
    (token) =>
      !GREETING_TERMS.has(token) &&
      !ACKNOWLEDGEMENT_TERMS.has(token) &&
      !SMALLTALK_FILLER.has(token)
  )
  if (leftover.length > 0) return null

  return { kind: 'smalltalk', topic: 'greeting' }
}

const SMALLTALK_FILLER = new Set([
  'are',
  'be',
  'doing',
  'everyone',
  'going',
  'how',
  'hows',
  'is',
  'it',
  'long',
  'meet',
  'nice',
  'there',
  'things',
  'time',
  'to',
  'up',
  'whats',
  'you'
])

function isThanksToken(token: string): boolean {
  return (
    token === 'thanks' ||
    token === 'thank' ||
    token === 'thankyou' ||
    token === 'thx' ||
    token === 'ty' ||
    token === 'ta' ||
    token === 'cheers'
  )
}

// ---------------------------------------------------------------------------
// Count confirmation
// ---------------------------------------------------------------------------

function classifyCountConfirmation(
  normalized: string,
  session: ChatTurnSession
): Extract<ClassifiedTurn, { kind: 'count_confirmation' }> | null {
  if (/\bright now\b/.test(normalized)) return null
  // Real requests (e.g. "show 4 of them") are not confirmations.
  if (REQUEST_CUE.test(normalized) && !/\b(how many|number of)\b/.test(normalized)) return null

  const referencedCount = extractReferencedCount(normalized)
  const hasConfirmationCue =
    /\b(right|correct|accurate|then|total|all|only|just)\b/.test(normalized) ||
    /\b(is that all|that all|all of them|that it|thats it|is that it)\b/.test(normalized)
  const hasCountCue =
    referencedCount != null ||
    /\b(how many|count|number of|all of them|that all|is that all)\b/.test(normalized)
  if (!hasConfirmationCue || !hasCountCue) return null

  const mentionsRecordings = /\brecordings?\b/.test(normalized)
  const mentionsMeetings = /\b(meetings?|calls?|standups?|syncs?)\b/.test(normalized)
  const hasRecordings = session.recordingIds.length > 0
  const hasCalendar = session.calendarEventCount > 0

  if (mentionsRecordings && hasRecordings) {
    return { kind: 'count_confirmation', scope: 'recording', referencedCount }
  }
  if (mentionsMeetings) {
    if (hasCalendar) return { kind: 'count_confirmation', scope: 'calendar', referencedCount }
    if (hasRecordings) return { kind: 'count_confirmation', scope: 'recording', referencedCount }
  }
  if (!mentionsRecordings && !mentionsMeetings) {
    // Implicit subject: use whichever single scope we presented last.
    if (hasCalendar && !hasRecordings) {
      return { kind: 'count_confirmation', scope: 'calendar', referencedCount }
    }
    if (hasRecordings && !hasCalendar) {
      return { kind: 'count_confirmation', scope: 'recording', referencedCount }
    }
  }
  return null
}

export function extractReferencedCount(normalized: string): number | null {
  const numeric = normalized.match(/\b([0-9]{1,3})(?:st|nd|rd|th)?\b/)
  if (numeric) return Number(numeric[1])
  for (const [word, count] of Object.entries(NUMBER_WORDS)) {
    if (new RegExp(`\\b${word}\\b`).test(normalized)) return count
  }
  return null
}

// ---------------------------------------------------------------------------
// Coreference resolution (against the presented ordered list)
// ---------------------------------------------------------------------------

function resolveCoreference(
  normalized: string,
  rawQuestion: string,
  session: ChatTurnSession
): string[] | null {
  const list = session.recordingIds
  if (list.length === 0) return null

  const ordinalIndex = resolveOrdinalIndex(normalized, list.length)
  if (ordinalIndex != null) return [list[ordinalIndex]]

  const titleIds = resolveTitleReference(normalized, rawQuestion, session)
  if (titleIds && titleIds.length > 0) return titleIds

  return null
}

/**
 * Resolve an ordinal reference to a 0-based index, or null.
 *
 * Critically, a *bare* number (e.g. "3 action items", "2 takeaways") is treated
 * as a quantity, NOT an ordinal. A number only counts as an ordinal when it has
 * an ordinal suffix ("3rd"), an ordinal lead-in ("number 3", "#3", "option 3"),
 * or an explicit list anchor ("the 3rd one", "the 3 recording"). Ordinal *words*
 * ("third", "last") always count, but only when a referential anchor is present
 * so unrelated phrasings like "second quarter results" are not hijacked.
 */
export function resolveOrdinalIndex(normalized: string, listLength: number): number | null {
  if (listLength === 0) return null
  const hasAnchor = REFERENTIAL_ANCHOR.test(normalized)

  // "last" / "final" → end of list.
  if (/\b(last|final|latest one|most recent one)\b/.test(normalized) && hasAnchor) {
    return listLength - 1
  }

  // Ordinal words: first, second, ...
  for (const [word, index] of Object.entries(ORDINAL_WORDS)) {
    if (new RegExp(`\\b${word}\\b`).test(normalized) && hasAnchor) {
      return index < listLength ? index : null
    }
  }

  // Suffixed numerals: 1st, 2nd, 3rd, 4th, ...
  const suffixed = normalized.match(/\b([0-9]{1,2})(?:st|nd|rd|th)\b/)
  if (suffixed) {
    const index = Number(suffixed[1]) - 1
    return index >= 0 && index < listLength ? index : null
  }

  // Explicit positional lead-in: "number 3", "#3", "option 2".
  const leadIn = normalized.match(/\b(?:number|option|item|#)\s*([0-9]{1,2})\b/)
  if (leadIn) {
    const index = Number(leadIn[1]) - 1
    return index >= 0 && index < listLength ? index : null
  }

  // "the 3 one(s)" / "the 2 recording" — bare number directly bound to an anchor.
  const boundNumber = normalized.match(
    /\bthe\s+([0-9]{1,2})\s+(one|ones|recording|recordings|meeting|meetings)\b/
  )
  if (boundNumber) {
    const index = Number(boundNumber[1]) - 1
    return index >= 0 && index < listLength ? index : null
  }

  return null
}

/**
 * Resolve a title-style reference like "the calendar auth one" to a recording,
 * but only when a referential anchor is present and exactly one prior title is a
 * distinct best match.
 */
export function resolveTitleReference(
  normalized: string,
  rawQuestion: string,
  session: ChatTurnSession
): string[] | null {
  if (session.recordingIds.length === 0) return null
  if (!REFERENTIAL_ANCHOR.test(normalized)) return null

  const questionTerms = new Set(extractQuestionTerms(rawQuestion))
  if (questionTerms.size === 0) return null

  const scored = session.recordingTitles.map((title, index) => ({
    id: session.recordingIds[index],
    score: distinctiveTitleTokens(title).filter((token) => questionTerms.has(token)).length
  }))

  const best = scored.reduce((a, b) => (b.score > a.score ? b : a), { id: '', score: 0 })
  if (best.score === 0) return null

  const tiedWinners = scored.filter((entry) => entry.score === best.score)
  if (tiedWinners.length !== 1) return null

  return [best.id]
}

function distinctiveTitleTokens(title: string): string[] {
  return normalizeRecordingSearchText(title)
    .split(' ')
    .filter((token) => token.length >= 3 && !GENERIC_TITLE_TOKENS.has(token))
}

// ---------------------------------------------------------------------------
// Scoped follow-up (reuse prior scope without naming a specific item)
// ---------------------------------------------------------------------------

function resolveScopedFollowUp(normalized: string, session: ChatTurnSession): string[] {
  if (!isImplicitFollowUp(normalized)) return []
  if (session.focusedRecordingIds.length > 0) return session.focusedRecordingIds
  if (session.recordingIds.length > 0) return session.recordingIds
  return []
}

export function isImplicitFollowUp(normalized: string): boolean {
  if (
    /\b(anything else|what else|more|details|elaborate|what about that|that meeting|this meeting|it)\b/.test(
      normalized
    )
  ) {
    return true
  }
  const words = normalized.split(' ').filter(Boolean)
  return words.length > 0 && words.length <= 8 && !hasFreshSearchTerms(normalized)
}

export function hasFreshSearchTerms(normalized: string): boolean {
  return extractQuestionTerms(normalized).some((term) => !GENERIC_FOLLOWUP_TERMS.has(term))
}
