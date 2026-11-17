import { expect, it } from 'vitest'
import { expandYenUnits, expandJapaneseDates } from '../ask-ai-numeric-evidence'
it.each([
  ['予算は350万円です。', '3,500,000 yen'],
  ['予算は3.5万円です。', '35,000 yen'],
  ['予算は3.5億円です。', '350,000,000 yen'],
  ['0.123456789万円', '1,234.56789 yen']
])('expands the exact source unit without floating point rounding: %s', (text, expected) => {
  const result = expandYenUnits(text)
  expect(result).toContain(text.replace('です。', ''))
  expect(result).toContain(expected)
})
it('does not repair ambiguous separators or guess unspecified currencies', () => {
  expect(expandYenUnits('3,50万円; 350万元; 350万ドル')).toBe('3,50万円; 350万元; 350万ドル')
})

it('leaves signed, incomplete decimal and compound-unit amounts intact', () => {
  const text = '-350万円; +350万円; .5万円; 1億350万円; 2兆3億円'
  expect(expandYenUnits(text)).toBe(text)
})
it('translates only fully specified valid dates without using the recording date', () => {
  expect(expandJapaneseDates('発売は2026年11月12日です。')).toContain(
    'English date: November 12, 2026'
  )
  expect(expandJapaneseDates('2024年2月29日')).toContain('February 29, 2024')
  const uncertain = '2026年2月29日; 11月12日; 来年; 2026年13月1日'
  expect(expandJapaneseDates(uncertain)).toBe(uncertain)
})
