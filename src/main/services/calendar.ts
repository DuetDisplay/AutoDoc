import { shell } from 'electron'
import http from 'http'
import { google } from 'googleapis'
import { OAuth2Client } from 'google-auth-library'
import crypto from 'crypto'
import { URL } from 'url'
import { saveTokens, loadTokens, clearTokens } from './token-store'
import { GOOGLE_CALENDAR_SCOPES, CALENDAR_SYNC_INTERVAL_MS } from '../../shared/constants'
import type { CalendarEvent } from '../../shared/types'

const OAUTH_PORT = 42813
const CLIENT_ID = '610162912921-4k5ljde2b6bf70idvq4kpdit343c1v8g.apps.googleusercontent.com'
const AUTH_WORKER_URL = 'https://autodoc-auth.duetdisplay.workers.dev'

export class CalendarService {
  private oauth2Client: OAuth2Client
  private syncInterval: ReturnType<typeof setInterval> | null = null
  private onEventsUpdated: ((events: CalendarEvent[]) => void) | null = null

  constructor() {
    this.oauth2Client = new google.auth.OAuth2(CLIENT_ID)

    this.oauth2Client.on('tokens', async (newTokens) => {
      // If we get new tokens via the library's auto-refresh, save them
      const existing = loadTokens() ?? {}
      saveTokens({ ...existing, ...newTokens })
    })
  }

  isConnected(): boolean {
    return this.oauth2Client.credentials?.access_token != null
      || this.oauth2Client.credentials?.refresh_token != null
  }

  async initialize(): Promise<boolean> {
    const tokens = loadTokens()
    if (tokens) {
      this.oauth2Client.setCredentials(tokens)
      return true
    }
    return false
  }

  async connect(): Promise<void> {
    const state = crypto.randomBytes(16).toString('hex')

    // Open the auth worker URL — it handles the Google OAuth flow
    const authUrl = `${AUTH_WORKER_URL}/auth/google?state=${encodeURIComponent(state)}`
    await shell.openExternal(authUrl)

    // Wait for the worker to redirect back to localhost with tokens
    const result = await new Promise<{ tokens: object }>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const url = new URL(req.url!, `http://127.0.0.1:${OAUTH_PORT}`)
        const returnedState = url.searchParams.get('state')
        const error = url.searchParams.get('error')
        const tokenData = url.searchParams.get('tokens')

        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end('<html><body><p>Authorization failed. You may close this tab.</p></body></html>')
          server.close()
          reject(new Error(error))
          return
        }

        if (returnedState !== state) {
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end('<html><body><p>State mismatch. Please try again.</p></body></html>')
          server.close()
          reject(new Error('State mismatch'))
          return
        }

        if (!tokenData) {
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end('<html><body><p>Missing token data. Please try again.</p></body></html>')
          server.close()
          reject(new Error('Missing token data'))
          return
        }

        let tokens: object
        try {
          tokens = JSON.parse(atob(tokenData))
        } catch {
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end('<html><body><p>Invalid token data. Please try again.</p></body></html>')
          server.close()
          reject(new Error('Invalid token data'))
          return
        }

        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<html><body><p>Connected to Google Calendar! You may close this tab.</p></body></html>')
        server.close()
        resolve({ tokens })
      })

      server.listen(OAUTH_PORT, '127.0.0.1')
      server.on('error', reject)
    })

    this.oauth2Client.setCredentials(result.tokens)
    saveTokens(result.tokens)
  }

  async disconnect(): Promise<void> {
    this.stopSync()
    this.oauth2Client.setCredentials({})
    clearTokens()
  }

  async fetchUpcomingEvents(maxResults = 20): Promise<CalendarEvent[]> {
    // Refresh token via worker if needed
    await this.refreshIfNeeded()

    const calendar = google.calendar({ version: 'v3', auth: this.oauth2Client })

    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: new Date().toISOString(),
      maxResults,
      singleEvents: true,
      orderBy: 'startTime',
    })

    const items = response.data.items ?? []

    return items.map((event) => ({
      id: event.id ?? crypto.randomUUID(),
      googleEventId: event.id ?? '',
      title: event.summary ?? 'Untitled',
      startTime: new Date(event.start?.dateTime ?? event.start?.date ?? '').getTime(),
      endTime: new Date(event.end?.dateTime ?? event.end?.date ?? '').getTime(),
      attendees: (event.attendees ?? []).map((a) => a.email ?? '').filter(Boolean),
      meetingUrl: this.extractMeetingUrl(event),
      autoRecord: false,
      syncedAt: Date.now(),
    }))
  }

  startSync(callback: (events: CalendarEvent[]) => void): void {
    this.onEventsUpdated = callback
    // Fetch immediately on start
    this.fetchUpcomingEvents()
      .then((events) => this.onEventsUpdated?.(events))
      .catch((err) => console.error('Initial calendar sync failed:', err))

    this.syncInterval = setInterval(async () => {
      try {
        const events = await this.fetchUpcomingEvents()
        this.onEventsUpdated?.(events)
      } catch (err) {
        console.error('Calendar sync failed:', err)
      }
    }, CALENDAR_SYNC_INTERVAL_MS)
  }

  stopSync(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval)
      this.syncInterval = null
    }
    this.onEventsUpdated = null
  }

  private async refreshIfNeeded(): Promise<void> {
    const creds = this.oauth2Client.credentials
    if (!creds.expiry_date || !creds.refresh_token) return

    // Refresh if token expires within 5 minutes
    if (creds.expiry_date > Date.now() + 5 * 60_000) return

    try {
      const response = await fetch(`${AUTH_WORKER_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: creds.refresh_token }),
      })

      if (!response.ok) {
        console.error('Token refresh failed:', await response.text())
        return
      }

      const newTokens = await response.json() as { access_token: string; expires_in: number }
      const updated = {
        ...creds,
        access_token: newTokens.access_token,
        expiry_date: Date.now() + newTokens.expires_in * 1000,
      }

      this.oauth2Client.setCredentials(updated)
      saveTokens(updated)
    } catch (err) {
      console.error('Token refresh error:', err)
    }
  }

  private extractMeetingUrl(event: { hangoutLink?: string | null; conferenceData?: { entryPoints?: { entryPointType?: string | null; uri?: string | null }[] } | null; location?: string | null; description?: string | null }): string | null {
    if (event.hangoutLink) {
      return event.hangoutLink
    }

    const entryPoints = event.conferenceData?.entryPoints ?? []
    const videoEntry = entryPoints.find((ep) => ep.entryPointType === 'video')
    if (videoEntry?.uri) {
      return videoEntry.uri
    }

    const location = event.location ?? ''
    const locationMatch = location.match(
      /https?:\/\/[^\s,]*(zoom\.us\/j|teams\.microsoft\.com\/l\/meetup-join|meet\.google\.com|webex\.com\/meet)[^\s,]*/i
    )
    if (locationMatch) {
      return locationMatch[0]
    }

    const description = event.description ?? ''
    const descMatch = description.match(
      /https?:\/\/[^\s<"']*(zoom\.us\/j|teams\.microsoft\.com\/l\/meetup-join|meet\.google\.com|webex\.com\/meet)[^\s<"']*/i
    )
    if (descMatch) {
      return descMatch[0]
    }

    return null
  }
}
