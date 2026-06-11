# Multi-Calendar Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Support multiple calendar providers (Google + Microsoft Outlook) with multiple accounts, merged event list, and per-account management.

**Architecture:** Extract a `CalendarProvider` interface from the existing `CalendarService`. Refactor `CalendarService` → `GoogleCalendarProvider`. Add `MicrosoftCalendarProvider`. New `CalendarManager` orchestrates all accounts — connect/disconnect, merged fetch, coordinated sync. Downstream systems (detection, matcher, tray, UI) consume the same merged event array with minimal changes.

**Tech Stack:** Electron, TypeScript, Microsoft Graph API (REST), Google Calendar API v3 (via `googleapis`), Zustand, electron-store, safeStorage

**Spec:** `docs/design/specs/2026-03-27-multi-calendar-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/shared/types.ts` | Modify | Rename `googleEventId` → `externalId`, add `accountId`, `provider`, `CalendarAccount` |
| `src/main/services/calendar-types.ts` | **Create** | `CalendarProvider` interface, `CalendarAccount` re-export |
| `src/main/services/token-store.ts` | Modify | Account-scoped keys, legacy migration helper |
| `src/main/services/calendar.ts` | Modify | Refactor to `GoogleCalendarProvider` implementing `CalendarProvider` |
| `src/main/services/microsoft-calendar.ts` | **Create** | `MicrosoftCalendarProvider` implementing `CalendarProvider` |
| `src/main/services/calendar-manager.ts` | **Create** | `CalendarManager` orchestrator |
| `src/main/services/detection.ts` | Modify | `googleEventId` → `externalId` |
| `src/main/ipc/calendar-ipc.ts` | Modify | Use `CalendarManager`, updated channel signatures |
| `src/main/index.ts` | Modify | Wire `CalendarManager` instead of `CalendarService` |
| `src/preload/ipc.d.ts` | Modify | Updated channel signatures |
| `src/renderer/src/stores/calendar.ts` | Modify | `accounts[]` replaces `isConnected` |
| `src/renderer/src/pages/Settings.tsx` | Modify | Multi-account calendar section |
| `src/renderer/src/pages/Upcoming.tsx` | Modify | Dual-provider connect prompt |
| `src/renderer/src/components/ConnectCalendar.tsx` | Modify | Both provider options |
| `src/renderer/src/components/onboarding/CalendarStep.tsx` | Modify | Both provider options |
| `src/renderer/src/components/EventCard.test.tsx` | Modify | Update `googleEventId` → `externalId` in fixtures |
| `src/main/services/__tests__/transcription.test.ts` | Modify | Update `CalendarService` → `CalendarManager` import and mocks |
| `src/main/services/auto-record-store.ts` | No change | Uses event `id` field which is already provider-agnostic |

---

### Task 1: Update shared types and CalendarProvider interface

**Context:** The foundation layer. Every other task depends on these types being in place. We rename `googleEventId` → `externalId`, add `accountId` and `provider` fields to `CalendarEvent`, add the `CalendarAccount` type, and create the `CalendarProvider` interface.

**Files:**
- Modify: `src/shared/types.ts:47-58`
- Create: `src/main/services/calendar-types.ts`

- [ ] **Step 1: Update `CalendarEvent` in shared types**

In `src/shared/types.ts`, replace the current `CalendarEvent` interface:

```typescript
export interface CalendarAccount {
  id: string
  provider: 'google' | 'microsoft'
  email: string
  connectedAt: number
}

export interface CalendarEvent {
  id: string                          // `{provider}_{externalId}` — unique across providers
  externalId: string                  // provider's native event ID
  accountId: string                   // which connected account owns this event
  provider: 'google' | 'microsoft'   // source provider
  recurringEventId: string | null
  title: string
  startTime: number
  endTime: number
  attendees: string[]
  meetingUrl: string | null
  autoRecord: AutoRecordMode
  syncedAt: number
}
```

- [ ] **Step 2: Create `CalendarProvider` interface**

Create `src/main/services/calendar-types.ts`:

```typescript
import type { CalendarAccount, CalendarEvent } from '../../shared/types'

export interface CalendarProvider {
  readonly providerType: 'google' | 'microsoft'

  connect(): Promise<CalendarAccount>
  disconnect(accountId: string): Promise<void>
  isConnected(accountId: string): boolean

  fetchUpcomingEvents(accountId: string): Promise<CalendarEvent[]>
  fetchRecentEvents(accountId: string, daysBack: number): Promise<CalendarEvent[]>
  refreshTokens(accountId: string): Promise<void>
}
```

- [ ] **Step 3: Fix all `googleEventId` references across the codebase**

These files reference `googleEventId` and must be updated to `externalId`:

1. `src/main/services/calendar.ts:147` — event mapping: `googleEventId: event.id ?? ''` → `externalId: event.id ?? ''`
2. `src/main/services/detection.ts:98` — `matchingEvent.googleEventId` → `matchingEvent.externalId`
3. `src/main/ipc/calendar-ipc.ts:52` — `e.googleEventId` → `e.externalId`
4. `src/renderer/src/components/EventCard.test.tsx:9` — test fixture: `googleEventId: 'google-1'` → `externalId: 'google-1'`

Also add the new required fields to the test fixture in `EventCard.test.tsx`:

```typescript
const mockEvent: CalendarEvent = {
  id: 'evt-1',
  externalId: 'google-1',
  accountId: 'account-1',
  provider: 'google',
  recurringEventId: null,
  title: 'Sprint Planning',
  startTime: new Date('2026-03-24T10:00:00').getTime(),
  endTime: new Date('2026-03-24T10:30:00').getTime(),
  attendees: ['alice@example.com', 'bob@example.com'],
  meetingUrl: 'https://meet.google.com/abc-defg-hij',
  autoRecord: 'off',
  syncedAt: Date.now(),
}
```

- [ ] **Step 4: Verify the app compiles**

Run: `npx tsc --noEmit`
Expected: No errors related to `googleEventId` or missing fields.

- [ ] **Step 5: Run existing tests**

