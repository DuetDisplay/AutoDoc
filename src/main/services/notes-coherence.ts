// Terminal object pronouns ("resolved it") are grammatical and stay allowed.
const INCOMPLETE_END =
  /\b(?:a|an|and|as|at|because|but|by|for|from|he|if|in|of|on|or|she|that|the|their|them|then|this|to|we|when|where|which|with|you)\s*[.!?]*$/iu

const SUBJECT_GERUND_WITHOUT_AUXILIARY =
  /^(?:i|we|you|he|she|they|it)\s+(?!am\b|are\b|is\b|was\b|were\b|will\b|would\b|have\b|has\b|had\b)[\p{L}'’-]{3,}ing\b/iu

const PLACEHOLDER_SPEAKER_GRAMMAR =
  /\b(?:me\s+and\s+them|them\s+and\s+me|me\s+and\s+him|me\s+and\s+her)\b/iu

const REPEATED_ADJACENT_WORD = /\b([\p{L}]{2,})\s+\1\b/iu

/** ASR stitches replay short phrases: "an update as to As to when ...". */
const REPEATED_ADJACENT_BIGRAM = /\b([\p{L}'’]+)\s+([\p{L}'’]+)\s+\1\s+\2\b/iu

/** An article directly followed by a conjunction or copula is a splice, never grammar. */
const ARTICLE_CONJUNCTION_COLLISION = /\bthe\s+(?:and|but|is|was)\b/iu

const BARE_PARTICIPLE_PREPOSITION =
  /^[\p{L}'’-]{4,}(?:ed|en)\s+(?:at|by|for|from|in|into|of|on|onto|to|with)\b/iu

const TEMPORAL_OR_QUANTIFIED_ANCHOR =
  /(?:\b\d+(?:[.,]\d+)?\b|%|\b(?:today|tomorrow|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b)/iu

const ONLY_DEICTIC_STATUS =
  /^(?:it|that|this|they|those|these)\s+(?:is|are|was|were|seems?|looks?|works?|worked)\s+(?:good|okay|ok|fine|better|worse|now|there|here|done|working)(?:\s+(?:now|there|here))?\.?$/iu

const BROKEN_DISCOURSE_TAIL =
  /\b(?:that|when|where|which)\s+(?:and|but|okay|ok|right|so|yeah)\s*[.!?]*$/iu

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu

const REPLACEMENT_CHAR = /\uFFFD/u
/** Latin-extended or symbol jammed into an otherwise ASCII token: KeŰ, GetŰorant. */
const INWORD_MOJIBAKE = /[A-Za-z][^\x00-\x7F\s]/u
const EMPTY_TASK =
  /^(?:ask you(?: a question)?|give some feedback|make sure we do this(?: properly)?)\b/iu
const LEADING_DISFLUENCY = /^(?:um+|uh+|uhh|er+|ah+)\b/iu
const UNRESOLVED_COMPARISON =
  /\b(?:the same as|still the same|same as yesterday|same as today|do this properly)\b/iu
const LEADING_DEIXIS = /^(?:it|this|that|they|those|these)\b/iu
const NUMBER_OR_PERCENT = /(?:\b\d+(?:[.,]\d+)?\b|%)/u

/**
 * Rejects transcript-shaped fragments that are readable as speech but not as
 * standalone notes. It intentionally avoids style rewriting: surviving text
 * remains exactly what the grounded writer or transcript recovery produced.
 */
export function noteTextLooksCoherent(text: string): boolean {
  const compact = text.replace(/\s+/gu, ' ').trim()
  if (!compact) return false
  const words = compact.match(WORD) ?? []
  if (words.length < 2) return false
  if (INCOMPLETE_END.test(compact)) return false
  if (SUBJECT_GERUND_WITHOUT_AUXILIARY.test(compact)) return false
  if (PLACEHOLDER_SPEAKER_GRAMMAR.test(compact)) return false
  if (REPEATED_ADJACENT_WORD.test(compact)) return false
  if (REPEATED_ADJACENT_BIGRAM.test(compact)) return false
  if (ARTICLE_CONJUNCTION_COLLISION.test(compact)) return false
  if (ONLY_DEICTIC_STATUS.test(compact)) return false
  if (BROKEN_DISCOURSE_TAIL.test(compact)) return false
  if (BARE_PARTICIPLE_PREPOSITION.test(compact) && !TEMPORAL_OR_QUANTIFIED_ANCHOR.test(compact)) {
    return false
  }
  return true
}

export function noteTextLooksCorrupted(text: string): boolean {
  const compact = text.replace(/\s+/gu, ' ').trim()
  if (!compact) return false
  return REPLACEMENT_CHAR.test(compact) || INWORD_MOJIBAKE.test(compact)
}

export function noteRecordNeedsReview(text: string): boolean {
  const compact = text.replace(/\s+/gu, ' ').trim()
  if (noteTextLooksCorrupted(compact)) return true
  if (!noteTextLooksCoherent(compact)) return true
  if (EMPTY_TASK.test(compact)) return true
  return LEADING_DISFLUENCY.test(compact)
}

export function noteSubjectIsResolved(
  text: string,
  title?: string | null,
  topic?: string | null
): boolean {
  const compact = text.replace(/\s+/gu, ' ').trim()
  const heading = title?.trim() ?? ''
  const chapter = topic?.trim() ?? ''
  if (noteRecordNeedsReview(compact)) return false
  if (UNRESOLVED_COMPARISON.test(compact) && !chapter && !NUMBER_OR_PERCENT.test(compact)) {
    return false
  }
  if (LEADING_DEIXIS.test(compact) && !chapter && heading.length < 8) return false
  if (chapter || heading.length >= 8) return true
  return !LEADING_DEIXIS.test(compact)
}
