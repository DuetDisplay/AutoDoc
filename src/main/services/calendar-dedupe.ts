import type { CalendarAccount, CalendarEvent, OAuthTokens } from '../../shared/types'

const UNKNOWN_ACCOUNT_EMAILS = new Set([
  'unknown@gmail.com',
  'unknown@outlook.com',
])

function normalizeAccountEmail(email: string): string | null {
  const normalized = email.trim().toLowerCase()
  if (!normalized || UNKNOWN_ACCOUNT_EMAILS.has(normalized)) {
    return null
  }
  return normalized
}

function normalizeTokenValue(token: string | undefined): string | null {
  const normalized = token?.trim()
  return normalized ? normalized : null
}

export function getCalendarAccountIdentity(
  account: CalendarAccount,
  tokens: Partial<OAuthTokens> | null | undefined,
): string | null {
  const email = normalizeAccountEmail(account.email)
  if (email) {
    return `${account.provider}:email:${email}`
  }

  const refreshToken = normalizeTokenValue(tokens?.refresh_token)
  if (refreshToken) {
    return `${account.provider}:refresh:${refreshToken}`
  }

  const accessToken = normalizeTokenValue(tokens?.access_token)
  if (accessToken) {
    return `${account.provider}:access:${accessToken}`
  }

  return null
}

export function isSameCalendarAccount(
  a: CalendarAccount,
  b: CalendarAccount,
  aTokens?: Partial<OAuthTokens> | null,
  bTokens?: Partial<OAuthTokens> | null,
): boolean {
  if (a.id === b.id) return true
  if (a.provider !== b.provider) return false

  const aIdentity = getCalendarAccountIdentity(a, aTokens)
  const bIdentity = getCalendarAccountIdentity(b, bTokens)
  return aIdentity !== null && aIdentity === bIdentity
}

function getEventKey(event: CalendarEvent): string {
  const normalizedTitle = event.title.trim().toLowerCase()
  const normalizedMeetingUrl = event.meetingUrl?.trim().toLowerCase() ?? ''
  const externalId = event.externalId.trim()
  if (externalId) {
    return `${event.provider}:${externalId}:${event.startTime}:${event.endTime}:${normalizedTitle}`
  }

  return `${event.provider}:${event.startTime}:${event.endTime}:${normalizedTitle}:${normalizedMeetingUrl}`
}

function getEventScore(event: CalendarEvent): number {
  let score = 0
  if (event.meetingUrl) score += 4
  if (event.attendees.length > 0) score += 2
  if (event.title && event.title !== 'Untitled') score += 1
  return score
}

function pickPreferredEvent(current: CalendarEvent, incoming: CalendarEvent): CalendarEvent {
  const currentScore = getEventScore(current)
  const incomingScore = getEventScore(incoming)

  if (incomingScore > currentScore) return incoming
  if (incomingScore < currentScore) return current
  return incoming.syncedAt >= current.syncedAt ? incoming : current
}

export function dedupeCalendarEvents(events: CalendarEvent[]): CalendarEvent[] {
  const deduped = new Map<string, CalendarEvent>()

  for (const event of events) {
    const key = getEventKey(event)
    const existing = deduped.get(key)
    deduped.set(key, existing ? pickPreferredEvent(existing, event) : event)
  }

  return [...deduped.values()].sort((a, b) => a.startTime - b.startTime)
}
