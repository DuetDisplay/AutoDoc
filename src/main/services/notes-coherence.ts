const INCOMPLETE_END =
  /\b(?:a|an|and|as|at|because|but|by|for|from|he|if|in|it|of|on|or|she|that|the|their|them|then|this|to|we|when|where|which|with|you)\s*[.!?]*$/iu

const SUBJECT_GERUND_WITHOUT_AUXILIARY =
  /^(?:i|we|you|he|she|they|it)\s+(?!am\b|are\b|is\b|was\b|were\b|will\b|would\b|have\b|has\b|had\b)[\p{L}'’-]{3,}ing\b/iu

const PLACEHOLDER_SPEAKER_GRAMMAR =
  /\b(?:me\s+and\s+them|them\s+and\s+me|me\s+and\s+him|me\s+and\s+her)\b/iu

const REPEATED_ADJACENT_WORD = /\b([\p{L}]{2,})\s+\1\b/iu

const BARE_PARTICIPLE_PREPOSITION =
  /^[\p{L}'’-]{4,}(?:ed|en)\s+(?:at|by|for|from|in|into|of|on|onto|to|with)\b/iu

const TEMPORAL_OR_QUANTIFIED_ANCHOR =
  /(?:\b\d+(?:[.,]\d+)?\b|%|\b(?:today|tomorrow|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b)/iu

const ONLY_DEICTIC_STATUS =
  /^(?:it|that|this|they|those|these)\s+(?:is|are|was|were|seems?|looks?|works?|worked)\s+(?:good|okay|ok|fine|better|worse|now|there|here|done|working)(?:\s+(?:now|there|here))?\.?$/iu

const BROKEN_DISCOURSE_TAIL =
  /\b(?:that|when|where|which)\s+(?:and|but|okay|ok|right|so|yeah)\s*[.!?]*$/iu

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu

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
  if (ONLY_DEICTIC_STATUS.test(compact)) return false
  if (BROKEN_DISCOURSE_TAIL.test(compact)) return false
  if (BARE_PARTICIPLE_PREPOSITION.test(compact) && !TEMPORAL_OR_QUANTIFIED_ANCHOR.test(compact)) {
    return false
  }
  return true
}
