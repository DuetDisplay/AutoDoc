import { describe, expect, it } from 'vitest'
import { parseGoogleEventTime } from '../calendar-time'

describe('parseGoogleEventTime', () => {
  it('keeps an all-day event on its calendar date regardless of timezone (QA: birthday)', () => {
    // Google sends all-day events as a date-only `date`. Parsing it as UTC
    // midnight would render as the previous day in any negative-offset zone
    // (Mon Jun 15 -> Sun Jun 14). The local date must stay June 15.
    const ts = parseGoogleEventTime({ date: '2026-06-15' })
    const d = new Date(ts)
    expect(d.getFullYear()).toBe(2026)
    expect(d.getMonth()).toBe(5) // June (0-indexed)
    expect(d.getDate()).toBe(15)
    expect(d.getHours()).toBe(0) // local midnight, not shifted
  })

  it('parses a timezoned dateTime as the exact instant', () => {
    const ts = parseGoogleEventTime({ dateTime: '2026-06-15T09:30:00-04:00' })
    expect(ts).toBe(new Date('2026-06-15T09:30:00-04:00').getTime())
  })

  it('prefers dateTime when both are present', () => {
    const ts = parseGoogleEventTime({ dateTime: '2026-06-15T09:30:00Z', date: '2026-06-15' })
    expect(ts).toBe(new Date('2026-06-15T09:30:00Z').getTime())
  })

  it('returns 0 for an empty slot', () => {
    expect(parseGoogleEventTime(undefined)).toBe(0)
    expect(parseGoogleEventTime(null)).toBe(0)
    expect(parseGoogleEventTime({})).toBe(0)
  })
})
