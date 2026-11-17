// Decimal literal parsing and binary evidence operations ported from the CL work.
// This module has no CL conversation engine, classifiers, prompts or stored history.
export type ArithmeticOperator = '+' | '-' | '*' | '/' | 'mean' | 'percent_change' | 'percentage_of'
export function numericLiteral(literal: string): {
  units: bigint
  scale: number
  currency: string
} {
  const match = literal
    .normalize('NFKC')
    .replace(/−/gu, '-')
    .trim()
    .match(
      /^(USD|EUR|GBP|JPY|[$€£¥])?\s*([+-]?\d[\d.,'’ \u00a0\u202f]*)(?:\s*(million|billion|thousand|k|m|bn))?\s*(USD|EUR|GBP|JPY|[$€£¥]|dollars|euros|yen|%)?$/iu
    )
  if (!match) throw Error('The selected numeric values cannot be compared safely')
  const currencies: Record<string, string> = {
    $: 'USD',
    dollars: 'USD',
    '€': 'EUR',
    euros: 'EUR',
    '£': 'GBP',
    '¥': 'JPY',
    yen: 'JPY'
  }
  const unit = match[1] || match[4] || ''
  const currency = currencies[unit.toLowerCase()] ?? unit.toUpperCase()
  if (
    match[1] &&
    match[4] &&
    currency !== (currencies[match[4].toLowerCase()] ?? match[4].toUpperCase())
  )
    throw Error('Conflicting numeric currencies')
  let number = match[2].trim().replace(/[ '’\u00a0\u202f]/gu, '')
  const comma = number.lastIndexOf(','),
    dot = number.lastIndexOf('.')
  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? ',' : '.'
    const grouping = decimal === ',' ? '.' : ','
    const [integer, fraction] = number.split(decimal)
    if (
      !fraction ||
      !/^\d+$/u.test(fraction) ||
      !new RegExp(`^[+-]?\\d{1,3}(?:\\${grouping}\\d{3})*$`).test(integer)
    )
      throw Error('Ambiguous numeric separators')
    number = integer.split(grouping).join('') + '.' + fraction
  } else if (comma >= 0) {
    if (/^[+-]?\d{1,3}(?:,\d{3})+$/u.test(number)) number = number.replaceAll(',', '')
    else if (/^[+-]?\d+,\d{1,2}$/u.test(number)) number = number.replace(',', '.')
    else throw Error('Ambiguous numeric separators')
  } else if ((number.match(/\./gu) || []).length > 1) {
    if (/^[+-]?\d{1,3}(?:\.\d{3})+$/u.test(number)) number = number.replaceAll('.', '')
    else throw Error('Ambiguous numeric separators')
  }
  if (!/^[+-]?\d+(?:\.\d+)?$/u.test(number)) throw Error('Invalid numeric value')
  const [whole, fraction = ''] = number.split('.')
  const multiplier =
    ({ thousand: 3, k: 3, million: 6, m: 6, billion: 9, bn: 9 } as Record<string, number>)[
      match[3]?.toLowerCase()
    ] ?? 0
  return {
    units: BigInt(whole + fraction) * 10n ** BigInt(multiplier),
    scale: fraction.length,
    currency
  }
}
export function calculateEvidenceDifference(
  left: string,
  right: string
): { left: number; right: number; difference: number; currency: string } {
  const a = numericLiteral(left),
    b = numericLiteral(right)
  if (a.currency !== b.currency) throw Error('These values use different units or currencies')
  const scale = Math.max(a.scale, b.scale)
  const av = a.units * 10n ** BigInt(scale - a.scale),
    bv = b.units * 10n ** BigInt(scale - b.scale)
  const values = [av, bv, av - bv].map((value) => Number(value) / 10 ** scale)
  if (values.some((value) => !Number.isSafeInteger(Math.round(value * 10 ** scale))))
    throw Error('These values exceed the supported numeric precision')
  return { left: values[0], right: values[1], difference: values[2], currency: a.currency }
}
export function calculateEvidenceOperation(
  left: string,
  right: string,
  operator: ArithmeticOperator
) {
  if (operator === '-') {
    const value = calculateEvidenceDifference(left, right)
    return {
      left: value.left,
      right: value.right,
      result: value.difference,
      currency: value.currency
    }
  }
  const a = numericLiteral(left),
    b = numericLiteral(right)
  const av = Number(a.units) / 10 ** a.scale,
    bv = Number(b.units) / 10 ** b.scale
  if (
    ![av, bv].every(Number.isFinite) ||
    [a.units, b.units].some(
      (n) => n > BigInt(Number.MAX_SAFE_INTEGER) || n < -BigInt(Number.MAX_SAFE_INTEGER)
    )
  )
    throw Error('Unsupported numeric precision')
  if (
    ['+', 'mean', 'percent_change', 'percentage_of'].includes(operator) &&
    a.currency !== b.currency
  )
    throw Error('Incompatible units')
  if (operator === '*' && a.currency && b.currency) throw Error('Incompatible units')
  if (operator === '/' && b.currency && a.currency !== b.currency) throw Error('Incompatible units')
  if (['/', 'percent_change', 'percentage_of'].includes(operator) && bv === 0)
    throw Error('Cannot divide by zero')
  const result =
    operator === '+'
      ? av + bv
      : operator === 'mean'
        ? (av + bv) / 2
        : operator === '*'
          ? av * bv
          : operator === '/'
            ? av / bv
            : operator === 'percentage_of'
              ? (av / bv) * 100
              : ((av - bv) / Math.abs(bv)) * 100
  const currency =
    operator === 'percent_change' || operator === 'percentage_of'
      ? '%'
      : operator === '/' && a.currency === b.currency
        ? ''
        : a.currency || b.currency
  if (!Number.isFinite(result) || Math.abs(result) > Number.MAX_SAFE_INTEGER)
    throw Error('Unsupported numeric precision')
  return { left: av, right: bv, result: Number(result.toPrecision(15)), currency }
}

/** Boundaries separate adjacent quantities, including "$120,000, 15%". */
export function evidenceNumericLiterals(text: string): string[] {
  const pattern =
    /(?:USD|EUR|GBP|JPY|[$€£¥])?\s*[+-]?(?:\d{1,3}(?:[.,'’ \u00a0\u202f]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?)(?:\s*(?:million|billion|thousand|bn|k|m)(?!\p{L}))?(?:\s*(?:USD|EUR|GBP|JPY|dollars|euros|yen|%))?/giu
  return [...text.normalize('NFKC').matchAll(pattern)].flatMap((match) => {
    const literal = match[0].trim()
    try {
      numericLiteral(literal)
      return [literal]
    } catch {
      return []
    }
  })
}
export type CalculationOperation =
  | 'sum'
  | 'difference'
  | 'ratio'
  | 'percentage'
  | 'mean'
  | 'percentage_change'
  | 'percentage_amount'

function rationalText(numerator: bigint, denominator = 1n): { value: string; rounded: boolean } {
  if (!denominator) throw Error('Cannot divide by zero')
  if (denominator < 0n) {
    numerator = -numerator
    denominator = -denominator
  }
  const negative = numerator < 0n
  let value = negative ? -numerator : numerator
  const precision = 12
  const multiplier = 10n ** BigInt(precision)
  const remainder = (value * multiplier) % denominator
  value = (value * multiplier + denominator / 2n) / denominator
  const whole = value / multiplier
  const fraction = (value % multiplier).toString().padStart(precision, '0').replace(/0+$/, '')
  return {
    value: `${negative && value ? '-' : ''}${whole}${fraction ? '.' + fraction : ''}`,
    rounded: remainder !== 0n
  }
}

/** Native exact decimal arithmetic; only repeating divisions are rounded (12dp). */
export function calculateValidatedEvidence(operation: unknown, values: unknown, evidence: string) {
  const allowed: CalculationOperation[] = [
    'sum',
    'difference',
    'ratio',
    'percentage',
    'mean',
    'percentage_change',
    'percentage_amount'
  ]
  if (typeof operation !== 'string' || !allowed.includes(operation as CalculationOperation))
    throw Error('Unknown calculation operation')
  if (!Array.isArray(values) || values.length < 2 || values.length > 16)
    throw Error('Supply 2 to16 evidence values')
  if (!['sum', 'mean'].includes(operation) && values.length !== 2)
    throw Error('This operation needs exactly two values')
  const known = evidenceNumericLiterals(evidence).map((literal) => ({
    literal,
    ...numericLiteral(literal)
  }))
  const selected = values.map((value) => {
    if (
      (typeof value !== 'string' && typeof value !== 'number') ||
      String(value).length > 100 ||
      (typeof value === 'number' && !Number.isFinite(value))
    )
      throw Error('Invalid numeric literal')
    const parsed = numericLiteral(String(value))
    const matches = known.filter(
      (other) =>
        parsed.units * 10n ** BigInt(other.scale) === other.units * 10n ** BigInt(parsed.scale) &&
        (!parsed.currency || parsed.currency === other.currency)
    )
    if (!matches.length)
      throw Error('A supplied value is absent from the current evidence and question')
    const units = new Set(matches.map((match) => match.currency).filter(Boolean))
    if (!parsed.currency && units.size > 1)
      throw Error('Ambiguous source units; copy the unit with each value')
    const selected = matches.find((match) => match.currency) ?? matches[0]
    if (
      selected.units > BigInt(Number.MAX_SAFE_INTEGER) ||
      selected.units < -BigInt(Number.MAX_SAFE_INTEGER) ||
      selected.scale > 12
    )
      throw Error('Unsupported numeric precision')
    return selected
  })
  const scale = Math.max(...selected.map((value) => value.scale))
  const aligned = selected.map((value) => value.units * 10n ** BigInt(scale - value.scale))
  let numerator: bigint,
    denominator = 10n ** BigInt(scale),
    currency = selected[0].currency
  const equalUnits = selected.every((value) => value.currency === currency)
  if (operation === 'sum' || operation === 'mean') {
    if (!equalUnits) throw Error('Incompatible units')
    numerator = aligned.reduce((a, b) => a + b, 0n)
    if (operation === 'mean') denominator *= BigInt(selected.length)
  } else if (operation === 'difference') {
    if (!equalUnits) throw Error('Incompatible units')
    numerator = aligned[0] - aligned[1]
  } else if (operation === 'percentage_amount') {
    if (selected[1].currency && selected[1].currency !== '%')
      throw Error('The second value must be a percent rate')
    numerator = selected[0].units * selected[1].units
    denominator = 100n * 10n ** BigInt(selected[0].scale + selected[1].scale)
  } else {
    if (!equalUnits) throw Error('Incompatible units')
    if (!aligned[1]) throw Error('Cannot divide by zero')
    numerator =
      operation === 'percentage_change'
        ? (aligned[0] - aligned[1]) * 100n
        : aligned[0] * (operation === 'percentage' ? 100n : 1n)
    denominator = operation === 'percentage_change' && aligned[1] < 0n ? -aligned[1] : aligned[1]
    currency = operation === 'ratio' ? '' : '%'
  }
  const result = rationalText(numerator, denominator)
  if (
    !Number.isFinite(Number(result.value)) ||
    Math.abs(Number(result.value)) > Number.MAX_SAFE_INTEGER
  )
    throw Error('Unsupported numeric precision')
  return {
    operation,
    values: selected.map((value) => value.literal),
    result: result.value,
    unit: currency,
    rounded: result.rounded,
    ...(result.rounded ? { decimalPlaces: 12 } : {})
  }
}
