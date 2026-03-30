import { shell } from 'electron'
import http from 'http'
import { google } from 'googleapis'
import { OAuth2Client } from 'google-auth-library'
import crypto from 'crypto'
import { URL } from 'url'
import { saveTokensForAccount, loadTokensForAccount, clearTokensForAccount, hasTokensForAccount } from './token-store'
import type { CalendarEvent, CalendarAccount } from '../../shared/types'
import type { CalendarProvider } from './calendar-types'

const OAUTH_PORT = 42813
const CLIENT_ID = '610162912921-4k5ljde2b6bf70idvq4kpdit343c1v8g.apps.googleusercontent.com'
const AUTH_WORKER_URL = 'https://autodoc-auth.duetdisplay.workers.dev'

export class GoogleCalendarProvider implements CalendarProvider {
  readonly providerType = 'google' as const

  // Per-account OAuth clients — created on demand
  private clients = new Map<string, OAuth2Client>()

  private getClient(accountId: string): OAuth2Client {
    let client = this.clients.get(accountId)
    if (!client) {
      client = new google.auth.OAuth2(CLIENT_ID)
      client.on('tokens', (newTokens) => {
        const existing = loadTokensForAccount(accountId) ?? {}
        saveTokensForAccount(accountId, { ...existing, ...newTokens })
      })
      // Load existing tokens if available
      const tokens = loadTokensForAccount(accountId)
      if (tokens) client.setCredentials(tokens)
      this.clients.set(accountId, client)
    }
    return client
  }

  isConnected(accountId: string): boolean {
    return hasTokensForAccount(accountId)
  }

  async connect(): Promise<CalendarAccount> {
    const state = crypto.randomBytes(16).toString('hex')

    const authUrl = `${AUTH_WORKER_URL}/auth/google?state=${encodeURIComponent(state)}`
    await shell.openExternal(authUrl)

    const result = await this.waitForCallback(state)

    const accountId = crypto.randomUUID()
    const client = new google.auth.OAuth2(CLIENT_ID)
    client.on('tokens', (newTokens) => {
      const existing = loadTokensForAccount(accountId) ?? {}
      saveTokensForAccount(accountId, { ...existing, ...newTokens })
    })
    client.setCredentials(result.tokens)
    this.clients.set(accountId, client)
    saveTokensForAccount(accountId, result.tokens)

    // Fetch user email
    const email = await this.fetchUserEmail(accountId)

    return {
      id: accountId,
      provider: 'google',
      email,
      connectedAt: Date.now(),
    }
  }

  private waitForCallback(expectedState: string): Promise<{ tokens: object }> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const url = new URL(req.url!, `http://127.0.0.1:${OAUTH_PORT}`)
        const returnedState = url.searchParams.get('state')
        const error = url.searchParams.get('error')
        const tokenData = url.searchParams.get('tokens')

