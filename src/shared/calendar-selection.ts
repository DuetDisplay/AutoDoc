import type { CalendarEvent } from './types'

/** Use the same meeting priority in detection and recording controls. */
export function selectActiveCalendarEvent(
  events: CalendarEvent[],
  now: number,
  isAutoRecordEnabled: (event: CalendarEvent) => boolean = (event) => event.autoRecord !== 'off'
): CalendarEvent | null {
  return events.reduce<CalendarEvent | null>((best, event) => {
    if (event.isAllDay || event.startTime > now || event.endTime < now) return best
    if (!best) return event
    const autoRecord = isAutoRecordEnabled(event)
    const bestAutoRecord = isAutoRecordEnabled(best)
    if (autoRecord !== bestAutoRecord) return autoRecord ? event : best
    return event.startTime >= best.startTime ? event : best
  }, null)
}