Run: `npx vitest run`
Expected: All tests pass (EventCard tests updated with new fields).

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/main/services/calendar-types.ts src/main/services/detection.ts src/main/ipc/calendar-ipc.ts src/main/services/calendar.ts src/renderer/src/components/EventCard.test.tsx
git commit -m "feat(calendar): add CalendarProvider interface and rename googleEventId to externalId"
```

---

### Task 2: Refactor token store for account-scoped keys

**Context:** Currently the token store uses a single hardcoded key `gcal_tokens`. We need account-scoped keys (`cal_tokens_{accountId}`) and a migration helper that moves the legacy key to the new format.

**Files:**
- Modify: `src/main/services/token-store.ts`
- Create: `src/main/services/__tests__/token-store.test.ts`

- [ ] **Step 1: Write tests for the new token store**

Create `src/main/services/__tests__/token-store.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock electron modules before importing
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
  },
}))

const mockStore = new Map<string, unknown>()
vi.mock('electron-store', () => ({
  default: class {
    get(key: string, fallback?: unknown) { return mockStore.get(key) ?? fallback }
    set(key: string, value: unknown) { mockStore.set(key, value) }
    delete(key: string) { mockStore.delete(key) }
    has(key: string) { return mockStore.has(key) }
  },
}))

import { saveTokensForAccount, loadTokensForAccount, clearTokensForAccount, migrateLegacyTokens } from '../token-store'

beforeEach(() => {
  mockStore.clear()
})

describe('account-scoped token store', () => {
  it('saves and loads tokens for a specific account', () => {
    const tokens = { access_token: 'abc', refresh_token: 'def', expiry_date: 999 }
    saveTokensForAccount('acct-1', tokens)
    const loaded = loadTokensForAccount('acct-1')
    expect(loaded).toEqual(tokens)
  })

  it('returns null for unknown account', () => {
    expect(loadTokensForAccount('unknown')).toBeNull()
  })

  it('clears tokens for a specific account', () => {
    saveTokensForAccount('acct-1', { access_token: 'abc' })
    clearTokensForAccount('acct-1')
    expect(loadTokensForAccount('acct-1')).toBeNull()
  })

  it('isolates tokens between accounts', () => {
    saveTokensForAccount('acct-1', { access_token: 'one' })
    saveTokensForAccount('acct-2', { access_token: 'two' })
    expect(loadTokensForAccount('acct-1')).toEqual({ access_token: 'one' })
    expect(loadTokensForAccount('acct-2')).toEqual({ access_token: 'two' })
  })
})