        // If state doesn't match, ignore — might be for another provider
        if (returnedState !== expectedState) return

        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end('<html><body><p>Authorization failed. You may close this tab.</p></body></html>')
          server.close()
          reject(new Error(error))
          return
        }

        if (!tokenData) {
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end('<html><body><p>Missing token data. Please try again.</p></body></html>')
          server.close()
          reject(new Error('Missing token data'))
          return
        }

        let tokens: Record<string, unknown>
        try {
          tokens = JSON.parse(atob(tokenData))
        } catch {
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end('<html><body><p>Invalid token data. Please try again.</p></body></html>')
          server.close()
          reject(new Error('Invalid token data'))
          return
        }

        if (tokens.expires_in && !tokens.expiry_date) {
          tokens.expiry_date = Date.now() + (tokens.expires_in as number) * 1000
        }

        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<html><body><p>Connected to Google Calendar! You may close this tab.</p></body></html>')
        server.close()
        resolve({ tokens })
      })

      server.listen(OAUTH_PORT, '127.0.0.1')
      server.on('error', reject)
    })
  }

  async disconnect(accountId: string): Promise<void> {
    clearTokensForAccount(accountId)
    this.clients.delete(accountId)
  }

  async fetchUpcomingEvents(accountId: string): Promise<CalendarEvent[]> {
    return this.fetchEvents(accountId, { timeMin: new Date().toISOString(), maxResults: 20 })
  }

  async fetchRecentEvents(accountId: string, daysBack = 7): Promise<CalendarEvent[]> {
    const since = new Date()
    since.setDate(since.getDate() - daysBack)
    return this.fetchEvents(accountId, { timeMin: since.toISOString(), timeMax: new Date().toISOString(), maxResults: 50 })
  }

  async refreshTokens(accountId: string): Promise<void> {
    await this.refreshIfNeeded(accountId)
  }

  private async fetchEvents(accountId: string, opts: { timeMin: string; timeMax?: string; maxResults: number }): Promise<CalendarEvent[]> {
    await this.refreshIfNeeded(accountId)

    const client = this.getClient(accountId)
    const calendar = google.calendar({ version: 'v3', auth: client })

    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: opts.timeMin,
      ...(opts.timeMax ? { timeMax: opts.timeMax } : {}),
      maxResults: opts.maxResults,
      singleEvents: true,
      orderBy: 'startTime',
    })

    const items = response.data.items ?? []

    return items.map((event) => ({
      id: `google_${event.id ?? crypto.randomUUID()}`,
      externalId: event.id ?? '',
      accountId,
      provider: 'google' as const,
      recurringEventId: event.recurringEventId ?? null,
      title: event.summary ?? 'Untitled',
      startTime: new Date(event.start?.dateTime ?? event.start?.date ?? '').getTime(),
      endTime: new Date(event.end?.dateTime ?? event.end?.date ?? '').getTime(),
      attendees: (event.attendees ?? []).map((a) => a.email ?? '').filter(Boolean),
      meetingUrl: this.extractMeetingUrl(event),
      autoRecord: 'off' as const,
      syncedAt: Date.now(),
    }))
  }

  async fetchUserEmail(accountId: string): Promise<string> {
    await this.refreshIfNeeded(accountId)
    const client = this.getClient(accountId)
    const tokens = client.credentials
    try {
      const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      })
      if (res.ok) {
        const data = await res.json() as { email?: string }
        if (data.email) return data.email
      }
    } catch {
      // Fall through to unknown
    }
    return 'unknown@gmail.com'
  }

  private async refreshIfNeeded(accountId: string): Promise<void> {
    const client = this.getClient(accountId)
    const creds = client.credentials
    if (!creds.refresh_token) return
    if (creds.expiry_date && creds.expiry_date > Date.now() + 5 * 60_000) return

    try {
      const response = await fetch(`${AUTH_WORKER_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: creds.refresh_token }),
      })

      if (!response.ok) {
        console.error('Google token refresh failed:', await response.text())
        return
      }

      const newTokens = await response.json() as { access_token: string; expires_in: number }
      const updated = {
        ...creds,
        access_token: newTokens.access_token,
        expiry_date: Date.now() + newTokens.expires_in * 1000,
      }

      client.setCredentials(updated)
      saveTokensForAccount(accountId, updated)
    } catch (err) {
      console.error('Google token refresh error:', err)
    }
  }

  private extractMeetingUrl(event: { hangoutLink?: string | null; conferenceData?: { entryPoints?: { entryPointType?: string | null; uri?: string | null }[] } | null; location?: string | null; description?: string | null }): string | null {
    if (event.hangoutLink) return event.hangoutLink

    const entryPoints = event.conferenceData?.entryPoints ?? []
    const videoEntry = entryPoints.find((ep) => ep.entryPointType === 'video')
    if (videoEntry?.uri) return videoEntry.uri

    const location = event.location ?? ''
    const locationMatch = location.match(
      /https?:\/\/[^\s,]*(zoom\.us\/j|teams\.microsoft\.com\/l\/meetup-join|meet\.google\.com|webex\.com\/meet)[^\s,]*/i
    )
    if (locationMatch) return locationMatch[0]

    const description = event.description ?? ''
    const descMatch = description.match(
      /https?:\/\/[^\s<"']*(zoom\.us\/j|teams\.microsoft\.com\/l\/meetup-join|meet\.google\.com|webex\.com\/meet)[^\s<"']*/i
    )
    if (descMatch) return descMatch[0]

    return null
  }
}
