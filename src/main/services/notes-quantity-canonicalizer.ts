/**
 * Dependency-free quantitative grounding helpers.
 *
 * Extraction is deliberately typed: `12%`, `12 users`, and `version 12` share
 * a numeral but do not make the same claim. Mentions retain source order and
 * duplicates so callers can choose whether evidence occurrences may be reused.
 */

export type QuantityMentionKind =
  | 'number'
  | 'percentage'
  | 'version'
  | 'ratio'
  | 'currency'
  | 'unit'
  | 'range'

export type QuantityNotation = 'digits' | 'words' | 'digit-sequence' | 'dotted' | 'mixed'

export interface QuantityMention {
  kind: QuantityMentionKind
  /** A type-qualified, representation-independent comparison key. */
  canonical: string
  /** Preferred textual equivalents, ordered from compact to conversational. */
  aliases: readonly string[]
  raw: string
  start: number
  end: number
  values: readonly string[]
  notation: QuantityNotation
  unit?: string
  currency?: string
  rangeKind?: Exclude<QuantityMentionKind, 'range'>
}

export interface QuantityMentionMatch {
  summary: QuantityMention
  evidence: QuantityMention | null
  evidenceIndex: number | null
}

export interface QuantityGroundingOptions {
  /**
   * When true, one evidence occurrence can support only one summary occurrence.
   * The default allows reuse because notes commonly repeat a grounded metric in
   * both an overview and a detail section.
   */
  consumeEvidenceMentions?: boolean
}

export interface QuantityGroundingResult {
  supported: boolean
  summaryMentions: readonly QuantityMention[]
  evidenceMentions: readonly QuantityMention[]
  matches: readonly QuantityMentionMatch[]
  unsupported: readonly QuantityMention[]
}

interface Token {
  raw: string
  lower: string
  start: number
  end: number
  type: 'number' | 'word' | 'symbol' | 'separator'
}

interface NumericAtom {
  value: string
  startToken: number
  endToken: number
  notation: Exclude<QuantityNotation, 'dotted' | 'mixed'>
  sequenceDigits?: readonly string[]
}

interface ParsedMention {
  mention: QuantityMention
  endToken: number
}

interface Endpoint {
  atom: NumericAtom
  endToken: number
  kind: 'number' | 'percentage' | 'unit'
  unit?: string
}

const DIGIT_WORDS: Readonly<Record<string, number>> = {
  zero: 0,
  oh: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9
}

const SMALL_NUMBER_WORDS: Readonly<Record<string, number>> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19
}

const TENS_WORDS: Readonly<Record<string, number>> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90
}

const LARGE_SCALES: Readonly<Record<string, bigint>> = {
  thousand: 1_000n,
  million: 1_000_000n,
  billion: 1_000_000_000n,
  trillion: 1_000_000_000_000n
}

const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = {
  $: 'USD',
  '€': 'EUR',
  '£': 'GBP',
  '¥': 'JPY',
  '₹': 'INR',
  '₩': 'KRW'
}

const CURRENCY_WORDS: Readonly<Record<string, string>> = {
  usd: 'USD',
  dollar: 'USD',
  dollars: 'USD',
  buck: 'USD',
  bucks: 'USD',
  eur: 'EUR',
  euro: 'EUR',
  euros: 'EUR',
  gbp: 'GBP',
  pound: 'GBP',
  pounds: 'GBP',
  sterling: 'GBP',
  jpy: 'JPY',
  yen: 'JPY',
  cny: 'CNY',
  yuan: 'CNY',
  rmb: 'CNY',
  inr: 'INR',
  rupee: 'INR',
  rupees: 'INR',
  krw: 'KRW',
  won: 'KRW',
  cad: 'CAD',
  aud: 'AUD',
  chf: 'CHF'
}

const CURRENCY_DISPLAY: Readonly<
  Record<string, { symbol?: string; singular: string; plural: string }>
> = {
  USD: { symbol: '$', singular: 'dollar', plural: 'dollars' },
  EUR: { symbol: '€', singular: 'euro', plural: 'euros' },
  GBP: { symbol: '£', singular: 'pound', plural: 'pounds' },
  JPY: { symbol: '¥', singular: 'yen', plural: 'yen' },
  CNY: { singular: 'yuan', plural: 'yuan' },
  INR: { symbol: '₹', singular: 'rupee', plural: 'rupees' },
  KRW: { symbol: '₩', singular: 'won', plural: 'won' },
  CAD: { singular: 'Canadian dollar', plural: 'Canadian dollars' },
  AUD: { singular: 'Australian dollar', plural: 'Australian dollars' },
  CHF: { singular: 'Swiss franc', plural: 'Swiss francs' }
}

const MAGNITUDES: Readonly<Record<string, number>> = {
  k: 3,
  thousand: 3,
  m: 6,
  million: 6,
  b: 9,
  billion: 9,
  trillion: 12
}

