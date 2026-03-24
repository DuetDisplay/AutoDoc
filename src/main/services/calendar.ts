import { shell } from 'electron'
import http from 'http'
import { google } from 'googleapis'
import { OAuth2Client, CodeChallengeMethod } from 'google-auth-library'
import crypto from 'crypto'
import { URL } from 'url'
import { saveTokens, loadTokens, clearTokens } from './token-store'
import { GOOGLE_CALENDAR_SCOPES, CALENDAR_SYNC_INTERVAL_MS } from '../../shared/constants'
import type { CalendarEvent } from '../../shared/types'

const OAUTH_PORT = 42813
const REDIRECT_URI = `http://127.0.0.1:${OAUTH_PORT}`

// For development, set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET env vars.
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? ''
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? ''

export class CalendarService {
  private oauth2Client: OAuth2Client
  private syncInterval: ReturnType<typeof setInterval> | null = null
  private onEventsUpdated: ((events: CalendarEvent[]) => void) | null = null

  constructor() {
    this.oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI)

    this.oauth2Client.on('tokens', (newTokens) => {
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
    const codes = await this.oauth2Client.generateCodeVerifierAsync()
    const state = crypto.randomBytes(16).toString('hex')

    const authUrl = this.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: GOOGLE_CALENDAR_SCOPES,
      code_challenge_method: CodeChallengeMethod.S256,
      code_challenge: codes.codeChallenge,
      state,
    })

    await shell.openExternal(authUrl)

    const code = await new Promise<string>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const url = new URL(req.url!, `http://127.0.0.1:${OAUTH_PORT}`)
        const returnedState = url.searchParams.get('state')
        const returnedCode = url.searchParams.get('code')
        const error = url.searchParams.get('error')

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

        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<html><body><p>Connected to Google Calendar! You may close this tab.</p></body></html>')
        server.close()
        resolve(returnedCode!)
      })

      server.listen(OAUTH_PORT, '127.0.0.1')
      server.on('error', reject)
    })

    const { tokens } = await this.oauth2Client.getToken({
      code,
      codeVerifier: codes.codeVerifier,
    })
    this.oauth2Client.setCredentials(tokens)
    saveTokens(tokens)
  }

  async disconnect(): Promise<void> {
    this.stopSync()
    this.oauth2Client.setCredentials({})
    clearTokens()
  }

  async fetchUpcomingEvents(maxResults = 20): Promise<CalendarEvent[]> {
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
