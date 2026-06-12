import { shell } from 'electron'
import http from 'http'
import crypto from 'crypto'
import { URL } from 'url'
import { saveTokensForAccount, loadTokensForAccount, clearTokensForAccount, hasTokensForAccount } from './token-store'
import type { CalendarEvent, CalendarAccount, OAuthTokens } from '../../shared/types'
import type { CalendarProvider } from './calendar-types'
import { logAutodocFailure } from './autodoc-log'
import {
  CalendarTransientError,
  ReconnectRequiredCalendarAuthError,
  UnsupportedCalendarAccountError,
  isTransientCalendarError,
  isReconnectRequiredMicrosoftAuthError,
  isUnsupportedMicrosoftMailboxError
} from './calendar-error-classification'
import { requireConfiguredAuthWorkerUrl } from './distribution-config'

const OAUTH_PORT = 42813
const OAUTH_CALLBACK_TIMEOUT_MS = 10 * 60 * 1000
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'

function extractEmailFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null

  try {
    const [, payload] = idToken.split('.')
    if (!payload) return null

    const normalizedPayload = payload.replace(/-/g, '+').replace(/_/g, '/')
    const paddedPayload = normalizedPayload.padEnd(Math.ceil(normalizedPayload.length / 4) * 4, '=')
    const parsed = JSON.parse(Buffer.from(paddedPayload, 'base64').toString('utf-8')) as {
      email?: string
      preferred_username?: string
      upn?: string
    }
    return parsed.email?.trim() || parsed.preferred_username?.trim() || parsed.upn?.trim() || null
  } catch {
    return null
  }
}

interface GraphEvent {
  id: string
  subject?: string
  start?: { dateTime?: string; timeZone?: string }
  end?: { dateTime?: string; timeZone?: string }
  attendees?: { emailAddress?: { address?: string } }[]
  onlineMeeting?: { joinUrl?: string }
  location?: { displayName?: string }
  body?: { content?: string }
  seriesMasterId?: string
}

interface GraphEventsResponse {
  value?: GraphEvent[]
  '@odata.nextLink'?: string
}

export class MicrosoftCalendarProvider implements CalendarProvider {
  readonly providerType = 'microsoft' as const

  private tokenCache = new Map<string, OAuthTokens>()
  private pendingConnect: { cancel: () => void; closed: Promise<void> } | null = null

  private getTokens(accountId: string): OAuthTokens | null {
    let tokens = this.tokenCache.get(accountId)
    if (!tokens) {
      tokens = loadTokensForAccount(accountId) as OAuthTokens | null ?? undefined
      if (tokens) this.tokenCache.set(accountId, tokens)
    }
    return tokens ?? null
  }

  isConnected(accountId: string): boolean {
    return hasTokensForAccount(accountId)
  }

  async connect(): Promise<CalendarAccount> {
    const state = crypto.randomBytes(16).toString('hex')
    const statePayload = JSON.stringify({ provider: 'microsoft', nonce: state })
    const encodedState = Buffer.from(statePayload).toString('base64url')
    const authWorkerUrl = requireConfiguredAuthWorkerUrl()
    const authUrl = `${authWorkerUrl}/auth/microsoft?state=${encodeURIComponent(encodedState)}`
    const callbackPromise = this.waitForCallback(encodedState)

    await shell.openExternal(authUrl)

    const { tokens } = await callbackPromise
    if (tokens.expires_in && !tokens.expiry_date) {
      tokens.expiry_date = Date.now() + tokens.expires_in * 1000
    }

    const accountId = crypto.randomUUID()
    saveTokensForAccount(accountId, tokens)
    this.tokenCache.set(accountId, tokens)

    const email = await this.fetchAccountEmail(accountId)

    return {
      id: accountId,
      provider: 'microsoft',
      email: email ?? '',
      connectedAt: Date.now(),
    }
  }

  async cancelConnect(): Promise<void> {
    const pending = this.pendingConnect
    if (!pending) return
    pending.cancel()
    // Wait for the loopback server to fully close so a superseding attempt can
    // rebind the OAuth port without hitting EADDRINUSE.
    await pending.closed
  }

