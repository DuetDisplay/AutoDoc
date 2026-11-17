/** Deterministic unit expansion for Japanese yen amounts. The original evidence
 * is preserved; the equivalent value prevents the writer guessing the 万/億 scale. */
export function expandYenUnits(text: string): string {
  return text.replace(
    /(?<![\d.,+\-万億兆])(\d[\d,]*(?:\.\d+)?)\s*(万|億)円/gu,
    (original, amount: string, unit: string) => {
      if (amount.includes(',') && !/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/u.test(amount)) return original
      const [whole, fraction = ''] = amount.replace(/,/g, '').split('.')
      const digits = BigInt(whole + fraction)
      const exponent = (unit === '万' ? 4 : 8) - fraction.length
      let value: string
      if (exponent >= 0) value = (digits * 10n ** BigInt(exponent)).toString()
      else {
        const raw = digits.toString().padStart(1 - exponent, '0')
        value = raw.slice(0, exponent) + '.' + raw.slice(exponent).replace(/0+$/u, '')
        value = value.replace(/\.$/u, '')
      }
      const [integer, decimals] = value.split('.')
      const formatted =
        integer.replace(/\B(?=(\d{3})+(?!\d))/gu, ',') + (decimals ? '.' + decimals : '')
      return `${original} [equivalent currency value: ${formatted} yen]`
    }
  )
}

/** Translate only fully specified, valid Gregorian source dates. Keep the source
 * verbatim beside the annotation; never infer a missing year or use record time. */
export function expandJapaneseDates(text: string): string {
  const months = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December'
  ]
  return text.replace(
    /(?<!\d)(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/gu,
    (original, y: string, m: string, d: string) => {
      const year = Number(y),
        month = Number(m),
        day = Number(d)
      if (year < 1000 || month < 1 || month > 12 || day < 1 || day > 31) return original
      const date = new Date(Date.UTC(year, month - 1, day))
      if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return original
      return `${original} [English date: ${months[month - 1]} ${day}, ${year}]`
    }
  )
}