const UNIT_ALIASES: Readonly<Record<string, string>> = {
  ms: 'millisecond',
  msec: 'millisecond',
  msecs: 'millisecond',
  millisecond: 'millisecond',
  milliseconds: 'millisecond',
  s: 'second',
  sec: 'second',
  secs: 'second',
  second: 'second',
  seconds: 'second',
  min: 'minute',
  mins: 'minute',
  minute: 'minute',
  minutes: 'minute',
  h: 'hour',
  hr: 'hour',
  hrs: 'hour',
  hour: 'hour',
  hours: 'hour',
  day: 'day',
  days: 'day',
  week: 'week',
  weeks: 'week',
  month: 'month',
  months: 'month',
  year: 'year',
  years: 'year',
  b: 'byte',
  byte: 'byte',
  bytes: 'byte',
  kb: 'kilobyte',
  kilobyte: 'kilobyte',
  kilobytes: 'kilobyte',
  mb: 'megabyte',
  megabyte: 'megabyte',
  megabytes: 'megabyte',
  gb: 'gigabyte',
  gigabyte: 'gigabyte',
  gigabytes: 'gigabyte',
  tb: 'terabyte',
  terabyte: 'terabyte',
  terabytes: 'terabyte',
  kib: 'kibibyte',
  mib: 'mebibyte',
  gib: 'gibibyte',
  tib: 'tebibyte',
  hz: 'hertz',
  khz: 'kilohertz',
  mhz: 'megahertz',
  ghz: 'gigahertz',
  bps: 'bit-per-second',
  kbps: 'kilobit-per-second',
  mbps: 'megabit-per-second',
  gbps: 'gigabit-per-second',
  px: 'pixel',
  pixel: 'pixel',
  pixels: 'pixel',
  dpi: 'dpi',
  fps: 'frame-per-second',
  x: 'times',
  time: 'times',
  times: 'times',
  user: 'user',
  users: 'user',
  trial: 'trial',
  trials: 'trial',
  subscriber: 'subscriber',
  subscribers: 'subscriber',
  customer: 'customer',
  customers: 'customer',
  device: 'device',
  devices: 'device',
  build: 'build',
  builds: 'build',
  item: 'item',
  items: 'item',
  person: 'person',
  people: 'person',
  meter: 'meter',
  meters: 'meter',
  metre: 'meter',
  metres: 'meter',
  km: 'kilometer',
  kilometer: 'kilometer',
  kilometers: 'kilometer',
  kilometre: 'kilometer',
  kilometres: 'kilometer',
  ft: 'foot',
  foot: 'foot',
  feet: 'foot',
  inch: 'inch',
  inches: 'inch'
}

const UNIT_DISPLAY_ALIASES: Readonly<Record<string, readonly string[]>> = {
  millisecond: ['ms', 'millisecond', 'milliseconds'],
  second: ['s', 'second', 'seconds'],
  minute: ['min', 'minute', 'minutes'],
  hour: ['hr', 'hour', 'hours'],
  day: ['day', 'days'],
  week: ['week', 'weeks'],
  month: ['month', 'months'],
  year: ['year', 'years'],
  byte: ['B', 'byte', 'bytes'],
  kilobyte: ['KB', 'kilobyte', 'kilobytes'],
  megabyte: ['MB', 'megabyte', 'megabytes'],
  gigabyte: ['GB', 'gigabyte', 'gigabytes'],
  terabyte: ['TB', 'terabyte', 'terabytes'],
  kibibyte: ['KiB', 'kibibyte', 'kibibytes'],
  mebibyte: ['MiB', 'mebibyte', 'mebibytes'],
  gibibyte: ['GiB', 'gibibyte', 'gibibytes'],
  tebibyte: ['TiB', 'tebibyte', 'tebibytes'],
  hertz: ['Hz', 'hertz'],
  kilohertz: ['kHz', 'kilohertz'],
  megahertz: ['MHz', 'megahertz'],
  gigahertz: ['GHz', 'gigahertz'],
  'bit-per-second': ['bps', 'bits per second'],
  'kilobit-per-second': ['kbps', 'kilobits per second'],
  'megabit-per-second': ['Mbps', 'megabits per second'],
  'gigabit-per-second': ['Gbps', 'gigabits per second'],
  pixel: ['px', 'pixel', 'pixels'],
  dpi: ['dpi'],
  'frame-per-second': ['fps', 'frames per second'],
  times: ['x', 'times'],
  user: ['user', 'users'],
  trial: ['trial', 'trials'],
  subscriber: ['subscriber', 'subscribers'],
  customer: ['customer', 'customers'],
  device: ['device', 'devices'],
  build: ['build', 'builds'],
  item: ['item', 'items'],
  person: ['person', 'people'],
  meter: ['m', 'meter', 'meters'],
  kilometer: ['km', 'kilometer', 'kilometers'],
  foot: ['ft', 'foot', 'feet'],
  inch: ['in', 'inch', 'inches']
}

const VERSION_PREFIXES = new Set(['v', 'version', 'release', 'build'])
const VERSION_SUFFIXES = new Set(['version', 'release', 'build'])
const RANGE_JOINERS = new Set(['to', 'through'])

function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  const pattern = /[$€£¥₹₩%°]|[A-Za-z]+(?:'[A-Za-z]+)?|\d[\d,]*|[-+./:–—]/g
  for (const match of text.matchAll(pattern)) {
    if (match.index == null) continue
    const raw = match[0]
    let type: Token['type']
    if (/^\d/.test(raw)) type = 'number'
    else if (/^[A-Za-z]/.test(raw)) type = 'word'
    else if (/^[./:–—-]$/.test(raw)) type = 'separator'
    else type = 'symbol'
    tokens.push({
      raw,
      lower: raw.toLowerCase(),
      start: match.index,
      end: match.index + raw.length,
      type
    })
  }
  return tokens
}

function whitespaceConnected(text: string, left: Token, right: Token): boolean {
  return /^\s*$/.test(text.slice(left.end, right.start))
}

function nextWordAcrossOptionalHyphen(
  text: string,
  tokens: readonly Token[],
  currentIndex: number
): number | null {
  const current = tokens[currentIndex]
  const next = tokens[currentIndex + 1]
  if (!current || !next) return null
  if (next.type === 'word' && whitespaceConnected(text, current, next)) return currentIndex + 1
  const after = tokens[currentIndex + 2]
  if (
    next.raw === '-' &&
    after?.type === 'word' &&
    whitespaceConnected(text, current, next) &&
    whitespaceConnected(text, next, after)
  ) {
    return currentIndex + 2
  }
  return null
}

function normalizeInteger(raw: string): string | null {
  const digits = raw.replace(/,/g, '')
  if (!/^\d+$/.test(digits)) return null
  return digits.replace(/^0+(?=\d)/, '')
}