  private waitForCallback(expectedState: string): Promise<{ tokens: OAuthTokens & { expires_in?: number } }> {
    return new Promise((resolve, reject) => {
      let settled = false
      let markClosed: () => void = () => {}
      const closed = new Promise<void>((resolveClosed) => {
        markClosed = resolveClosed
      })
      const server = http.createServer((req, res) => {
        const url = new URL(req.url!, `http://127.0.0.1:${OAUTH_PORT}`)
        const returnedState = url.searchParams.get('state')
        const error = url.searchParams.get('error')
        const tokenData = url.searchParams.get('tokens')

        if (returnedState !== expectedState) {
          res.writeHead(404, { 'Content-Type': 'text/html' })
          res.end('<html><body><p>Unknown calendar authorization request.</p></body></html>')
          return
        }

        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end('<html><body><p>Authorization failed. You may close this tab.</p></body></html>')
          rejectAndClose(new Error(error))
          return
        }

        if (!tokenData) {
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end('<html><body><p>Missing token data. Please try again.</p></body></html>')
          rejectAndClose(new Error('Missing token data'))
          return
        }

        let tokens: OAuthTokens & { expires_in?: number }
        try {
          tokens = JSON.parse(atob(tokenData)) as OAuthTokens & { expires_in?: number }
        } catch {
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end('<html><body><p>Invalid token data. Please try again.</p></body></html>')
          rejectAndClose(new Error('Invalid token data'))
          return
        }

        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<html><body><p>Connected to Microsoft Outlook! You may close this tab.</p></body></html>')
        resolveAndClose({ tokens })
      })

      const timeout = setTimeout(() => {
        rejectAndClose(new Error('Calendar connection timed out'))
      }, OAUTH_CALLBACK_TIMEOUT_MS)
      const cancel = (): void => rejectAndClose(new Error('Calendar connection cancelled'))
      this.pendingConnect = { cancel, closed }

      const closeServer = (): Promise<void> => {
        return new Promise((resolveClose) => {
          try {
            server.close(() => resolveClose())
          } catch {
            // The server may not have started listening yet.
            resolveClose()
          }
        })
      }

      const cleanup = async (): Promise<void> => {
        clearTimeout(timeout)
        if (this.pendingConnect?.cancel === cancel) {
          this.pendingConnect = null
        }
        await closeServer()
        markClosed()
      }

      function resolveAndClose(result: { tokens: OAuthTokens & { expires_in?: number } }): void {
        if (settled) return
        settled = true
        void cleanup().then(() => resolve(result))
      }

      function rejectAndClose(error: Error): void {
        if (settled) return
        settled = true
        void cleanup().then(() => reject(error))
      }

      server.listen(OAUTH_PORT, '127.0.0.1')
      server.on('error', rejectAndClose)
    })
  }

  async disconnect(accountId: string): Promise<void> {
    clearTokensForAccount(accountId)
    this.tokenCache.delete(accountId)
  }

  async fetchUpcomingEvents(accountId: string): Promise<CalendarEvent[]> {
    const now = new Date()
    // Use 7-day window — Microsoft calendarView requires endDateTime unlike Google's open-ended query
    const end = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
    return this.fetchEvents(accountId, now.toISOString(), end.toISOString(), 20)
  }

  async fetchRecentEvents(accountId: string, daysBack = 7): Promise<CalendarEvent[]> {
    const now = new Date()
    const start = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000)
    return this.fetchEvents(accountId, start.toISOString(), now.toISOString())
  }

  async refreshTokens(accountId: string): Promise<void> {
    await this.refreshIfNeeded(accountId)
  }

  private async fetchEvents(accountId: string, startDateTime: string, endDateTime: string, maxResults?: number): Promise<CalendarEvent[]> {
    await this.refreshIfNeeded(accountId)

    const tokens = this.getTokens(accountId)
    if (!tokens?.access_token) throw new Error('No access token for Microsoft account')

    const allEvents: GraphEvent[] = []
    const top = maxResults ?? 100
    let url: string | null = `${GRAPH_BASE}/me/calendarView?startDateTime=${encodeURIComponent(startDateTime)}&endDateTime=${encodeURIComponent(endDateTime)}&$top=${top}&$orderby=start/dateTime`
    const MAX_PAGES = 20

    for (let page = 0; url && page < MAX_PAGES; page++) {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          Prefer: 'outlook.timezone="UTC"',
        },
      })

      if (!res.ok) {
        const text = await res.text()
        const error = new Error(`Microsoft Graph API error ${res.status}: ${text.slice(0, 200)}`)
        if (isUnsupportedMicrosoftMailboxError(error)) {
          throw new UnsupportedCalendarAccountError(
            'Microsoft mailbox is not supported by Microsoft Graph calendar APIs.'
          )
        }
        if (isReconnectRequiredMicrosoftAuthError(error)) {
          throw new ReconnectRequiredCalendarAuthError(
            'Microsoft Outlook needs to be reconnected to resume calendar sync.'
          )
        }
        throw error
      }

      const data = await res.json() as GraphEventsResponse
      if (data.value) allEvents.push(...data.value)
      url = data['@odata.nextLink'] ?? null
    }

    return allEvents.map((event) => this.mapEvent(accountId, event))
  }

  private mapEvent(accountId: string, event: GraphEvent): CalendarEvent {
    return {
      id: `microsoft_${event.id}`,
      externalId: event.id,
      accountId,
      provider: 'microsoft' as const,
      recurringEventId: event.seriesMasterId ?? null,
      title: event.subject ?? 'Untitled',
      startTime: event.start?.dateTime ? new Date(event.start.dateTime + 'Z').getTime() : 0,
      endTime: event.end?.dateTime ? new Date(event.end.dateTime + 'Z').getTime() : 0,
      attendees: (event.attendees ?? [])
        .map((a) => a.emailAddress?.address ?? '')
        .filter(Boolean),
      meetingUrl: this.extractMeetingUrl(event),
      autoRecord: 'off' as const,
      syncedAt: Date.now(),
    }
  }

  private extractMeetingUrl(event: GraphEvent): string | null {
    if (event.onlineMeeting?.joinUrl) return event.onlineMeeting.joinUrl

    const urlPattern = /https?:\/\/[^\s<"']*(zoom\.us\/j|teams\.microsoft\.com\/l\/meetup-join|meet\.google\.com|webex\.com\/meet)[^\s<"']*/i

    const location = event.location?.displayName ?? ''
    const locationMatch = location.match(urlPattern)
    if (locationMatch) return locationMatch[0]

    const body = event.body?.content ?? ''
    const bodyMatch = body.match(urlPattern)
    if (bodyMatch) return bodyMatch[0]

    return null
  }

  async fetchAccountEmail(accountId: string): Promise<string | null> {
    const tokens = this.getTokens(accountId)
    if (!tokens?.access_token) {
      return extractEmailFromIdToken((tokens as (OAuthTokens & { id_token?: string }) | null)?.id_token)
    }

    try {
      const res = await fetch(`${GRAPH_BASE}/me`, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      })
      if (res.ok) {
        const data = await res.json() as { mail?: string; userPrincipalName?: string }
        return (
          data.mail ||
          data.userPrincipalName ||
          extractEmailFromIdToken((tokens as OAuthTokens & { id_token?: string }).id_token)
        )
      }
    } catch {
      // Fall through to token claims.
    }
    return extractEmailFromIdToken((tokens as OAuthTokens & { id_token?: string }).id_token)
  }

  private async refreshIfNeeded(accountId: string): Promise<void> {
    const tokens = this.getTokens(accountId)
    if (!tokens?.refresh_token) return
    if (tokens.expiry_date && tokens.expiry_date > Date.now() + 5 * 60_000) return

    try {
      const authWorkerUrl = requireConfiguredAuthWorkerUrl()
      const response = await fetch(`${authWorkerUrl}/microsoft/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: tokens.refresh_token }),
      })

      if (!response.ok) {
        const responseText = await response.text()
        const error = new Error(
          `Microsoft token refresh failed: ${response.status} ${responseText}`
        )
        if (isTransientCalendarError(error)) {
          throw new CalendarTransientError(
            'Microsoft token refresh failed due to transient network conditions',
            { cause: error }
          )
        }
        if (isReconnectRequiredMicrosoftAuthError(error)) {
          throw new ReconnectRequiredCalendarAuthError(
            'Microsoft Outlook needs to be reconnected to resume calendar sync.'
          )
        }
        console.error('Microsoft token refresh failed:', responseText)
        logAutodocFailure({
          area: 'calendar',
          message: 'Microsoft token refresh failed',
          error,
          context: {
            provider: 'microsoft',
            status: response.status,
          },
        })
        return
      }

      const newTokens = await response.json() as { access_token: string; expires_in: number }
      const updated: OAuthTokens = {
        ...tokens,
        access_token: newTokens.access_token,
        expiry_date: Date.now() + newTokens.expires_in * 1000,
      }

      saveTokensForAccount(accountId, updated)
      this.tokenCache.set(accountId, updated)
    } catch (err) {
      if (isTransientCalendarError(err)) {
        throw new CalendarTransientError(
          'Microsoft token refresh failed due to transient network conditions',
          { cause: err }
        )
      }
      if (err instanceof ReconnectRequiredCalendarAuthError) {
        throw err
      }
      console.error('Microsoft token refresh error:', err)
      logAutodocFailure({
        area: 'calendar',
        message: 'Microsoft token refresh errored',
        error: err,
        context: {
          provider: 'microsoft',
        },
      })
    }
  }
}
