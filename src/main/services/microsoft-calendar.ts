import { shell } from 'electron'
import http from 'http'
import crypto from 'crypto'
import { URL } from 'url'
import { saveTokensForAccount, loadTokensForAccount, clearTokensForAccount, hasTokensForAccount } from './token-store'
import type { CalendarEvent, CalendarAccount, OAuthTokens } from '../../shared/types'
import type { CalendarProvider } from './calendar-types'

const OAUTH_PORT = 42813
const AUTH_WORKER_URL = 'https://autodoc-auth.duetdisplay.workers.dev'
// TODO: Replace with actual Azure AD Application (client) ID after app registration
const MICROSOFT_CLIENT_ID = 'YOUR_MICROSOFT_CLIENT_ID'

const MICROSOFT_AUTH_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize'
const MICROSOFT_SCOPES = 'Calendars.Read User.Read offline_access'
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
    if (MICROSOFT_CLIENT_ID === 'YOUR_MICROSOFT_CLIENT_ID') {
      throw new Error('Microsoft OAuth client ID is not configured. Register an Azure AD app and set MICROSOFT_CLIENT_ID.')
    }

    const state = crypto.randomBytes(16).toString('hex')
    const statePayload = JSON.stringify({ provider: 'microsoft', nonce: state })
    const encodedState = Buffer.from(statePayload).toString('base64url')

    const params = new URLSearchParams({
      client_id: MICROSOFT_CLIENT_ID,
      response_type: 'code',
      redirect_uri: `http://localhost:${OAUTH_PORT}/callback`,
      scope: MICROSOFT_SCOPES,
      state: encodedState,
      response_mode: 'query',
    })

    await shell.openExternal(`${MICROSOFT_AUTH_URL}?${params}`)

    const { code } = await this.waitForCallback(encodedState)

    const tokenResponse = await fetch(`${AUTH_WORKER_URL}/microsoft/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        redirect_uri: `http://localhost:${OAUTH_PORT}/callback`,
      }),
    })

    if (!tokenResponse.ok) {
      const text = await tokenResponse.text()
      throw new Error(`Microsoft token exchange failed: ${text}`)
    }

    const tokens = await tokenResponse.json() as OAuthTokens & { expires_in?: number }
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

  private waitForCallback(expectedState: string): Promise<{ code: string }> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const url = new URL(req.url!, `http://127.0.0.1:${OAUTH_PORT}`)
        const returnedState = url.searchParams.get('state')
        const error = url.searchParams.get('error')
        const code = url.searchParams.get('code')

        if (returnedState !== expectedState) return

        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end('<html><body><p>Authorization failed. You may close this tab.</p></body></html>')
          server.close()
          reject(new Error(error))
          return
        }

        if (!code) {
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end('<html><body><p>Missing authorization code. Please try again.</p></body></html>')
          server.close()
          reject(new Error('Missing authorization code'))
          return
        }

        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<html><body><p>Connected to Microsoft Outlook! You may close this tab.</p></body></html>')
        server.close()
        resolve({ code })
      })

      server.listen(OAUTH_PORT, '127.0.0.1')
      server.on('error', reject)
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
        throw new Error(`Microsoft Graph API error ${res.status}: ${text.slice(0, 200)}`)
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
      const response = await fetch(`${AUTH_WORKER_URL}/microsoft/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: tokens.refresh_token }),
      })

      if (!response.ok) {
        console.error('Microsoft token refresh failed:', await response.text())
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
      console.error('Microsoft token refresh error:', err)
    }
  }
}