function normalizeDecimal(integer: string, fraction: string): string | null {
  const left = normalizeInteger(integer)
  const right = fraction.replace(/,/g, '')
  if (left == null || !/^\d+$/.test(right)) return null
  const trimmed = right.replace(/0+$/, '')
  return trimmed ? `${left}.${trimmed}` : left
}

function scaleDecimal(value: string, power: number): string {
  const [integer, fraction = ''] = value.split('.')
  const digits = `${integer}${fraction}`.replace(/^0+(?=\d)/, '') || '0'
  const remainingFraction = fraction.length - power
  if (remainingFraction <= 0)
    return `${digits}${'0'.repeat(-remainingFraction)}`.replace(/^0+(?=\d)/, '')
  const padded = digits.padStart(remainingFraction + 1, '0')
  const split = padded.length - remainingFraction
  return normalizeDecimal(padded.slice(0, split), padded.slice(split)) ?? value
}

function nextConnectedToken(
  text: string,
  tokens: readonly Token[],
  currentIndex: number
): number | null {
  const current = tokens[currentIndex]
  const next = tokens[currentIndex + 1]
  return current && next && whitespaceConnected(text, current, next) ? currentIndex + 1 : null
}

function readSequentialWordDigits(
  text: string,
  tokens: readonly Token[],
  startToken: number
): NumericAtom | null {
  const first = tokens[startToken]
  if (!first || DIGIT_WORDS[first.lower] == null) return null
  const digits = [String(DIGIT_WORDS[first.lower])]
  let current = startToken
  while (true) {
    const nextIndex = nextWordAcrossOptionalHyphen(text, tokens, current)
    const next = nextIndex == null ? null : tokens[nextIndex]
    if (!next || DIGIT_WORDS[next.lower] == null) break
    digits.push(String(DIGIT_WORDS[next.lower]))
    current = nextIndex!
  }
  if (digits.length < 2) return null
  return {
    value: digits.join('').replace(/^0+(?=\d)/, ''),
    startToken,
    endToken: current,
    notation: 'digit-sequence',
    sequenceDigits: digits
  }
}

function readCardinalWords(
  text: string,
  tokens: readonly Token[],
  startToken: number
): NumericAtom | null {
  const first = tokens[startToken]
  if (!first?.lower || first.type !== 'word') return null

  let total = 0n
  let group = 0n
  let current = startToken
  let lastAccepted = startToken - 1
  let lastKind: 'start' | 'small' | 'tens' | 'hundred' | 'scale' | 'and' = 'start'
  let lastLargeScale: bigint | null = null
  let accepted = 0

  while (true) {
    const token = tokens[current]
    if (!token || token.type !== 'word') break
    const word = token.lower
    const small = SMALL_NUMBER_WORDS[word]
    const tens = TENS_WORDS[word]
    const scale = LARGE_SCALES[word]

    if (word === 'and') {
      if ((lastKind !== 'hundred' && lastKind !== 'scale') || accepted === 0) break
      lastKind = 'and'
    } else if (small != null) {
      const canFollow =
        lastKind === 'start' ||
        lastKind === 'hundred' ||
        lastKind === 'scale' ||
        lastKind === 'and' ||
        (lastKind === 'tens' && small > 0 && small < 10)
      if (!canFollow) break
      group += BigInt(small)
      lastKind = 'small'
      accepted += 1
    } else if (tens != null) {
      const canFollow =
        lastKind === 'start' || lastKind === 'hundred' || lastKind === 'scale' || lastKind === 'and'
      if (!canFollow) break
      group += BigInt(tens)
      lastKind = 'tens'
      accepted += 1
    } else if (word === 'hundred') {
      if (group <= 0n || lastKind !== 'small') break
      group *= 100n
      lastKind = 'hundred'
      accepted += 1
    } else if (scale != null) {
      if (group <= 0n || (lastLargeScale != null && scale >= lastLargeScale)) break
      total += group * scale
      group = 0n
      lastLargeScale = scale
      lastKind = 'scale'
      accepted += 1
    } else {
      break
    }

    lastAccepted = current
    const next = nextWordAcrossOptionalHyphen(text, tokens, current)
    if (next == null) break
    current = next
  }

  if (accepted === 0 || lastKind === 'and') return null
  return {
    value: String(total + group),
    startToken,
    endToken: lastAccepted,
    notation: 'words'
  }
}

function readNumericAtom(
  text: string,
  tokens: readonly Token[],
  startToken: number
): NumericAtom | null {
  const first = tokens[startToken]
  if (!first) return null
  const sign =
    first.raw === '-' || first.lower === 'negative' || first.lower === 'minus'
      ? '-'
      : first.raw === '+' || first.lower === 'positive' || first.lower === 'plus'
        ? '+'
        : null
  if (sign) {
    const valueStart = nextConnectedToken(text, tokens, startToken)
    if (valueStart == null) return null
    const unsigned = readNumericAtom(text, tokens, valueStart)
    if (!unsigned) return null
    return {
      ...unsigned,
      value: `${sign}${unsigned.value}`,
      startToken
    }
  }
  if (first.type === 'number') {
    const integer = normalizeInteger(first.raw)
    if (integer == null) return null
    let atom: NumericAtom
    const dot = tokens[startToken + 1]
    const fraction = tokens[startToken + 2]
    if (
      dot?.raw === '.' &&
      fraction?.type === 'number' &&
      whitespaceConnected(text, first, dot) &&
      whitespaceConnected(text, dot, fraction)
    ) {
      const decimal = normalizeDecimal(first.raw, fraction.raw)
      if (decimal != null) {
        atom = {
          value: decimal,
          startToken,
          endToken: startToken + 2,
          notation: 'digits'
        }
      } else {
        atom = { value: integer, startToken, endToken: startToken, notation: 'digits' }
      }
    } else {
      atom = { value: integer, startToken, endToken: startToken, notation: 'digits' }
    }

    const magnitudeIndex = nextConnectedToken(text, tokens, atom.endToken)
    const magnitude = magnitudeIndex == null ? null : tokens[magnitudeIndex]
    const power = magnitude ? MAGNITUDES[magnitude.lower] : undefined
    if (power != null && magnitude && (magnitude.lower.length > 1 || magnitude.lower === 'k')) {
      return {
        ...atom,
        value: scaleDecimal(atom.value, power),
        endToken: magnitudeIndex!
      }
    }
    return atom
  }

  const sequential = readSequentialWordDigits(text, tokens, startToken)
  if (sequential) return sequential

  const cardinal = readCardinalWords(text, tokens, startToken)
  if (!cardinal) return null
  const pointIndex = nextConnectedToken(text, tokens, cardinal.endToken)
  if (pointIndex == null || tokens[pointIndex]?.lower !== 'point') return cardinal

  const fractionDigits: string[] = []
  let current = pointIndex
  while (true) {
    const nextIndex = nextConnectedToken(text, tokens, current)
    const next = nextIndex == null ? null : tokens[nextIndex]
    if (!next || DIGIT_WORDS[next.lower] == null) break
    fractionDigits.push(String(DIGIT_WORDS[next.lower]))
    current = nextIndex!
  }
  if (fractionDigits.length === 0) return cardinal
  return {
    value: normalizeDecimal(cardinal.value, fractionDigits.join('')) ?? cardinal.value,
    startToken,
    endToken: current,
    notation: 'words'
  }
}

