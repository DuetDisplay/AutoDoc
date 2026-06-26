import { shell } from 'electron'
import http from 'http'
import { google } from 'googleapis'
import { OAuth2Client } from 'google-auth-library'
import crypto from 'crypto'
import { URL } from 'url'
import { saveTokensForAccount, loadTokensForAccount, clearTokensForAccount, hasTokensForAccount } from './token-store'
import type { CalendarEvent, CalendarAccount } from '../../shared/types'
import type { CalendarProvider } from './calendar-types'
import { logAutodocFailure } from './autodoc-log'
import { CalendarTransientError, isTransientCalendarError } from './calendar-error-classification'
import { requireConfiguredAuthWorkerUrl } from './distribution-config'
import { parseGoogleEventTime } from './calendar-time'

const OAUTH_PORT = 42813
const OAUTH_CALLBACK_TIMEOUT_MS = 10 * 60 * 1000
const CLIENT_ID = '610162912921-4k5ljde2b6bf70idvq4kpdit343c1v8g.apps.googleusercontent.com'
function extractEmailFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null

  try {
    const [, payload] = idToken.split('.')
    if (!payload) return null

    const normalizedPayload = payload.replace(/-/g, '+').replace(/_/g, '/')
    const paddedPayload = normalizedPayload.padEnd(Math.ceil(normalizedPayload.length / 4) * 4, '=')
    const parsed = JSON.parse(Buffer.from(paddedPayload, 'base64').toString('utf-8')) as { email?: string }
    return parsed.email?.trim() || null
  } catch {
    return null
  }
}

export class GoogleCalendarProvider implements CalendarProvider {
  readonly providerType = 'google' as const

  // Per-account OAuth clients — created on demand
  private clients = new Map<string, OAuth2Client>()
  private pendingConnect: { cancel: () => void; closed: Promise<void> } | null = null

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
    const authWorkerUrl = requireConfiguredAuthWorkerUrl()
    const authUrl = `${authWorkerUrl}/auth/google?state=${encodeURIComponent(state)}`
    const callbackPromise = this.waitForCallback(state)
    await shell.openExternal(authUrl)

    const result = await callbackPromise

    const accountId = crypto.randomUUID()
    const client = new google.auth.OAuth2(CLIENT_ID)
    client.on('tokens', (newTokens) => {
      const existing = loadTokensForAccount(accountId) ?? {}
      saveTokensForAccount(accountId, { ...existing, ...newTokens })
    })
    client.setCredentials(result.tokens)
    this.clients.set(accountId, client)
    saveTokensForAccount(accountId, result.tokens)

    // The OAuth id_token already carries the account email, so read it locally to
    // return immediately. Only fall back to the network lookup (calendar list /
    // userinfo) when the token doesn't include it, so a successful sign-in surfaces
    // to the UI without waiting on an extra round-trip.
    const idToken = (result.tokens as { id_token?: string }).id_token
    const email = extractEmailFromIdToken(idToken) ?? (await this.fetchAccountEmail(accountId)) ?? ''

    return {
      id: accountId,
      provider: 'google',
      email,
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

  private waitForCallback(expectedState: string): Promise<{ tokens: object }> {
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

        // If state doesn't match, ignore — might be for another provider
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

        let tokens: Record<string, unknown>
        try {
          tokens = JSON.parse(atob(tokenData))
        } catch {
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end('<html><body><p>Invalid token data. Please try again.</p></body></html>')
          rejectAndClose(new Error('Invalid token data'))
          return
        }

        if (tokens.expires_in && !tokens.expiry_date) {
          tokens.expiry_date = Date.now() + (tokens.expires_in as number) * 1000
        }

        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<html><body><p>Connected to Google Calendar! You may close this tab.</p></body></html>')
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
            // The browser keeps the loopback socket alive, so server.close() would
            // otherwise wait for its idle timeout (the 2-3s "stuck connecting" lag).
            // Drop those sockets so close() resolves right away.
            ;(server as { closeAllConnections?: () => void }).closeAllConnections?.()
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

      function resolveAndClose(result: { tokens: object }): void {
        if (settled) return
        settled = true
        // Surface the result immediately; tokens are already in hand. Tearing down
        // the loopback server is just cleanup and must not delay the UI.
        resolve(result)
        void cleanup()
      }

      function rejectAndClose(error: Error): void {
        if (settled) return
        settled = true
        reject(error)
        void cleanup()
      }

      server.listen(OAUTH_PORT, '127.0.0.1')
      server.on('error', rejectAndClose)
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
      startTime: parseGoogleEventTime(event.start),
      endTime: parseGoogleEventTime(event.end),
      isAllDay: Boolean(event.start?.date && event.end?.date),
      attendees: (event.attendees ?? []).map((a) => a.email ?? '').filter(Boolean),
      meetingUrl: this.extractMeetingUrl(event),
      autoRecord: 'off' as const,
      syncedAt: Date.now(),
    }))
  }

  async fetchAccountEmail(accountId: string): Promise<string | null> {
    await this.refreshIfNeeded(accountId)
    const client = this.getClient(accountId)

    try {
      const calendar = google.calendar({ version: 'v3', auth: client })
      const primaryCalendar = await calendar.calendarList.get({ calendarId: 'primary' })
      const calendarId = primaryCalendar.data.id?.trim()
      if (calendarId?.includes('@')) {
        return calendarId
      }
    } catch {
      // Fall through to user info and token claims.
    }

    const tokens = client.credentials as typeof client.credentials & { id_token?: string }
    try {
      const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      })
      if (res.ok) {
        const data = await res.json() as { email?: string }
        if (data.email) return data.email
      }
    } catch {
      // Fall through to token claims.
    }

    return extractEmailFromIdToken(tokens.id_token)
  }

  private async refreshIfNeeded(accountId: string): Promise<void> {
    const client = this.getClient(accountId)
    const creds = client.credentials
    if (!creds.refresh_token) return
    if (creds.expiry_date && creds.expiry_date > Date.now() + 5 * 60_000) return

    try {
      const authWorkerUrl = requireConfiguredAuthWorkerUrl()
      const response = await fetch(`${authWorkerUrl}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: creds.refresh_token }),
      })

      if (!response.ok) {
        const responseText = await response.text()
        const error = new Error(`Google token refresh failed: ${response.status} ${responseText}`)
        if (isTransientCalendarError(error)) {
          throw new CalendarTransientError('Google token refresh failed due to transient network conditions', {
            cause: error
          })
        }
        console.error('Google token refresh failed:', responseText)
        logAutodocFailure({
          area: 'calendar',
          message: 'Google token refresh failed',
          error,
          context: {
            provider: 'google',
            status: response.status,
          },
        })
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
      if (isTransientCalendarError(err)) {
        throw new CalendarTransientError('Google token refresh failed due to transient network conditions', {
          cause: err
        })
      }
      console.error('Google token refresh error:', err)
      logAutodocFailure({
        area: 'calendar',
        message: 'Google token refresh errored',
        error: err,
        context: {
          provider: 'google',
        },
      })
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
