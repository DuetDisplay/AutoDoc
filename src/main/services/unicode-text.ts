export interface UnicodeWordSegment {
  segment: string
  index: number
}

const fallbackWordPattern = /[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu

function createWordSegmenter(): Intl.Segmenter | null {
  try {
    return new Intl.Segmenter(undefined, { granularity: 'word' })
  } catch {
    return null
  }
}

const wordSegmenter = createWordSegmenter()

/**
 * Splits text into Unicode-aware words. Unlike ASCII classes or `\b` (which is
 * ASCII-only in JavaScript even with the `u` flag), this keeps Greek, Cyrillic,
 * and accented Latin words whole.
 */
export function segmentUnicodeWords(text: string): UnicodeWordSegment[] {
  if (wordSegmenter) {
    return [...wordSegmenter.segment(text)]
      .filter((part) => part.isWordLike && /[\p{L}\p{N}]/u.test(part.segment))
      .map((part) => ({ segment: part.segment, index: part.index }))
  }

  return [...text.matchAll(fallbackWordPattern)].map((match) => ({
    segment: match[0],
    index: match.index ?? 0
  }))
}

export function tokenizeUnicodeWords(text: string): string[] {
  return segmentUnicodeWords(text).map((part) => part.segment)
}

/**
 * Keeps lexical matching useful across scripts without treating one-letter
 * particles as evidence anchors. ASCII-only tokens keep the English minimum.
 */
export function isSubstantiveUnicodeToken(token: string, asciiMinLength = 4): boolean {
  const normalized = token.normalize('NFKC')
  const letterOrNumberCount = [...normalized].filter((character) =>
    /[\p{L}\p{N}]/u.test(character)
  ).length
  const containsNonAsciiLetterOrNumber = [...normalized].some(
    (character) => (character.codePointAt(0) ?? 0) > 0x7f && /[\p{L}\p{N}]/u.test(character)
  )
  return containsNonAsciiLetterOrNumber
    ? letterOrNumberCount >= 2
    : letterOrNumberCount >= asciiMinLength
}

const CJK_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

/** Han, kana, or hangul: one character carries what several Latin letters do. */
export function containsCjk(text: string): boolean {
  return CJK_SCRIPT.test(text)
}

/** NFKC, lowercased, substantive words. No stemming: suffix rules are language-specific. */
export function unicodeContentTokens(text: string, asciiMinLength = 4): string[] {
  return tokenizeUnicodeWords(text.normalize('NFKC').toLowerCase()).filter((token) =>
    isSubstantiveUnicodeToken(token, asciiMinLength)
  )
}