function uniqueAliases(values: readonly string[]): string[] {
  const aliases: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const normalized = value.trim().replace(/\s+/g, ' ')
    const key = normalized.toLowerCase()
    if (!normalized || seen.has(key)) continue
    seen.add(key)
    aliases.push(normalized)
  }
  return aliases
}

function integerToWords(value: bigint): string | null {
  if (value < 0n || value >= 1_000_000_000_000_000n) return null
  if (value === 0n) return 'zero'
  const small = [
    '',
    'one',
    'two',
    'three',
    'four',
    'five',
    'six',
    'seven',
    'eight',
    'nine',
    'ten',
    'eleven',
    'twelve',
    'thirteen',
    'fourteen',
    'fifteen',
    'sixteen',
    'seventeen',
    'eighteen',
    'nineteen'
  ]
  const tens = [
    '',
    '',
    'twenty',
    'thirty',
    'forty',
    'fifty',
    'sixty',
    'seventy',
    'eighty',
    'ninety'
  ]

  const underThousand = (part: number): string => {
    const words: string[] = []
    if (part >= 100) {
      words.push(small[Math.floor(part / 100)]!, 'hundred')
      part %= 100
    }
    if (part >= 20) {
      const remainder = part % 10
      words.push(
        remainder
          ? `${tens[Math.floor(part / 10)]}-${small[remainder]}`
          : tens[Math.floor(part / 10)]!
      )
    } else if (part > 0) {
      words.push(small[part]!)
    }
    return words.join(' ')
  }

  const chunks: Array<{ scale: bigint; name: string }> = [
    { scale: 1_000_000_000_000n, name: 'trillion' },
    { scale: 1_000_000_000n, name: 'billion' },
    { scale: 1_000_000n, name: 'million' },
    { scale: 1_000n, name: 'thousand' }
  ]
  const words: string[] = []
  let remaining = value
  for (const chunk of chunks) {
    if (remaining < chunk.scale) continue
    const count = Number(remaining / chunk.scale)
    words.push(underThousand(count), chunk.name)
    remaining %= chunk.scale
  }
  if (remaining > 0n) words.push(underThousand(Number(remaining)))
  return words.join(' ')
}

function numberToWords(value: string): string | null {
  const [integer, fraction] = value.split('.')
  let integerWords: string | null
  try {
    integerWords = integerToWords(BigInt(integer!))
  } catch {
    return null
  }
  if (!integerWords) return null
  if (!fraction) return integerWords
  const fractionalWords = [...fraction].map((digit) => integerToWords(BigInt(digit))).join(' ')
  return `${integerWords} point ${fractionalWords}`
}

function digitSequenceWords(value: string): string | null {
  if (!/^\d+$/.test(value)) return null
  return [...value].map((digit) => integerToWords(BigInt(digit))).join(' ')
}

function numberAliases(value: string): string[] {
  const aliases = [value]
  const words = numberToWords(value)
  if (words) aliases.push(words)
  if (!value.includes('.') && value.length > 1) {
    const spoken = digitSequenceWords(value)
    if (spoken) aliases.push(spoken)
  }
  return uniqueAliases(aliases)
}

function sourceMention(
  text: string,
  tokens: readonly Token[],
  startToken: number,
  endToken: number,
  values: Omit<QuantityMention, 'raw' | 'start' | 'end'>
): QuantityMention {
  const start = tokens[startToken]!.start
  const end = tokens[endToken]!.end
  return { ...values, raw: text.slice(start, end), start, end }
}

function readDottedVersion(
  text: string,
  tokens: readonly Token[],
  startToken: number
): { components: string[]; endToken: number } | null {
  const first = tokens[startToken]
  if (first?.type !== 'number' || first.raw.includes(',')) return null
  const firstValue = normalizeInteger(first.raw)
  if (firstValue == null) return null
  const components = [firstValue]
  let current = startToken
  while (true) {
    const dot = tokens[current + 1]
    const component = tokens[current + 2]
    if (
      dot?.raw !== '.' ||
      component?.type !== 'number' ||
      component.raw.includes(',') ||
      !whitespaceConnected(text, tokens[current]!, dot) ||
      !whitespaceConnected(text, dot, component)
    ) {
      break
    }
    const normalized = normalizeInteger(component.raw)
    if (normalized == null) break
    components.push(normalized)
    current += 2
  }
  return { components, endToken: current }
}

