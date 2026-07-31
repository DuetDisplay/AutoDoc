import type { CalendarEvent } from '../../../shared/types'

const MEETING_PROMPT_BUFFER_MS = 10 * 60 * 1000

export function hasCurrentOrImminentMeeting(events: CalendarEvent[], now = Date.now()): boolean {
  return events.some((event) => {
    if (event.isAllDay) return false
    const inProgress = event.startTime <= now && event.endTime > now
    const startsSoon = event.startTime > now && event.startTime - now <= MEETING_PROMPT_BUFFER_MS
    return inProgress || startsSoon
  })
}