describe('migrateLegacyTokens', () => {
  it('returns null when no legacy tokens exist', () => {
    expect(migrateLegacyTokens()).toBeNull()
  })

  it('migrates legacy gcal_tokens to account-scoped key', () => {
    const legacyTokens = JSON.stringify({ access_token: 'old', refresh_token: 'old-ref' })
    mockStore.set('gcal_tokens', legacyTokens)
    mockStore.set('gcal_tokens_encrypted', false)

    const accountId = migrateLegacyTokens()
    expect(accountId).toBeTruthy()

    // Legacy key should be deleted
    expect(mockStore.has('gcal_tokens')).toBe(false)

    // New account-scoped key should have the tokens
    const loaded = loadTokensForAccount(accountId!)
    expect(loaded).toEqual({ access_token: 'old', refresh_token: 'old-ref' })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/services/__tests__/token-store.test.ts`
Expected: FAIL — `saveTokensForAccount`, `loadTokensForAccount`, etc. not exported.

- [ ] **Step 3: Implement the refactored token store**

Rewrite `src/main/services/token-store.ts`:

```typescript
import { safeStorage } from 'electron'
import Store from 'electron-store'
import crypto from 'crypto'

const store = new Store({ name: 'autodoc-tokens' })

// Legacy key — used only during migration
const LEGACY_TOKEN_KEY = 'gcal_tokens'

function tokenKey(accountId: string): string {
  return `cal_tokens_${accountId}`
}

function encryptedFlagKey(key: string): string {
  return `${key}_encrypted`
}

function saveRaw(key: string, data: object): void {
  const json = JSON.stringify(data)
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(json)
    store.set(key, encrypted.toString('latin1'))
    store.set(encryptedFlagKey(key), true)
  } else {
    store.set(key, json)
    store.set(encryptedFlagKey(key), false)
  }
}

function loadRaw(key: string): object | null {
  const raw = store.get(key) as string | undefined
  if (!raw) return null

  try {
    const isEncrypted = store.get(encryptedFlagKey(key)) as boolean
    if (isEncrypted && safeStorage.isEncryptionAvailable()) {
      const decrypted = safeStorage.decryptString(Buffer.from(raw, 'latin1'))
      return JSON.parse(decrypted)
    }
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function clearRaw(key: string): void {
  store.delete(key)
  store.delete(encryptedFlagKey(key))
}

// --- Account-scoped API ---

export function saveTokensForAccount(accountId: string, tokens: object): void {
  saveRaw(tokenKey(accountId), tokens)
}

export function loadTokensForAccount(accountId: string): object | null {
  return loadRaw(tokenKey(accountId))
}

export function clearTokensForAccount(accountId: string): void {
  clearRaw(tokenKey(accountId))
}

export function hasTokensForAccount(accountId: string): boolean {
  return store.has(tokenKey(accountId))
}

// --- Legacy migration ---

/**
 * Check for legacy `gcal_tokens` and migrate to account-scoped key.
 * Returns the generated account ID if migration happened, null otherwise.
 */
export function migrateLegacyTokens(): string | null {
  const legacyTokens = loadRaw(LEGACY_TOKEN_KEY)
  if (!legacyTokens) return null

  const accountId = crypto.randomUUID()
  saveRaw(tokenKey(accountId), legacyTokens)
  clearRaw(LEGACY_TOKEN_KEY)

  return accountId
}

// --- Backward-compatible API (used by existing CalendarService during refactor) ---

export function saveTokens(tokens: object): void {
  saveRaw(LEGACY_TOKEN_KEY, tokens)
}

export function loadTokens(): object | null {
  return loadRaw(LEGACY_TOKEN_KEY)
}

export function clearTokens(): void {
  clearRaw(LEGACY_TOKEN_KEY)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/services/__tests__/token-store.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Verify full app compiles**

Run: `npx tsc --noEmit`
Expected: No errors (backward-compat exports still in place).

- [ ] **Step 6: Commit**

```bash
git add src/main/services/token-store.ts src/main/services/__tests__/token-store.test.ts
git commit -m "feat(calendar): add account-scoped token storage with legacy migration"
```

---

### Task 3: Refactor CalendarService → GoogleCalendarProvider

**Context:** Transform the existing `CalendarService` class to implement the `CalendarProvider` interface. The class keeps its OAuth flow and Google API logic but changes to account-scoped token storage and adds `accountId`/`provider` fields to events. The backward-compatible legacy API (`saveTokens`/`loadTokens`) is removed from this class — it now uses the account-scoped functions.

**Files:**
- Modify: `src/main/services/calendar.ts`

- [ ] **Step 1: Refactor CalendarService to GoogleCalendarProvider**

Rewrite `src/main/services/calendar.ts`. Key changes:
- Class name: `GoogleCalendarProvider`
- Implements `CalendarProvider` from `./calendar-types`
- `connect()` returns `CalendarAccount` (fetches email from Google userinfo)
- All methods take `accountId` parameter
- Token ops use `saveTokensForAccount(accountId, ...)` / `loadTokensForAccount(accountId)`
- Event mapping uses `externalId`, `accountId`, `provider: 'google'`
- The `id` field uses `google_${event.id}` format
- Removes `startSync`/`stopSync` (moved to CalendarManager)
- `initialize()` removed (CalendarManager handles it)

**Important:** The Google OAuth flow currently uses a simple hex string as the `state` parameter. The existing auth worker at `autodoc-auth.duetdisplay.workers.dev` passes `state` through to the redirect. We keep the same simple hex format for Google (no JSON encoding needed) since the Google flow goes through the auth worker which returns tokens directly. Only the Microsoft flow uses browser-direct OAuth where `state` routing matters. Each provider spins up its own localhost server — the `CalendarManager.connecting` lock prevents port conflicts.

```typescript
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
    // Keep the same simple state format as the current implementation —
    // the auth worker passes it through and we match on it when the callback arrives
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
```

- [ ] **Step 2: Verify the app compiles**

Run: `npx tsc --noEmit`
Expected: Errors in files that still import `CalendarService` — this is expected, they'll be fixed in later tasks.

- [ ] **Step 3: Commit**

```bash
git add src/main/services/calendar.ts
git commit -m "refactor(calendar): convert CalendarService to GoogleCalendarProvider"
```

---

### Task 4: Create MicrosoftCalendarProvider

**Context:** New provider for Microsoft Outlook calendars using Microsoft Graph API. Same `CalendarProvider` interface as Google. Uses the auth worker for token exchange. The OAuth flow uses the shared localhost callback server with `state` parameter routing.

**Files:**
- Create: `src/main/services/microsoft-calendar.ts`

- [ ] **Step 1: Implement MicrosoftCalendarProvider**

Create `src/main/services/microsoft-calendar.ts`:

```typescript
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

  // Per-account tokens cached in memory
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

    // Exchange code for tokens via auth worker
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

    // Fetch user email
    const email = await this.fetchUserEmail(accountId)

    return {
      id: accountId,
      provider: 'microsoft',
      email,
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
    const end = new Date(now.getTime() + 24 * 60 * 60 * 1000)
    return this.fetchEvents(accountId, now.toISOString(), end.toISOString())
  }

  async fetchRecentEvents(accountId: string, daysBack = 7): Promise<CalendarEvent[]> {
    const now = new Date()
    const start = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000)
    return this.fetchEvents(accountId, start.toISOString(), now.toISOString())
  }

  async refreshTokens(accountId: string): Promise<void> {
    await this.refreshIfNeeded(accountId)
  }

  private async fetchEvents(accountId: string, startDateTime: string, endDateTime: string): Promise<CalendarEvent[]> {
    await this.refreshIfNeeded(accountId)

    const tokens = this.getTokens(accountId)
    if (!tokens?.access_token) throw new Error('No access token for Microsoft account')

    const allEvents: GraphEvent[] = []
    let url: string | null = `${GRAPH_BASE}/me/calendarView?startDateTime=${encodeURIComponent(startDateTime)}&endDateTime=${encodeURIComponent(endDateTime)}&$top=100&$orderby=start/dateTime`

    while (url) {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
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
      provider: 'microsoft',
      recurringEventId: event.seriesMasterId ?? null,
      title: event.subject ?? 'Untitled',
      startTime: event.start?.dateTime ? new Date(event.start.dateTime + 'Z').getTime() : 0,
      endTime: event.end?.dateTime ? new Date(event.end.dateTime + 'Z').getTime() : 0,
      attendees: (event.attendees ?? [])
        .map((a) => a.emailAddress?.address ?? '')
        .filter(Boolean),
      meetingUrl: this.extractMeetingUrl(event),
      autoRecord: 'off',
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

  private async fetchUserEmail(accountId: string): Promise<string> {
    const tokens = this.getTokens(accountId)
    if (!tokens?.access_token) return 'unknown@outlook.com'

    try {
      const res = await fetch(`${GRAPH_BASE}/me`, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      })
      if (res.ok) {
        const data = await res.json() as { mail?: string; userPrincipalName?: string }
        return data.mail || data.userPrincipalName || 'unknown@outlook.com'
      }
    } catch {
      // Fall through
    }
    return 'unknown@outlook.com'
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
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: Compiles (may have errors in other files still using old CalendarService — that's fine).

- [ ] **Step 3: Commit**

```bash
git add src/main/services/microsoft-calendar.ts
git commit -m "feat(calendar): add MicrosoftCalendarProvider for Outlook via Graph API"
```

---

### Task 5: Create CalendarManager orchestrator

**Context:** The CalendarManager is the central piece. It holds references to both providers, manages the account registry (persisted via electron-store), handles connect/disconnect delegation, merged event fetching, coordinated sync, and legacy migration.

**Files:**
- Create: `src/main/services/calendar-manager.ts`

- [ ] **Step 1: Implement CalendarManager**

Create `src/main/services/calendar-manager.ts`:

```typescript
import Store from 'electron-store'
import { migrateLegacyTokens, hasTokensForAccount } from './token-store'
import { GoogleCalendarProvider } from './calendar'
import { MicrosoftCalendarProvider } from './microsoft-calendar'
import type { CalendarProvider } from './calendar-types'
import type { CalendarAccount, CalendarEvent } from '../../shared/types'

const accountStore = new Store<{ accounts: CalendarAccount[] }>({ name: 'autodoc-calendar-accounts' })

export class CalendarManager {
  private providers: Map<string, CalendarProvider>
  private accounts: CalendarAccount[] = []
  private syncInterval: ReturnType<typeof setInterval> | null = null
  private connecting = false

  constructor() {
    this.providers = new Map<string, CalendarProvider>([
      ['google', new GoogleCalendarProvider()],
      ['microsoft', new MicrosoftCalendarProvider()],
    ])
  }

  getAccounts(): CalendarAccount[] {
    return [...this.accounts]
  }

  isConnected(): boolean {
    return this.accounts.length > 0
  }

  async initialize(): Promise<CalendarAccount[]> {
    // Step 1: Load saved accounts
    const saved = accountStore.get('accounts', []) as CalendarAccount[]

    // Step 2: Migrate legacy gcal_tokens if present (and no saved accounts yet)
    const migratedAccountId = migrateLegacyTokens()
    if (migratedAccountId) {
      const googleProvider = this.providers.get('google') as GoogleCalendarProvider

      // Fetch email for the migrated account (best effort)
      let email = 'unknown@gmail.com'
      try {
        email = await googleProvider.fetchUserEmail(migratedAccountId)
      } catch {
        // Token might be expired — email will show as unknown, user can reconnect
      }

      const migratedAccount: CalendarAccount = {
        id: migratedAccountId,
        provider: 'google',
        email,
        connectedAt: Date.now(),
      }

      saved.push(migratedAccount)
      console.log('Migrated legacy Google Calendar account:', migratedAccountId, email)
    }

    // Step 3: Validate each has tokens, remove orphans
    this.accounts = saved.filter((account) => hasTokensForAccount(account.id))

    if (this.accounts.length !== saved.length || migratedAccountId) {
      this.saveAccounts()
    }

    return this.getAccounts()
  }

  async connect(providerType: 'google' | 'microsoft'): Promise<CalendarAccount> {
    if (this.connecting) {
      throw new Error('Another calendar connection is already in progress')
    }

    this.connecting = true
    try {
      const provider = this.providers.get(providerType)
      if (!provider) throw new Error(`Unknown provider: ${providerType}`)

      const account = await provider.connect()
      this.accounts.push(account)
      this.saveAccounts()
      return account
    } finally {
      this.connecting = false
    }
  }

  async disconnect(accountId: string): Promise<void> {
    const account = this.accounts.find((a) => a.id === accountId)
    if (!account) return

    const provider = this.providers.get(account.provider)
    if (provider) {
      await provider.disconnect(accountId)
    }

    this.accounts = this.accounts.filter((a) => a.id !== accountId)
    this.saveAccounts()
  }

  async fetchAllUpcomingEvents(): Promise<CalendarEvent[]> {
    if (this.accounts.length === 0) return []

    const results = await Promise.allSettled(
      this.accounts.map(async (account) => {
        const provider = this.providers.get(account.provider)
        if (!provider) return []
        return provider.fetchUpcomingEvents(account.id)
      })
    )

    const events: CalendarEvent[] = []
    for (let i = 0; i < results.length; i++) {
      const result = results[i]
      if (result.status === 'fulfilled') {
        events.push(...result.value)
      } else {
        console.error(`Failed to fetch events for account ${this.accounts[i].email}:`, result.reason)
      }
    }

    return events.sort((a, b) => a.startTime - b.startTime)
  }

  async fetchAllRecentEvents(daysBack = 7): Promise<CalendarEvent[]> {
    if (this.accounts.length === 0) return []

    const results = await Promise.allSettled(
      this.accounts.map(async (account) => {
        const provider = this.providers.get(account.provider)
        if (!provider) return []
        return provider.fetchRecentEvents(account.id, daysBack)
      })
    )

    const events: CalendarEvent[] = []
    for (let i = 0; i < results.length; i++) {
      const result = results[i]
      if (result.status === 'fulfilled') {
        events.push(...result.value)
      } else {
        console.error(`Failed to fetch recent events for account ${this.accounts[i].email}:`, result.reason)
      }
    }

    return events.sort((a, b) => a.startTime - b.startTime)
  }

  startSync(callback: (events: CalendarEvent[]) => void): void {
    // Fetch immediately
    this.fetchAllUpcomingEvents()
      .then(callback)
      .catch((err) => console.error('Initial calendar sync failed:', err))

    // Then every 5 minutes
    this.syncInterval = setInterval(async () => {
      try {
        const events = await this.fetchAllUpcomingEvents()
        callback(events)
      } catch (err) {
        console.error('Calendar sync failed:', err)
      }
    }, 5 * 60 * 1000)
  }

  stopSync(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval)
      this.syncInterval = null
    }
  }

  private saveAccounts(): void {
    accountStore.set('accounts', this.accounts)
  }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: Compiles. Other files still reference old CalendarService — fixed in next tasks.

- [ ] **Step 3: Commit**

```bash
git add src/main/services/calendar-manager.ts
git commit -m "feat(calendar): add CalendarManager orchestrator for multi-account support"
```

---

### Task 6: Update IPC layer and preload types

**Context:** The calendar IPC handlers need to use `CalendarManager` instead of `CalendarService`. Channel signatures change: `calendar:connect` takes a provider parameter, `calendar:disconnect` takes an accountId, `calendar:is-connected` is replaced by `calendar:get-accounts`.

**Files:**
- Modify: `src/main/ipc/calendar-ipc.ts`
- Modify: `src/preload/ipc.d.ts`

- [ ] **Step 1: Update calendar IPC handlers**

Rewrite `src/main/ipc/calendar-ipc.ts`:

```typescript
import { ipcMain, BrowserWindow } from 'electron'
import type { CalendarManager } from '../services/calendar-manager'
import { setAutoRecord, getAutoRecordMode } from '../services/auto-record-store'
import type { AutoRecordMode, CalendarEvent, CalendarAccount } from '../../shared/types'

export function registerCalendarIpc(
  calendarManager: CalendarManager,
  onEventsUpdated?: (events: CalendarEvent[]) => void,
): void {
  ipcMain.handle('calendar:connect', async (_event, providerType: 'google' | 'microsoft') => {
    const account = await calendarManager.connect(providerType)

    const events = await calendarManager.fetchAllUpcomingEvents()
    const enriched = applyAutoRecordState(events)
    pushEventsToRenderer(enriched)
    onEventsUpdated?.(enriched)

    // Start sync if this is the first account
    if (calendarManager.getAccounts().length === 1) {
      calendarManager.startSync((updatedEvents) => {
        const enrichedUpdated = applyAutoRecordState(updatedEvents)
        pushEventsToRenderer(enrichedUpdated)
        onEventsUpdated?.(enrichedUpdated)
      })
    }

    return account
  })

  ipcMain.handle('calendar:disconnect', async (_event, accountId: string) => {
    await calendarManager.disconnect(accountId)

    if (calendarManager.getAccounts().length === 0) {
      calendarManager.stopSync()
    }

    // Push updated events to renderer
    const events = await calendarManager.fetchAllUpcomingEvents()
    const enriched = applyAutoRecordState(events)
    pushEventsToRenderer(enriched)
    onEventsUpdated?.(enriched)
  })

  ipcMain.handle('calendar:get-accounts', () => {
    return calendarManager.getAccounts()
  })

  ipcMain.handle('calendar:get-events', async () => {
    const events = await calendarManager.fetchAllUpcomingEvents()
    return applyAutoRecordState(events)
  })

  ipcMain.handle('calendar:sync', async () => {
    const events = await calendarManager.fetchAllUpcomingEvents()
    const enriched = applyAutoRecordState(events)
    pushEventsToRenderer(enriched)
    onEventsUpdated?.(enriched)
    return enriched
  })

  ipcMain.handle('calendar:set-auto-record', (_event, eventId: string, recurringEventId: string | null, mode: AutoRecordMode) => {
    setAutoRecord(eventId, recurringEventId, mode)
  })
}

function applyAutoRecordState(events: CalendarEvent[]): CalendarEvent[] {
  return events.map((e) => ({
    ...e,
    autoRecord: getAutoRecordMode(e.externalId, e.recurringEventId),
  }))
}

function pushEventsToRenderer(events: CalendarEvent[]): void {
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    win.webContents.send('calendar:events-updated', events)
  }
}
```

- [ ] **Step 2: Update IPC type definitions**

In `src/preload/ipc.d.ts`, update the calendar-related entries:

In `IpcInvokeEvents`:
```typescript
// Replace these lines:
'calendar:connect': []
'calendar:disconnect': []
'calendar:is-connected': []

// With:
'calendar:connect': [providerType: 'google' | 'microsoft']
'calendar:disconnect': [accountId: string]
'calendar:get-accounts': []
```

In `IpcInvokeReturns`:
```typescript
// Replace these lines:
'calendar:connect': void
'calendar:disconnect': void
'calendar:is-connected': boolean

// With:
'calendar:connect': CalendarAccount
'calendar:disconnect': void
'calendar:get-accounts': CalendarAccount[]
```

Add `CalendarAccount` to the import at the top of the file:
```typescript
import type { AutoRecordMode, CalendarEvent, CalendarAccount, RecordingEntry, ... } from '../shared/types'
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: Errors in `src/main/index.ts` (still using old CalendarService), renderer files (still using `calendar:is-connected`). These are fixed in subsequent tasks.

- [ ] **Step 4: Commit**

```bash
git add src/main/ipc/calendar-ipc.ts src/preload/ipc.d.ts
git commit -m "feat(calendar): update IPC layer for multi-account calendar support"
```

---

### Task 7: Wire CalendarManager into main process

**Context:** Update `src/main/index.ts` to create `CalendarManager` instead of `CalendarService`. The `TranscriptionService` and `registerRecordingIpc` also reference `CalendarService` — they need to be updated to accept `CalendarManager` (or a subset interface).

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/main/services/transcription.ts:30-34`
- Modify: `src/main/ipc/recording-ipc.ts:9,76,90-91,265-266`
- Modify: `src/main/services/__tests__/transcription.test.ts:5,56-61,67,73-78`

- [ ] **Step 1: Update TranscriptionService to accept CalendarManager**

In `src/main/services/transcription.ts`, change the import and constructor:

Replace the import:
```typescript
import type { CalendarService } from './calendar'
```
With:
```typescript
import type { CalendarManager } from './calendar-manager'
```

Replace the constructor parameter type (line ~34):
```typescript
private calendarService: CalendarService,
```
With:
```typescript
private calendarManager: CalendarManager,
```

Then find any usage of `calendarService` in the file and update the method calls. The TranscriptionService uses `calendarService.isConnected()` and `calendarService.fetchRecentEvents()` — update to:
- `this.calendarManager.isConnected()` (works as-is — CalendarManager has this method)
- `this.calendarManager.fetchAllRecentEvents(daysBack)` (renamed method)

- [ ] **Step 2: Update recording IPC to accept CalendarManager**

In `src/main/ipc/recording-ipc.ts`:

Replace the import:
```typescript
import type { CalendarService } from '../services/calendar'
```
With:
```typescript
import type { CalendarManager } from '../services/calendar-manager'
```

Update the function signature:
```typescript
export function registerRecordingIpc(
  recordingService: RecordingService,
  transcriptionService: TranscriptionService,
  whisperManager: WhisperManager,
  calendarManager: CalendarManager,
): void {
```

Update usages inside the function:
- `calendarService.isConnected()` → `calendarManager.isConnected()`
- `calendarService.fetchRecentEvents(30)` → `calendarManager.fetchAllRecentEvents(30)`

- [ ] **Step 3: Update transcription test file**

In `src/main/services/__tests__/transcription.test.ts`:

Replace the import (line 5):
```typescript
import type { CalendarService } from '../calendar'
```
With:
```typescript
import type { CalendarManager } from '../calendar-manager'
```

Replace the mock factory (lines 56-61):
```typescript
function createMockCalendarManager(): CalendarManager {
  return {
    isConnected: vi.fn().mockReturnValue(false),
    fetchAllRecentEvents: vi.fn().mockResolvedValue([]),
  } as unknown as CalendarManager
}
```

Replace the type annotation (line 67):
```typescript
let mockCalendar: CalendarManager
```

Replace the mock creation (line 73):
```typescript
mockCalendar = createMockCalendarManager()
```

The constructor call on line 74-78 stays the same (variable name `mockCalendar` unchanged).

- [ ] **Step 4: Update main index.ts**

In `src/main/index.ts`:

Replace import:
```typescript
import { CalendarService } from './services/calendar'
import { registerCalendarIpc } from './ipc/calendar-ipc'
```
With:
```typescript
import { CalendarManager } from './services/calendar-manager'
import { registerCalendarIpc } from './ipc/calendar-ipc'
```

Replace CalendarService creation (around line 141):
```typescript
const calendarService = new CalendarService()
registerCalendarIpc(calendarService, (events) => {
```
With:
```typescript
const calendarManager = new CalendarManager()
registerCalendarIpc(calendarManager, (events) => {
```

Replace TranscriptionService creation (around line 177-182):
```typescript
const transcriptionService = new TranscriptionService(
  whisperManager,
  audioConverter,
  recordingService.getRecordingsBaseDir(),
  calendarManager,
)
```

Replace `registerRecordingIpc` call (around line 253):
```typescript
registerRecordingIpc(recordingService, transcriptionService, whisperManager, calendarManager)
```

Replace the initialization block (around lines 260-270):
```typescript
const restoredAccounts = await calendarManager.initialize()
if (restoredAccounts.length > 0) {
  calendarManager.startSync((events) => {
    cachedEvents = events
    updateTrayMenu()
    const windows = BrowserWindow.getAllWindows()
    for (const win of windows) {
      win.webContents.send('calendar:events-updated', events)
    }
  })
}
```

- [ ] **Step 5: Verify the app compiles**

Run: `npx tsc --noEmit`
Expected: No errors in main process files. Renderer files may still have errors (fixed in next tasks).

- [ ] **Step 6: Run tests**

Run: `npx vitest run src/main/services/__tests__/transcription.test.ts`
Expected: All tests pass with the CalendarManager mock.

- [ ] **Step 7: Commit**

```bash
git add src/main/index.ts src/main/services/transcription.ts src/main/ipc/recording-ipc.ts src/main/services/__tests__/transcription.test.ts
git commit -m "feat(calendar): wire CalendarManager into main process"
```

---

### Task 8: Update renderer calendar store

**Context:** The Zustand store changes from a single `isConnected` boolean to an `accounts` array. Derived `isConnected` is `accounts.length > 0`. New actions: `setAccounts`, `connect(provider)`, `disconnect(accountId)`.

**Files:**
- Modify: `src/renderer/src/stores/calendar.ts`

- [ ] **Step 1: Rewrite the calendar store**

```typescript
import { create } from 'zustand'
import type { AutoRecordMode, CalendarEvent, CalendarAccount } from '../../../shared/types'

interface CalendarState {
  accounts: CalendarAccount[]
  isConnecting: boolean
  events: CalendarEvent[]
  isSyncing: boolean

  // Derived
  readonly isConnected: boolean

  setAccounts: (accounts: CalendarAccount[]) => void
  addAccount: (account: CalendarAccount) => void
  removeAccount: (accountId: string) => void
  setConnecting: (connecting: boolean) => void
  setEvents: (events: CalendarEvent[]) => void
  setSyncing: (syncing: boolean) => void
  setAutoRecord: (eventId: string, mode: AutoRecordMode) => void
}

export const useCalendarStore = create<CalendarState>((set, get) => ({
  accounts: [],
  isConnecting: false,
  events: [],
  isSyncing: false,

  get isConnected() {
    return get().accounts.length > 0
  },

  setAccounts: (accounts) => set({ accounts }),
  addAccount: (account) => set((state) => ({ accounts: [...state.accounts, account] })),
  removeAccount: (accountId) => set((state) => ({
    accounts: state.accounts.filter((a) => a.id !== accountId),
  })),
  setConnecting: (connecting) => set({ isConnecting: connecting }),
  setEvents: (events) => set({ events }),
  setSyncing: (syncing) => set({ isSyncing: syncing }),
  setAutoRecord: (eventId, mode) =>
    set((state) => ({
      events: state.events.map((e) =>
        e.id === eventId ? { ...e, autoRecord: mode } : e
      ),
    })),
}))
```

**Note:** Zustand doesn't support `get` syntax in the object literal. Instead, make `isConnected` a computed selector that consumers use:

Actually, let's keep it simpler and just use a regular field with derived state via a selector:

```typescript
import { create } from 'zustand'
import type { AutoRecordMode, CalendarEvent, CalendarAccount } from '../../../shared/types'

interface CalendarState {
  accounts: CalendarAccount[]
  isConnecting: boolean
  events: CalendarEvent[]
  isSyncing: boolean

  setAccounts: (accounts: CalendarAccount[]) => void
  addAccount: (account: CalendarAccount) => void
  removeAccount: (accountId: string) => void
  setConnecting: (connecting: boolean) => void
  setEvents: (events: CalendarEvent[]) => void
  setSyncing: (syncing: boolean) => void
  setAutoRecord: (eventId: string, mode: AutoRecordMode) => void
}

export const useCalendarStore = create<CalendarState>((set) => ({
  accounts: [],
  isConnecting: false,
  events: [],
  isSyncing: false,

  setAccounts: (accounts) => set({ accounts }),
  addAccount: (account) => set((state) => ({ accounts: [...state.accounts, account] })),
  removeAccount: (accountId) => set((state) => ({
    accounts: state.accounts.filter((a) => a.id !== accountId),
  })),
  setConnecting: (connecting) => set({ isConnecting: connecting }),
  setEvents: (events) => set({ events }),
  setSyncing: (syncing) => set({ isSyncing: syncing }),
  setAutoRecord: (eventId, mode) =>
    set((state) => ({
      events: state.events.map((e) =>
        e.id === eventId ? { ...e, autoRecord: mode } : e
      ),
    })),
}))

// Derived selector — use in components: const isConnected = useCalendarStore(selectIsConnected)
export const selectIsConnected = (state: CalendarState) => state.accounts.length > 0
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/src/stores/calendar.ts
git commit -m "feat(calendar): update calendar store for multi-account support"
```

---

### Task 9: Update Upcoming page and ConnectCalendar component

**Context:** The Upcoming page and ConnectCalendar need to use `accounts` instead of `isConnected`, and offer both Google and Microsoft connection options.

**Files:**
- Modify: `src/renderer/src/pages/Upcoming.tsx`
- Modify: `src/renderer/src/components/ConnectCalendar.tsx`

- [ ] **Step 1: Update ConnectCalendar to offer both providers**

Rewrite `src/renderer/src/components/ConnectCalendar.tsx`:

```typescript
interface ConnectCalendarProps {
  isConnecting: boolean
  onConnect: (provider: 'google' | 'microsoft') => void
}

export function ConnectCalendar({ isConnecting, onConnect }: ConnectCalendarProps) {
  return (
    <div className="flex-1 flex items-center justify-center p-6">
      <div className="text-center">
        <p className="text-ink-muted text-[13px] mb-4">
          Connect a calendar to see upcoming meetings
        </p>
        <div className="flex flex-col gap-2">
          <button
            onClick={() => onConnect('google')}
            disabled={isConnecting}
            className="text-[12px] font-medium text-white bg-ink px-4 py-2 rounded-lg hover:bg-ink-secondary transition-colors disabled:opacity-50"
          >
            {isConnecting ? 'Connecting...' : 'Connect Google Calendar'}
          </button>
          <button
            onClick={() => onConnect('microsoft')}
            disabled={isConnecting}
            className="text-[12px] font-medium text-white bg-ink px-4 py-2 rounded-lg hover:bg-ink-secondary transition-colors disabled:opacity-50"
          >
            {isConnecting ? 'Connecting...' : 'Connect Microsoft Outlook'}
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Update Upcoming page**

In `src/renderer/src/pages/Upcoming.tsx`, make these changes:

1. Update the store import to use `selectIsConnected`:
```typescript
import { useCalendarStore, selectIsConnected } from '../stores/calendar'
```

2. Update state destructuring — replace `isConnected, setConnected` with accounts-based logic:
```typescript
const {
  accounts,
  isConnecting,
  events,
  isSyncing,
  setAccounts,
  addAccount,
  setConnecting,
  setEvents,
  setSyncing,
  setAutoRecord,
} = useCalendarStore()
const isConnected = useCalendarStore(selectIsConnected)
```

3. Update `useEffect` — replace `calendar:is-connected` with `calendar:get-accounts`:
```typescript
useEffect(() => {
  window.electronAPI.invoke('calendar:get-accounts').then((accts) => {
    setAccounts(accts)
    setCalendarChecked(true)
  })

  const unsubscribe = window.electronAPI.on('calendar:events-updated', (updatedEvents) => {
    setEvents(updatedEvents)
  })

  window.electronAPI.invoke('calendar:get-accounts').then(async (accts) => {
    if (accts.length > 0) {
      const fetchedEvents = await window.electronAPI.invoke('calendar:get-events')
      setEvents(fetchedEvents)
    }
  })

  return unsubscribe
}, [setAccounts, setEvents])
```

4. Update `handleConnect` to accept a provider:
```typescript
const handleConnect = async (provider: 'google' | 'microsoft') => {
  setConnecting(true)
  try {
    const account = await window.electronAPI.invoke('calendar:connect', provider)
    addAccount(account)
    trackEvent('calendar_connected', { provider })
    const fetchedEvents = await window.electronAPI.invoke('calendar:get-events')
    setEvents(fetchedEvents)
  } catch (err) {
    console.error('Failed to connect calendar:', err)
  } finally {
    setConnecting(false)
  }
}
```

5. Update the toast message:
```typescript
useToastStore.getState().showToast({
  type: 'calendar',
  message: 'Connect a calendar to see upcoming meetings and auto-name recordings.',
})
```

6. Update the JSX — pass provider-aware `handleConnect`:
```tsx
{!isConnected ? (
  <ConnectCalendar isConnecting={isConnecting} onConnect={handleConnect} />
) : ...
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors related to Upcoming or ConnectCalendar.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/pages/Upcoming.tsx src/renderer/src/components/ConnectCalendar.tsx
git commit -m "feat(calendar): update Upcoming page and ConnectCalendar for multi-provider"
```

---

### Task 10: Update Settings page for multi-account management

**Context:** The Settings page needs to show all connected accounts with disconnect buttons, and "Add" buttons for both providers.

**Files:**
- Modify: `src/renderer/src/pages/Settings.tsx`

- [ ] **Step 1: Rewrite the calendar section in Settings**

In `src/renderer/src/pages/Settings.tsx`:

1. Update imports and state:
```typescript
import { useCalendarStore, selectIsConnected } from '../stores/calendar'
import type { CalendarAccount } from '../../../shared/types'
```

2. Replace the store destructuring:
```typescript
const { accounts, isConnecting, setAccounts, addAccount, removeAccount, setConnecting, setEvents } = useCalendarStore()
const isConnected = useCalendarStore(selectIsConnected)
```

3. Add `useEffect` to load accounts on mount:
```typescript
useEffect(() => {
  window.electronAPI.invoke('calendar:get-accounts').then(setAccounts)
}, [setAccounts])
```

4. Replace `handleConnect`:
```typescript
const handleConnect = async (provider: 'google' | 'microsoft') => {
  setConnecting(true)
  try {
    const account = await window.electronAPI.invoke('calendar:connect', provider)
    addAccount(account)
    const events = await window.electronAPI.invoke('calendar:get-events')
    setEvents(events)
  } catch (err) {
    console.error('Failed to connect calendar:', err)
  } finally {
    setConnecting(false)
  }
}
```

5. Replace `handleDisconnect`:
```typescript
const handleDisconnect = async (accountId: string) => {
  await window.electronAPI.invoke('calendar:disconnect', accountId)
  removeAccount(accountId)
  const events = await window.electronAPI.invoke('calendar:get-events')
  setEvents(events)
}
```

6. Replace the calendar section JSX:
```tsx
<div>
  <h3 className="text-[13px] font-semibold text-ink mb-2">Calendars</h3>

  {/* Connected accounts */}
  {accounts.length > 0 && (
    <div className="flex flex-col gap-2 mb-3">
      {accounts.map((account) => (
        <div key={account.id} className="flex items-center gap-3">
          <span className="text-[12px] font-medium text-ink-muted">
            {account.provider === 'google' ? 'G' : 'M'}
          </span>
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-status-connected" />
            <span className="text-[12px] text-ink-muted">{account.email}</span>
          </div>
          <button
            onClick={() => handleDisconnect(account.id)}
            className="text-[12px] font-medium text-ink-muted bg-bg-accent px-3 py-1.5 rounded-lg border border-border-subtle hover:border-ink-muted transition-colors"
          >
            Disconnect
          </button>
        </div>
      ))}
    </div>
  )}

  {/* Add account buttons */}
  <div className="flex gap-2">
    <button
      onClick={() => handleConnect('google')}
      disabled={isConnecting}
      className="text-[12px] font-medium text-white bg-ink px-4 py-2 rounded-lg hover:bg-ink-secondary transition-colors disabled:opacity-50"
    >
      {isConnecting ? 'Connecting...' : 'Add Google Calendar'}
    </button>
    <button
      onClick={() => handleConnect('microsoft')}
      disabled={isConnecting}
      className="text-[12px] font-medium text-white bg-ink px-4 py-2 rounded-lg hover:bg-ink-secondary transition-colors disabled:opacity-50"
    >
      {isConnecting ? 'Connecting...' : 'Add Microsoft Outlook'}
    </button>
  </div>
</div>
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/pages/Settings.tsx
git commit -m "feat(calendar): update Settings page for multi-account calendar management"
```

---

### Task 11: Update onboarding CalendarStep

**Context:** The CalendarStep should offer both Google and Microsoft options during onboarding.

**Files:**
- Modify: `src/renderer/src/components/onboarding/CalendarStep.tsx`

- [ ] **Step 1: Update CalendarStep for dual-provider support**

Rewrite `src/renderer/src/components/onboarding/CalendarStep.tsx`:

```typescript
import { useState, useEffect } from 'react'

export function CalendarStep({ onNext }: { onNext: () => void }) {
  const [connecting, setConnecting] = useState(false)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    window.electronAPI.invoke('calendar:get-accounts').then((accounts) => {
      if (accounts.length > 0) onNext()
    })
  }, [onNext])

  const handleConnect = async (provider: 'google' | 'microsoft') => {
    setConnecting(true)
    try {
      await window.electronAPI.invoke('calendar:connect', provider)
      setConnected(true)
    } catch {
      // OAuth cancelled or failed
    } finally {
      setConnecting(false)
    }
  }

  return (
    <div className="text-center">
      <span className="inline-block px-2.5 py-1 bg-mist-light text-ink-muted rounded-md text-[11px] font-semibold uppercase tracking-wider mb-4">
        OPTIONAL
      </span>
      <div className="w-16 h-16 rounded-2xl bg-sage-light flex items-center justify-center text-[28px] mx-auto mb-5">
        📅
      </div>
      <h2 className="text-[20px] font-bold text-ink tracking-[-0.02em] mb-2">Connect Calendar</h2>
      <p className="text-[14px] text-ink-muted leading-relaxed mb-7">
        Connect your calendar to automatically name recordings after meetings and suggest speaker names from attendee lists.
      </p>

      {connected ? (
        <button
          onClick={onNext}
          className="px-8 py-3 bg-sage text-white rounded-[10px] text-[14px] font-semibold hover:opacity-90 transition-opacity"
        >
          Continue →
        </button>
      ) : (
        <>
          <div className="flex flex-col gap-2 items-center">
            <button
              onClick={() => handleConnect('google')}
              disabled={connecting}
              className="px-8 py-3 bg-ink text-white rounded-[10px] text-[14px] font-semibold hover:bg-ink-secondary transition-colors disabled:opacity-50 w-64"
            >
              {connecting ? 'Connecting...' : 'Connect Google Calendar'}
            </button>
            <button
              onClick={() => handleConnect('microsoft')}
              disabled={connecting}
              className="px-8 py-3 bg-ink text-white rounded-[10px] text-[14px] font-semibold hover:bg-ink-secondary transition-colors disabled:opacity-50 w-64"
            >
              {connecting ? 'Connecting...' : 'Connect Microsoft Outlook'}
            </button>
          </div>
          <button
            onClick={onNext}
            className="block mx-auto mt-3 text-[13px] text-ink-faint hover:text-ink-muted transition-colors"
          >
            Skip for now
          </button>
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/onboarding/CalendarStep.tsx
git commit -m "feat(calendar): update onboarding CalendarStep for multi-provider support"
```

---

### Task 12: Final compilation check and full test run

**Context:** All code changes are in place. This task verifies everything compiles and existing tests pass.

**Files:** None (verification only)

- [ ] **Step 1: Full TypeScript compilation check**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 2: Run all tests**

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 3: Fix any remaining compilation errors**

If there are compile errors, they're likely:
- Missed `googleEventId` → `externalId` rename somewhere
- Missing `accountId` or `provider` fields in test fixtures
- Import path issues from the refactor

Fix each one and re-run until clean.

- [ ] **Step 4: Remove backward-compat exports from token-store if no longer needed**

Check if `saveTokens`, `loadTokens`, `clearTokens` (the legacy API) are still imported anywhere:

Run: `grep -r "from.*token-store" src/` and check for legacy function usage.

If nothing imports them, remove the backward-compat functions from `token-store.ts`.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat(calendar): complete multi-calendar support implementation"
```

---

## Manual Steps (Not Automated)

These require human action outside the codebase:

1. **Azure AD App Registration** — Register at portal.azure.com per the spec's "Azure AD Setup Steps" section.
2. **Set `MICROSOFT_CLIENT_ID`** — Replace the placeholder in `src/main/services/microsoft-calendar.ts` with the actual Application (client) ID from Azure.
3. **Auth Worker Deployment** — Add `/microsoft/auth` and `/microsoft/refresh` endpoints to the Cloudflare Worker at `autodoc-auth.duetdisplay.workers.dev`. Store the Microsoft client secret as `MICROSOFT_CLIENT_SECRET` worker secret.
4. **End-to-end Testing** — Connect a real Google account, connect a real Microsoft account, verify merged event list, disconnect individually, verify sync continues for remaining account.