function readSpokenVersion(
  text: string,
  tokens: readonly Token[],
  startToken: number
): { components: string[]; endToken: number; usedExplicitSeparator: boolean } | null {
  const first = tokens[startToken]
  if (!first || DIGIT_WORDS[first.lower] == null) return null
  const components = [String(DIGIT_WORDS[first.lower])]
  let current = startToken
  let usedExplicitSeparator = false

  while (true) {
    const nextIndex = nextConnectedToken(text, tokens, current)
    const next = nextIndex == null ? null : tokens[nextIndex]
    if (!next) break
    if (DIGIT_WORDS[next.lower] != null) {
      components.push(String(DIGIT_WORDS[next.lower]))
      current = nextIndex!
      continue
    }
    if (next.lower !== 'point' && next.lower !== 'dot') break
    const digitIndex = nextConnectedToken(text, tokens, nextIndex!)
    const digit = digitIndex == null ? null : tokens[digitIndex]
    if (!digit || DIGIT_WORDS[digit.lower] == null) break
    usedExplicitSeparator = true
    components.push(String(DIGIT_WORDS[digit.lower]))
    current = digitIndex!
  }

  if (components.length < 2) return null
  return { components, endToken: current, usedExplicitSeparator }
}

function spokenVersionComponents(spoken: {
  components: readonly string[]
  usedExplicitSeparator: boolean
}): string[] {
  return spoken.usedExplicitSeparator ? [...spoken.components] : [spoken.components.join('')]
}

function versionAliases(components: readonly string[]): string[] {
  const dotted = components.join('.')
  const spokenDigits = components
    .flatMap((component) => [...component])
    .map((digit) => integerToWords(BigInt(digit)))
    .join(' ')
  const spokenPoints = components
    .map((component) => [...component].map((digit) => integerToWords(BigInt(digit))).join(' '))
    .join(' point ')
  return uniqueAliases([dotted, `v${dotted}`, `version ${dotted}`, spokenDigits, spokenPoints])
}

function parseVersion(
  text: string,
  tokens: readonly Token[],
  startToken: number
): ParsedMention | null {
  const start = tokens[startToken]
  if (!start) return null
  let valueStart = startToken
  let hasPrefix = false
  let prefix = ''

  if (start.type === 'word' && VERSION_PREFIXES.has(start.lower)) {
    hasPrefix = true
    prefix = start.lower
    let nextIndex = nextConnectedToken(text, tokens, startToken)
    const optionalDot = nextIndex == null ? null : tokens[nextIndex]
    if (optionalDot?.raw === '.') nextIndex = nextConnectedToken(text, tokens, nextIndex!)
    if (nextIndex == null) return null
    valueStart = nextIndex
  }

  const dotted = readDottedVersion(text, tokens, valueStart)
  if (dotted && (hasPrefix || dotted.components.length >= 3)) {
    if (!hasPrefix && dotted.components.length < 3) return null
    if ((prefix === 'release' || prefix === 'build') && dotted.components.length < 2) return null
    const canonicalValue = dotted.components.join('.')
    return {
      mention: sourceMention(text, tokens, startToken, dotted.endToken, {
        kind: 'version',
        canonical: `version:${canonicalValue}`,
        aliases: versionAliases(dotted.components),
        values: dotted.components,
        notation: 'dotted'
      }),
      endToken: dotted.endToken
    }
  }

  if (hasPrefix) {
    const spoken = readSpokenVersion(text, tokens, valueStart)
    if (spoken) {
      const components = spokenVersionComponents(spoken)
      const canonicalValue = components.join('.')
      return {
        mention: sourceMention(text, tokens, startToken, spoken.endToken, {
          kind: 'version',
          canonical: `version:${canonicalValue}`,
          aliases: versionAliases(components),
          values: components,
          notation: 'digit-sequence'
        }),
        endToken: spoken.endToken
      }
    }

    const atom = readNumericAtom(text, tokens, valueStart)
    if (atom && prefix !== 'release') {
      return {
        mention: sourceMention(text, tokens, startToken, atom.endToken, {
          kind: 'version',
          canonical: `version:${atom.value}`,
          aliases: versionAliases([atom.value]),
          values: [atom.value],
          notation: atom.notation
        }),
        endToken: atom.endToken
      }
    }
    return null
  }

  const spoken = readSpokenVersion(text, tokens, startToken)
  const numeric = spoken ? null : readNumericAtom(text, tokens, startToken)
  const value = spoken ?? numeric
  if (!value) return null
  const suffixIndex = nextConnectedToken(text, tokens, value.endToken)
  const suffix = suffixIndex == null ? null : tokens[suffixIndex]
  let contextualSuffixIndex = suffix && VERSION_SUFFIXES.has(suffix.lower) ? suffixIndex : null
  if (contextualSuffixIndex == null && numeric?.value.includes('.') && suffixIndex != null) {
    const directReleaseVerb =
      /^(?:deploys?|deployed|launches?|launched|releases?|released|ships?|shipped)$/i
    if (directReleaseVerb.test(tokens[suffixIndex]!.lower)) {
      contextualSuffixIndex = suffixIndex
    } else if (/^(?:is|was|will)$/i.test(tokens[suffixIndex]!.lower)) {
      let verbIndex = nextConnectedToken(text, tokens, suffixIndex)
      if (verbIndex != null && tokens[verbIndex]!.lower === 'be') {
        verbIndex = nextConnectedToken(text, tokens, verbIndex)
      }
      if (verbIndex != null && directReleaseVerb.test(tokens[verbIndex]!.lower)) {
        contextualSuffixIndex = verbIndex
      }
    }
  }
  if (contextualSuffixIndex == null) return null
  const components = spoken ? spokenVersionComponents(spoken) : numeric!.value.split('.')
  const canonicalValue = components.join('.')
  return {
    mention: sourceMention(text, tokens, startToken, contextualSuffixIndex, {
      kind: 'version',
      canonical: `version:${canonicalValue}`,
      aliases: versionAliases(components),
      values: components,
      notation: spoken ? 'digit-sequence' : numeric!.notation
    }),
    endToken: contextualSuffixIndex
  }
}

