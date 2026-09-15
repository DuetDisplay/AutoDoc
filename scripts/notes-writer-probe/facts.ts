/**
 * Deterministic number / proper-name extraction for Arm E restyle guards.
 * Synthetic-safe: no meeting-specific lists.
 */

const NAME_STOP = new Set([
  'The',
  'This',
  'That',
  'These',
  'Those',
  'There',
  'Then',
  'Than',
  'When',
  'What',
  'Which',
  'Who',
  'How',
  'Why',
  'Where',
  'We',
  'I',
  'A',
  'An',
  'If',
  'So',
  'But',
  'And',
  'For',
  'On',
  'In',
  'At',
  'To',
  'Of',
  'Or',
  'As',
  'My',
  'No',
  'It',
  'Its',
  'You',
  'Your',
  'They',
  'Their',
  'Them',
  'Yes',
  'Okay',
  'Also',
  'Just',
  'With',
  'From',
  'Into',
  'After',
  'Before',
  'During',
  'About',
  'Over',
  'Under',
  'Most',
  'Some',
  'All',
  'Each',
  'Every',
  'Other',
  'More',
  'Less',
  'Very',
  'Still',
  'Once',
  'Next',
  'Last',
  'First',
  'New',
  'Old',
  'Good',
  'Bad',
  'Not',
  'Owner',
  'Due',
  'Notes',
  'Meeting',
  'However',
  'Regardless',
  'Recent',
  'Review',
  'Tasks',
  'Steps',
  'Pros',
  'Cons',
  'Status',
  'Updates',
  'Information',
  'Discussion',
  'Action',
  'Items',
  'Background',
  'Summary',
  'Agenda',
  'Considerations',
  'Aims',
  'Relies',
  'Highlights',
  'Makes',
  'Would',
  'Considering',
  'Making',
  'Remaining',
  'Description',
  'Downed',
  'Positive',
  'Results',
  'Comparison',
  'Has',
  'Adding',
  'Identified',
  'Task'
])

const NUMBER_PATTERN =
  /\$?\d+(?:,\d{3})*(?:\.\d+)*(?:\s*[-–]\s*\$?\d+(?:,\d{3})*(?:\.\d+)*)?%?/gu

/** Max Title Case tokens treated as one required name. Longer heading runs are ignored. */
const MAX_NAME_WORDS = 4

/** Endpoints of a range must appear within this many characters (inclusive span). */
const RANGE_WINDOW = 40

export interface FactSet {
  numbers: string[]
  names: string[]
}

function uniquePreserve(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
  }
  return out
}

function titled(token: string): string {
  if (token.length === 0) return token
  return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase()
}

export function isNameStop(token: string): boolean {
  return NAME_STOP.has(token) || NAME_STOP.has(titled(token))
}

