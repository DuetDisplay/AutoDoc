import type { CalendarEvent, MeetingMetadata } from '../../shared/types'

export function formatRecordingDateSuffix(startedAt: number): string {
  const createdAt = new Date(startedAt)
  return `${createdAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} at ${createdAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
}

/**
 * Resolves the calendar title to use for a recording's display name.
 *
 * All-day events (e.g. "Home", birthdays, OOO blocks) are deliberately excluded:
 * matching one would rename a recording that already has a meaningful source title.
 * A timed event match wins; otherwise we fall back to a previously persisted
 * calendar title. This is the single source of truth shared by the recording list,
 * recording detail, and AI/search inventory so every surface names recordings the
 * same way.
 */
export function getRecordingDisplayCalendarTitle(
  metadata: MeetingMetadata | null,
  matchedEvent: CalendarEvent | null
): string | null {
  if (matchedEvent && !matchedEvent.isAllDay) {
    return matchedEvent.title?.trim() || metadata?.calendarTitle?.trim() || null
  }

  const persistedCalendarTitle = metadata?.calendarTitle?.trim()
  if (persistedCalendarTitle) {
    return persistedCalendarTitle
  }

  return null
}

export function buildRecordingTitle(
  metadata: MeetingMetadata | null,
  startedAt: number,
  calendarTitle: string | null
): string {
  const dateSuffix = formatRecordingDateSuffix(startedAt)

  const customTitle = metadata?.customTitle?.trim()
  if (customTitle) {
    return customTitle
  }

  if (calendarTitle) {
    return `${calendarTitle} — ${dateSuffix}`
  }

  if (metadata?.sourceName) {
    return `${metadata.sourceName} — ${dateSuffix}`
  }

  return `Recording ${dateSuffix}`
}

export function normalizeRecordingSearchText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function buildRecordingTitleAliases(params: {
  title: string
  metadata: MeetingMetadata | null
  calendarTitle: string | null
  startedAt: number
}): string[] {
  const aliases = new Set<string>()
  const dateSuffix = formatRecordingDateSuffix(params.startedAt)

  aliases.add(params.title)
  aliases.add(params.title.replace(` — ${dateSuffix}`, ''))
  aliases.add(params.title.replace(` - ${dateSuffix}`, ''))

  const customTitle = params.metadata?.customTitle?.trim()
  const calendarTitle = params.calendarTitle?.trim() || params.metadata?.calendarTitle?.trim()
  const sourceName = params.metadata?.sourceName?.trim()

  if (customTitle) aliases.add(customTitle)
  if (calendarTitle) aliases.add(calendarTitle)
  if (sourceName) aliases.add(sourceName)

  aliases.add(dateSuffix)

  return [...aliases].map((alias) => alias.trim()).filter(Boolean)
}