function parsePercentSuffix(
  text: string,
  tokens: readonly Token[],
  afterToken: number
): number | null {
  const suffixIndex = nextConnectedToken(text, tokens, afterToken)
  const suffix = suffixIndex == null ? null : tokens[suffixIndex]
  if (!suffix) return null
  if (suffix.raw === '%' || suffix.lower === 'percent' || suffix.lower === 'percentage') {
    return suffixIndex
  }
  if (suffix.lower !== 'per') return null
  const centIndex = nextConnectedToken(text, tokens, suffixIndex!)
  return centIndex != null && tokens[centIndex]?.lower === 'cent' ? centIndex : null
}

function percentageAliases(value: string): string[] {
  const words = numberToWords(value)
  return uniqueAliases([`${value}%`, `${value} percent`, words ? `${words} percent` : ''])
}

function parsePercentage(
  text: string,
  tokens: readonly Token[],
  startToken: number
): ParsedMention | null {
  const atom = readNumericAtom(text, tokens, startToken)
  if (!atom) return null
  const endToken = parsePercentSuffix(text, tokens, atom.endToken)
  if (endToken == null) return null
  return {
    mention: sourceMention(text, tokens, startToken, endToken, {
      kind: 'percentage',
      canonical: `percentage:${atom.value}`,
      aliases: percentageAliases(atom.value),
      values: [atom.value],
      notation: atom.notation
    }),
    endToken
  }
}

function parsePercentagePoints(
  text: string,
  tokens: readonly Token[],
  startToken: number
): ParsedMention | null {
  const atom = readNumericAtom(text, tokens, startToken)
  if (!atom) return null
  const percentIndex = nextConnectedToken(text, tokens, atom.endToken)
  const percent = percentIndex == null ? null : tokens[percentIndex]
  if (!percent || (percent.lower !== 'percent' && percent.lower !== 'percentage')) return null
  const pointsIndex = nextConnectedToken(text, tokens, percentIndex!)
  const points = pointsIndex == null ? null : tokens[pointsIndex]
  if (!points || (points.lower !== 'point' && points.lower !== 'points')) return null
  const words = numberToWords(atom.value)
  return {
    mention: sourceMention(text, tokens, startToken, pointsIndex!, {
      kind: 'unit',
      canonical: `unit:percentage-point:${atom.value}`,
      aliases: uniqueAliases([
        `${atom.value} percentage points`,
        `${atom.value} percent points`,
        words ? `${words} percentage points` : ''
      ]),
      values: [atom.value],
      unit: 'percentage-point',
      notation: atom.notation
    }),
    endToken: pointsIndex!
  }
}

function currencyAliases(currency: string, value: string): string[] {
  const display = CURRENCY_DISPLAY[currency]
  const words = numberToWords(value)
  const singular = value === '1'
  return uniqueAliases([
    `${currency} ${value}`,
    display?.symbol ? `${display.symbol}${value}` : '',
    display ? `${value} ${singular ? display.singular : display.plural}` : '',
    display && words ? `${words} ${singular ? display.singular : display.plural}` : ''
  ])
}

function readMagnitude(
  text: string,
  tokens: readonly Token[],
  afterToken: number
): { power: number; endToken: number } | null {
  const index = nextConnectedToken(text, tokens, afterToken)
  const token = index == null ? null : tokens[index]
  if (!token) return null
  const power = MAGNITUDES[token.lower]
  return power == null ? null : { power, endToken: index! }
}

function parseCurrency(
  text: string,
  tokens: readonly Token[],
  startToken: number
): ParsedMention | null {
  const start = tokens[startToken]
  if (!start) return null
  let currency: string | undefined
  let valueStart = startToken
  let prefix = false

  if (CURRENCY_SYMBOLS[start.raw]) {
    currency = CURRENCY_SYMBOLS[start.raw]
    prefix = true
  } else if (CURRENCY_WORDS[start.lower] && start.lower.length === 3) {
    currency = CURRENCY_WORDS[start.lower]
    prefix = true
  }

  if (prefix) {
    const next = nextConnectedToken(text, tokens, startToken)
    if (next == null) return null
    valueStart = next
  }

  const atom = readNumericAtom(text, tokens, valueStart)
  if (!atom) return null
  let endToken = atom.endToken
  let value = atom.value
  const magnitude = readMagnitude(text, tokens, endToken)
  if (magnitude) {
    value = scaleDecimal(value, magnitude.power)
    endToken = magnitude.endToken
  }

  const suffixIndex = nextConnectedToken(text, tokens, endToken)
  const suffix = suffixIndex == null ? null : tokens[suffixIndex]
  const suffixCurrency = suffix ? CURRENCY_WORDS[suffix.lower] : undefined
  if (suffixCurrency) {
    if (currency && suffixCurrency !== currency) return null
    currency = suffixCurrency
    endToken = suffixIndex!
  }
  if (!currency) return null

  return {
    mention: sourceMention(text, tokens, startToken, endToken, {
      kind: 'currency',
      canonical: `currency:${currency}:${value}`,
      aliases: currencyAliases(currency, value),
      values: [value],
      currency,
      notation: atom.notation
    }),
    endToken
  }
}

function parseUnitSuffix(
  text: string,
  tokens: readonly Token[],
  afterToken: number
): { unit: string; endToken: number } | null {
  const index = nextConnectedToken(text, tokens, afterToken)
  const token = index == null ? null : tokens[index]
  if (!token) return null
  const unit = UNIT_ALIASES[token.lower]
  return unit ? { unit, endToken: index! } : null
}

