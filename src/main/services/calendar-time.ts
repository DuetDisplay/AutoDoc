/**
 * Pure date/time parsing for calendar providers, kept dependency-free so it can
 * be unit-tested without loading the electron/googleapis-heavy provider module.
 */

// Google returns timed events as `dateTime` (RFC3339 with offset) and all-day
// events (e.g. birthdays) as a date-only `date` ("2026-06-15"). `new Date(
// "2026-06-15")` parses as UTC midnight, which renders as the PREVIOUS day in
// any negative-offset timezone (Mon Jun 15 -> Sun Jun 14). Parse date-only
// values as LOCAL midnight so all-day events keep their calendar date.
export function parseGoogleEventTime(
  slot: { dateTime?: string | null; date?: string | null } | undefined | null
): number {
  if (!slot) return 0
  if (slot.dateTime) return new Date(slot.dateTime).getTime()
  if (slot.date) {
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(slot.date)
    if (dateOnly) {
      return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])).getTime()
    }
    return new Date(slot.date).getTime()
  }
  return 0
}
