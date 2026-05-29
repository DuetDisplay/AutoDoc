import type { MeetingMetadata } from '../../shared/types'

export function formatRecordingDateSuffix(startedAt: number): string {
  const createdAt = new Date(startedAt)
  return `${createdAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} at ${createdAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
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