function unitAliases(value: string, unit: string): string[] {
  const words = numberToWords(value)
  const displays = UNIT_DISPLAY_ALIASES[unit] ?? [unit]
  const aliases: string[] = []
  for (const display of displays) aliases.push(`${value} ${display}`)
  if (words) {
    const conversational = displays[displays.length - 1] ?? unit
    aliases.push(`${words} ${conversational}`)
  }
  return uniqueAliases(aliases)
}

function parseUnit(
  text: string,
  tokens: readonly Token[],
  startToken: number
): ParsedMention | null {
  const atom = readNumericAtom(text, tokens, startToken)
  if (!atom) return null
  const suffix = parseUnitSuffix(text, tokens, atom.endToken)
  if (!suffix) return null
  return {
    mention: sourceMention(text, tokens, startToken, suffix.endToken, {
      kind: 'unit',
      canonical: `unit:${suffix.unit}:${atom.value}`,
      aliases: unitAliases(atom.value, suffix.unit),
      values: [atom.value],
      unit: suffix.unit,
      notation: atom.notation
    }),
    endToken: suffix.endToken
  }
}

function parseRatio(
  text: string,
  tokens: readonly Token[],
  startToken: number
): ParsedMention | null {
  const left = readNumericAtom(text, tokens, startToken)
  if (!left) return null
  const separatorIndex = nextConnectedToken(text, tokens, left.endToken)
  const separator = separatorIndex == null ? null : tokens[separatorIndex]
  if (!separator) return null

  if (separator.type === 'word') {
    const adjacentRight = readNumericAtom(text, tokens, separatorIndex!)
    if (
      left.notation !== 'words' ||
      adjacentRight?.notation !== 'words' ||
      left.value !== '50' ||
      adjacentRight.value !== '50'
    ) {
      return null
    }
    return {
      mention: sourceMention(text, tokens, startToken, adjacentRight.endToken, {
        kind: 'ratio',
        canonical: 'ratio:50/50',
        aliases: ['50/50', '50:50', 'fifty-fifty', 'fifty fifty', 'fifty to fifty'],
        values: ['50', '50'],
        notation: 'words'
      }),
      endToken: adjacentRight.endToken
    }
  }

  if (separator.raw !== '/' && separator.raw !== ':' && separator.raw !== '-') return null
  const rightStart = nextConnectedToken(text, tokens, separatorIndex!)
  if (rightStart == null) return null
  const right = readNumericAtom(text, tokens, rightStart)
  if (!right) return null

  const fiftyFifty = separator.raw === '-' && left.value === '50' && right.value === '50'
  if (separator.raw !== '/' && separator.raw !== ':' && !fiftyFifty) return null

  const leftWords = numberToWords(left.value)
  const rightWords = numberToWords(right.value)
  const aliases = uniqueAliases([
    `${left.value}/${right.value}`,
    `${left.value}:${right.value}`,
    leftWords && rightWords ? `${leftWords}-${rightWords}` : '',
    leftWords && rightWords && left.value === right.value ? `${leftWords} ${rightWords}` : '',
    leftWords && rightWords ? `${leftWords} to ${rightWords}` : ''
  ])
  return {
    mention: sourceMention(text, tokens, startToken, right.endToken, {
      kind: 'ratio',
      canonical: `ratio:${left.value}/${right.value}`,
      aliases,
      values: [left.value, right.value],
      notation: left.notation === right.notation ? left.notation : 'mixed'
    }),
    endToken: right.endToken
  }
}

function readEndpoint(text: string, tokens: readonly Token[], startToken: number): Endpoint | null {
  const atom = readNumericAtom(text, tokens, startToken)
  if (!atom) return null
  const percentEnd = parsePercentSuffix(text, tokens, atom.endToken)
  if (percentEnd != null) {
    return { atom, endToken: percentEnd, kind: 'percentage' }
  }
  const unit = parseUnitSuffix(text, tokens, atom.endToken)
  if (unit) return { atom, endToken: unit.endToken, kind: 'unit', unit: unit.unit }
  return { atom, endToken: atom.endToken, kind: 'number' }
}

function rangeAliases(
  left: string,
  right: string,
  rangeKind: Endpoint['kind'],
  unit?: string
): string[] {
  const leftWords = numberToWords(left)
  const rightWords = numberToWords(right)
  if (rangeKind === 'percentage') {
    return uniqueAliases([
      `${left}-${right}%`,
      `${left}% to ${right}%`,
      leftWords && rightWords ? `${leftWords} to ${rightWords} percent` : ''
    ])
  }
  if (rangeKind === 'unit' && unit) {
    const display = UNIT_DISPLAY_ALIASES[unit]?.at(-1) ?? unit
    return uniqueAliases([
      `${left}-${right} ${display}`,
      `${left} ${display} to ${right} ${display}`,
      leftWords && rightWords ? `${leftWords} to ${rightWords} ${display}` : ''
    ])
  }
  return uniqueAliases([
    `${left}-${right}`,
    `${left} to ${right}`,
    leftWords && rightWords ? `${leftWords} to ${rightWords}` : ''
  ])
}