export function stripFactMarkup(text: string): string {
  return text
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/[*_~`#]+/gu, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
}

function contentNameTokens(name: string): string[] {
  return name
    .split(/\s+/u)
    .map((token) => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter((token) => token.length > 0 && !isNameStop(token))
}

export function extractNumbers(text: string): string[] {
  const matches = stripFactMarkup(text).match(NUMBER_PATTERN) ?? []
  return uniquePreserve(matches.map((value) => value.replace(/\s+/gu, '')))
}

const TITLE_TOKEN = /\b[A-Z][a-z]{2,}\b/gu
const ACRONYM_TOKEN = /\b[A-Z]{2,}\b/gu

function sentencePrefix(text: string, index: number): string {
  if (index <= 0) return ''
  const lineStart = text.lastIndexOf('\n', index - 1) + 1
  const before = text.slice(0, index)
  const lastTerm = Math.max(
    before.lastIndexOf('. '),
    before.lastIndexOf('? '),
    before.lastIndexOf('! ')
  )
  const start = lastTerm >= lineStart ? lastTerm + 2 : lineStart
  return text
    .slice(start, index)
    .replace(/^[ \t]*/u, '')
    .replace(/^[-+•][ \t]+/u, '')
    .replace(/^\d+[.)][ \t]+/u, '')
}

/**
 * True mid-sentence: a lowercase word already appeared in this sentence.
 * An opening Title Case run (bullet/heading/sentence-initial) is not a witness.
 */
function isTrueMidSentence(text: string, index: number): boolean {
  return /\b[a-z]{2,}\b/u.test(sentencePrefix(text, index))
}

/** Title-case tokens that appear capitalized after lowercase text, plus parenthetical vocatives. */
function knownEntityKeys(cleaned: string): Set<string> {
  const known = new Set<string>()
  for (const match of cleaned.matchAll(new RegExp(TITLE_TOKEN.source, 'gu'))) {
    const token = match[0]
    const index = match.index ?? 0
    if (isNameStop(token)) continue
    if (isTrueMidSentence(cleaned, index)) known.add(token.toLowerCase())
  }
  for (const match of cleaned.matchAll(/\(([^)]+)\)/gu)) {
    const inner = match[1] ?? ''
    for (const token of inner.match(new RegExp(TITLE_TOKEN.source, 'gu')) ?? []) {
      if (!isNameStop(token)) known.add(token.toLowerCase())
    }
  }
  return known
}

function spanIsName(span: string, line: string, known: Set<string>): boolean {
  if (contentNameTokens(span).length === 0) return false
  const index = line.search(new RegExp(`\\b${escapeRegExp(span)}\\b`, 'u'))
  if (index >= 0 && isTrueMidSentence(line, index)) return true
  return contentNameTokens(span).some((token) => known.has(token.toLowerCase()))
}

export function extractProperNames(text: string): string[] {
  const names: string[] = []
  const cleaned = stripFactMarkup(text)
  const known = knownEntityKeys(cleaned)
  const extra = Math.max(1, MAX_NAME_WORDS - 1)
  const multiPattern = new RegExp(`\\b[A-Z][a-z]+(?:[^\\S\\n]+[A-Z][a-z]+){1,${extra}}\\b`, 'gu')
  for (const line of cleaned.split(/\r?\n/u)) {
    const multi = line.match(multiPattern) ?? []
    for (const span of multi) {
      if (spanIsName(span, line, known)) names.push(span)
    }
    for (const match of line.matchAll(new RegExp(TITLE_TOKEN.source, 'gu'))) {
      const token = match[0]
      if (isNameStop(token)) continue
      if (isTrueMidSentence(line, match.index ?? 0) || known.has(token.toLowerCase())) {
        names.push(token)
      }
    }
    for (const token of line.match(new RegExp(ACRONYM_TOKEN.source, 'gu')) ?? []) {
      if (!isNameStop(token)) names.push(token)
    }
  }
  return uniquePreserve(names)
}

export function extractFacts(text: string): FactSet {
  return {
    numbers: extractNumbers(text),
    names: extractProperNames(text)
  }
}

function normalizeHaystack(text: string): string {
  return stripFactMarkup(text).toLowerCase().replace(/[–—]/gu, '-')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function findAll(haystack: string, needle: string): number[] {
  if (needle.length === 0) return []
  const positions: number[] = []
  let from = 0
  while (from <= haystack.length - needle.length) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) break
    positions.push(at)
    from = at + 1
  }
  return positions
}

function endpointsInWindow(haystack: string, left: string, right: string, wantPercent: boolean): boolean {
  const leftHits = findAll(haystack, left)
  const rightHits = findAll(haystack, right)
  for (const leftAt of leftHits) {
    for (const rightAt of rightHits) {
      if (leftAt === rightAt && left === right) continue
      const start = Math.min(leftAt, rightAt)
      const end = Math.max(leftAt + left.length, rightAt + right.length)
      if (end - start > RANGE_WINDOW) continue
      if (!wantPercent) return true
      const padStart = Math.max(0, start - 8)
      const padEnd = Math.min(haystack.length, end + 12)
      if (/%|\bpercent\b/u.test(haystack.slice(padStart, padEnd))) return true
    }
  }
  return false
}

function numberPresent(number: string, haystack: string): boolean {
  const hay = haystack.replace(/,/gu, '')
  const needle = number.toLowerCase().replace(/[–—]/gu, '-').replace(/,/gu, '')
  if (hay.includes(needle)) return true
  const compact = needle.replace(/\s+/gu, '')
  if (compact !== needle && hay.includes(compact)) return true
  const range = compact.match(/^\$?(\d+(?:\.\d+)*)[-–]\$?(\d+(?:\.\d+)*)(%?)$/u)
  if (range) {
    const left = range[1] ?? ''
    const right = range[2] ?? ''
    const percent = (range[3] ?? '').length > 0
    if (endpointsInWindow(hay, left, right, percent)) return true
  }
  const money = compact.match(/^\$(\d+(?:\.\d+)*)$/u)
  if (money) {
    const amount = money[1] ?? ''
    if (hay.includes(`$${amount}`)) return true
    const amountHits = findAll(hay, amount)
    for (const at of amountHits) {
      const slice = hay.slice(Math.max(0, at - 12), at + amount.length + 16)
      if (/\$|dollar|dollars|\busd\b/u.test(slice)) return true
    }
  }
  return false
}

function namePresent(name: string, haystack: string): boolean {
  const lowered = stripFactMarkup(name).toLowerCase().replace(/\s+/gu, ' ').trim()
  if (lowered.length === 0) return true
  if (haystack.includes(lowered)) return true
  const tokens = contentNameTokens(name)
  if (tokens.length === 0) return true
  return tokens.every((token) => new RegExp(`\\b${escapeRegExp(token.toLowerCase())}\\b`, 'u').test(haystack))
}

export function missingFacts(input: string, output: string): FactSet {
  const facts = extractFacts(input)
  const haystack = normalizeHaystack(output)
  return {
    numbers: facts.numbers.filter((number) => !numberPresent(number, haystack)),
    names: facts.names.filter((name) => !namePresent(name, haystack))
  }
}

export function factsPass(input: string, output: string): boolean {
  const missing = missingFacts(input, output)
  return missing.numbers.length === 0 && missing.names.length === 0
}

/** Facts in `candidate` that are not grounded in `source`. */
export function extraFacts(source: string, candidate: string): FactSet {
  return missingFacts(candidate, source)
}

export function ungroundedPass(source: string, candidate: string): boolean {
  const extra = extraFacts(source, candidate)
  return extra.numbers.length === 0 && extra.names.length === 0
}