function parseRange(
  text: string,
  tokens: readonly Token[],
  startToken: number
): ParsedMention | null {
  const first = tokens[startToken]
  let leftStart = startToken
  let between = false
  if (first?.lower === 'between') {
    between = true
    const next = nextConnectedToken(text, tokens, startToken)
    if (next == null) return null
    leftStart = next
  }

  const left = readEndpoint(text, tokens, leftStart)
  if (!left) return null
  const joinerIndex = nextConnectedToken(text, tokens, left.endToken)
  const joiner = joinerIndex == null ? null : tokens[joinerIndex]
  const validJoiner = between
    ? joiner?.lower === 'and'
    : joiner?.type === 'separator' && ['-', '–', '—'].includes(joiner.raw)
      ? true
      : joiner != null && RANGE_JOINERS.has(joiner.lower)
  if (!validJoiner || joinerIndex == null) return null

  const rightStart = nextConnectedToken(text, tokens, joinerIndex)
  if (rightStart == null) return null
  const right = readEndpoint(text, tokens, rightStart)
  if (!right) return null

  // Avoid interpreting the leading portion of an ISO-style date as a range.
  const trailingJoinerIndex = nextConnectedToken(text, tokens, right.endToken)
  const trailingJoiner = trailingJoinerIndex == null ? null : tokens[trailingJoinerIndex]
  if (trailingJoiner && ['-', '–', '—'].includes(trailingJoiner.raw)) return null

  let rangeKind: Endpoint['kind']
  let unit: string | undefined
  if (left.kind === right.kind) {
    rangeKind = left.kind
    if (rangeKind === 'unit') {
      if (left.unit !== right.unit) return null
      unit = left.unit
    }
  } else if (left.kind === 'number') {
    rangeKind = right.kind
    unit = right.unit
  } else if (right.kind === 'number') {
    rangeKind = left.kind
    unit = left.unit
  } else {
    return null
  }

  const typeKey = rangeKind === 'unit' ? `unit:${unit}` : rangeKind
  return {
    mention: sourceMention(text, tokens, startToken, right.endToken, {
      kind: 'range',
      canonical: `range:${typeKey}:${left.atom.value}..${right.atom.value}`,
      aliases: rangeAliases(left.atom.value, right.atom.value, rangeKind, unit),
      values: [left.atom.value, right.atom.value],
      notation: left.atom.notation === right.atom.notation ? left.atom.notation : 'mixed',
      unit,
      rangeKind
    }),
    endToken: right.endToken
  }
}

function hasGluedAlphabeticNeighbor(tokens: readonly Token[], atom: NumericAtom): boolean {
  const before = tokens[atom.startToken - 1]
  const first = tokens[atom.startToken]
  const last = tokens[atom.endToken]
  const after = tokens[atom.endToken + 1]
  return (
    (before?.type === 'word' && before.end === first?.start) ||
    (after?.type === 'word' && last?.end === after.start)
  )
}

function parsePlainNumber(
  text: string,
  tokens: readonly Token[],
  startToken: number
): ParsedMention | null {
  const atom = readNumericAtom(text, tokens, startToken)
  if (!atom || hasGluedAlphabeticNeighbor(tokens, atom)) return null
  return {
    mention: sourceMention(text, tokens, startToken, atom.endToken, {
      kind: 'number',
      canonical: `number:${atom.value}`,
      aliases: numberAliases(atom.value),
      values: [atom.value],
      notation: atom.notation
    }),
    endToken: atom.endToken
  }
}

/** Extracts typed quantitative mentions in source order, retaining duplicates. */
export function extractQuantityMentions(text: string): QuantityMention[] {
  const tokens = tokenize(text)
  const mentions: QuantityMention[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const parsed =
      parseVersion(text, tokens, index) ??
      parseCurrency(text, tokens, index) ??
      parseRatio(text, tokens, index) ??
      parseRange(text, tokens, index) ??
      parsePercentagePoints(text, tokens, index) ??
      parsePercentage(text, tokens, index) ??
      parseUnit(text, tokens, index) ??
      parsePlainNumber(text, tokens, index)
    if (!parsed) continue
    mentions.push(parsed.mention)
    index = parsed.endToken
  }
  return mentions
}

function isVersionSpokenDigitAlias(version: QuantityMention, number: QuantityMention): boolean {
  if (
    version.kind !== 'version' ||
    version.values.length !== 1 ||
    number.kind !== 'number' ||
    number.notation !== 'digit-sequence'
  ) {
    return false
  }
  return version.values.join('') === number.values[0]
}

/**
 * Compares one typed mention to another. Equivalent spellings reduce to a
 * single canonical key, so callers never need every generated alias to occur in
 * the evidence. The sole cross-kind case is an undotted spoken digit sequence
 * used as an undotted version (for example, `four four three` for `v443`).
 */
export function quantityMentionsEquivalent(left: QuantityMention, right: QuantityMention): boolean {
  if (left.kind !== right.kind) {
    return isVersionSpokenDigitAlias(left, right) || isVersionSpokenDigitAlias(right, left)
  }
  return left.canonical === right.canonical
}

/** Checks that every quantitative summary mention has compatible evidence. */
export function checkQuantityGrounding(
  summaryText: string,
  evidenceText: string,
  options: QuantityGroundingOptions = {}
): QuantityGroundingResult {
  const summaryMentions = extractQuantityMentions(summaryText)
  const evidenceMentions = extractQuantityMentions(evidenceText)
  const usedEvidence = new Set<number>()
  const matches: QuantityMentionMatch[] = []

  for (const summary of summaryMentions) {
    const evidenceIndex = evidenceMentions.findIndex(
      (evidence, index) =>
        (!options.consumeEvidenceMentions || !usedEvidence.has(index)) &&
        quantityMentionsEquivalent(summary, evidence)
    )
    if (evidenceIndex >= 0 && options.consumeEvidenceMentions) usedEvidence.add(evidenceIndex)
    matches.push({
      summary,
      evidence: evidenceIndex >= 0 ? evidenceMentions[evidenceIndex]! : null,
      evidenceIndex: evidenceIndex >= 0 ? evidenceIndex : null
    })
  }

  const unsupported = matches
    .filter((match) => match.evidence == null)
    .map((match) => match.summary)
  return {
    supported: unsupported.length === 0,
    summaryMentions,
    evidenceMentions,
    matches,
    unsupported
  }
}

/** Boolean shorthand for {@link checkQuantityGrounding}. */
export function areQuantitiesGrounded(
  summaryText: string,
  evidenceText: string,
  options?: QuantityGroundingOptions
): boolean {
  return checkQuantityGrounding(summaryText, evidenceText, options).supported
}
