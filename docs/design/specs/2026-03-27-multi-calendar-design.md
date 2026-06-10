# Multi-Calendar Support Design Spec

## Goal

Support multiple calendar providers (Google Calendar and Microsoft Outlook) with the ability to connect multiple accounts simultaneously. Events from all connected accounts appear in a single merged list.

## Architecture

Introduce a `CalendarProvider` interface that both Google and Microsoft implement. A new `CalendarManager` orchestrates all connected accounts — handling connect/disconnect, merged event fetching, and coordinated sync. The existing `CalendarService` is refactored into `GoogleCalendarProvider`. A new `MicrosoftCalendarProvider` handles Outlook via Microsoft Graph API. Everything downstream of the merged event list (detection, matching, auto-record, tray, UI) is unaffected.

## CalendarProvider Interface

```typescript
interface CalendarAccount {
  id: string                          // UUID, stable across sessions
  provider: 'google' | 'microsoft'
  email: string                       // Display identity
  connectedAt: number
}

interface CalendarProvider {
  readonly providerType: 'google' | 'microsoft'

  connect(): Promise<CalendarAccount>
  disconnect(accountId: string): Promise<void>
  isConnected(accountId: string): boolean

  fetchUpcomingEvents(accountId: string): Promise<CalendarEvent[]>
  fetchRecentEvents(accountId: string, daysBack: number): Promise<CalendarEvent[]>
  refreshTokens(accountId: string): Promise<void>
}
```

Both providers implement this interface. The manager calls them polymorphically.

## CalendarEvent Type Changes

```typescript
interface CalendarEvent {
  id: string                          // `{provider}_{externalId}` — unique across providers
  externalId: string                  // was googleEventId — provider's native event ID
  accountId: string                   // which connected account owns this event
  provider: 'google' | 'microsoft'   // source provider
  recurringEventId: string | null
  title: string
  startTime: number                   // ms
  endTime: number                     // ms
  attendees: string[]                 // email addresses
  meetingUrl: string | null
  autoRecord: AutoRecordMode
  syncedAt: number
}
```

The `googleEventId` field is renamed to `externalId`. New fields `accountId` and `provider` are added. All downstream consumers already use `id`, `startTime`, `attendees`, etc. — no changes needed.

**Rename migration:** Any file referencing `googleEventId` must be updated to `externalId`. Known references:
- `src/main/services/detection.ts` — event matching logic
- `src/main/services/calendar.ts` — event mapping from Google API response
- Any test files referencing `googleEventId` in fixtures or assertions

## CalendarManager

New orchestrator class that replaces the current direct use of `CalendarService`:

```typescript
class CalendarManager {
  private providers: Map<string, CalendarProvider>  // 'google' | 'microsoft' → provider
  private accounts: CalendarAccount[]               // persisted in electron-store

  connect(providerType: 'google' | 'microsoft'): Promise<CalendarAccount>
  disconnect(accountId: string): Promise<void>
  getAccounts(): CalendarAccount[]

  fetchAllUpcomingEvents(): Promise<CalendarEvent[]>
  fetchAllRecentEvents(daysBack: number): Promise<CalendarEvent[]>

  startSync(callback: (events: CalendarEvent[]) => void): void
  stopSync(): void

  initialize(): Promise<CalendarAccount[]>
}
```

**Behaviors:**

- `connect()` delegates to the appropriate provider, stores the returned account, persists to the account registry. Only one connect flow runs at a time — concurrent calls are rejected with an error (the shared localhost callback server cannot disambiguate simultaneous OAuth flows).
- `disconnect()` removes tokens for the account, removes the account from the registry.
- `fetchAllUpcomingEvents()` calls each connected account's provider via `Promise.allSettled`, merges successful results, logs failures per-account, sorts by `startTime`. Uses `Promise.allSettled` (not `Promise.all`) so one failing account doesn't block others.
- `startSync()` runs a single 5-minute interval. Each tick iterates through all accounts. If one account fails (expired token, network error), others continue unaffected. On token refresh failure: log the error, mark the account as needing re-auth (emit event to renderer), but do not remove the account.
- `initialize()` loads saved accounts from the registry, validates each has tokens, removes orphaned accounts (accounts with no corresponding token entry). Returns the list of restored accounts.

## GoogleCalendarProvider

Refactored from the current `CalendarService`. Same OAuth flow, same Google Calendar API v3 usage, same auth worker endpoints. Key changes:

- Constructor takes no arguments — all state is per-account via the account ID.
- Token operations use account-scoped keys (`cal_tokens_{accountId}`) instead of the single `gcal_tokens` key.
- `connect()` runs the existing OAuth flow, fetches the user's email from `https://www.googleapis.com/oauth2/v2/userinfo` (already available with the granted scopes), returns a `CalendarAccount`.
- Event mapping uses `externalId` instead of `googleEventId`, and populates `accountId` and `provider` fields.

No changes to the auth worker endpoints — the existing `/auth` and `/auth/refresh` continue to work.

## MicrosoftCalendarProvider

New provider for Microsoft Outlook calendars.

### Azure AD App Registration

- Register app at portal.azure.com with "Accounts in any organizational directory and personal Microsoft accounts" (common endpoint).
- Redirect URI: `http://localhost:42813/callback` (same port as Google, differentiated by state parameter).
- API permissions: `Calendars.Read`, `User.Read`, `offline_access`.
- Client ID stored in app code (same pattern as Google).

### Auth Worker

New endpoints on the existing `autodoc-auth.duetdisplay.workers.dev`:

- `POST /microsoft/auth` — exchanges authorization code for tokens
- `POST /microsoft/refresh` — refreshes access token using refresh token

The worker holds the Microsoft client secret, same pattern as Google.

### OAuth Flow

1. App opens browser to `https://login.microsoftonline.com/common/oauth2/v2.0/authorize` with scopes, redirect URI, and a `state` parameter containing `provider=microsoft`.
2. User authenticates and consents.
3. Browser redirects to `localhost:42813/callback` with auth code.
4. The localhost handler checks the `state` parameter to route to the Microsoft code exchange path.
5. Auth code is sent to the worker's `/microsoft/auth` endpoint.
6. Tokens returned and stored under `cal_tokens_{accountId}`.

### Microsoft Graph API

- **Upcoming events**: `GET /v1.0/me/calendarView?startDateTime={now}&endDateTime={now+24h}` — both parameters required by Microsoft Graph. Times in ISO 8601 format. Add `$top=100` and `$orderby=start/dateTime` query parameters. If response contains `@odata.nextLink`, follow pagination until all events are fetched.
- **Recent events**: `GET /v1.0/me/calendarView?startDateTime={now-Ndays}&endDateTime={now}` — same pattern for recent events lookup.
- **User email**: `GET /v1.0/me` → `mail` or `userPrincipalName`

### Event Field Mapping

| Graph API Field | CalendarEvent Field |
|----------------|-------------------|
| `id` | `externalId` |
| `subject` | `title` |
| `start.dateTime` + `start.timeZone` | `startTime` (converted to ms) |
| `end.dateTime` + `end.timeZone` | `endTime` (converted to ms) |
| `attendees[].emailAddress.address` | `attendees` |
| `onlineMeeting.joinUrl` | `meetingUrl` (primary) |
| `location.displayName`, `body.content` | `meetingUrl` (fallback URL pattern match) |
| `seriesMasterId` | `recurringEventId` |

### Meeting URL Extraction

1. First: `onlineMeeting.joinUrl` (Teams meetings have this natively)
2. Then: URL pattern matching on `location.displayName` and `body.content` for Zoom, Google Meet, Webex links (same patterns as Google provider)

## Token Store Changes

### New Storage Scheme

- Token key pattern: `cal_tokens_{accountId}` (e.g., `cal_tokens_a1b2c3d4`)
- Same `safeStorage` encryption as today
- Each key stores the provider's token set (access_token, refresh_token, expiry_date)

### Account Registry

New `calendar-accounts` electron-store file:

```json
[
  { "id": "a1b2c3d4", "provider": "google", "email": "rahul@gmail.com", "connectedAt": 1711500000000 },
  { "id": "e5f6g7h8", "provider": "microsoft", "email": "rahul@company.com", "connectedAt": 1711500100000 }
]
```

### Migration from Legacy Storage

On `CalendarManager.initialize()`:

1. Check for legacy `gcal_tokens` key in token store.
2. If found: generate a UUID account ID, create a `CalendarAccount` entry with `provider: 'google'`, copy the full token payload (access_token, refresh_token, expiry_date, token_type, scope) to `cal_tokens_{id}`, then delete `gcal_tokens`.
3. Fetch the user's email via the Google userinfo endpoint using the migrated access token (refresh first if expired). Store in the account entry.
4. Save the account to the registry.
5. User's existing Google Calendar connection continues to work without re-authentication.

## IPC Changes

### Modified Channels

| Channel | Change |
|---------|--------|
| `calendar:connect` | Adds `provider: 'google' \| 'microsoft'` parameter |
| `calendar:disconnect` | Adds `accountId: string` parameter (was no args) |
| `calendar:is-connected` | Replaced by `calendar:get-accounts` returning `CalendarAccount[]` |

### Unchanged Channels

| Channel | Why Unchanged |
|---------|--------------|
| `calendar:get-events` | Returns merged events from all accounts (same shape) |
| `calendar:sync` | Syncs all accounts, returns merged events |
| `calendar:set-auto-record` | Uses event ID / recurring ID — provider-agnostic |

### New Channel

| Channel | Purpose |
|---------|---------|
| `calendar:get-accounts` | Returns `CalendarAccount[]` for UI display |

## Renderer Changes

### Calendar Store

```typescript
// Before
{ isConnected: boolean, isConnecting: boolean, events: CalendarEvent[] }

// After
{ accounts: CalendarAccount[], isConnecting: boolean, events: CalendarEvent[] }
```

- `isConnected` derived: `accounts.length > 0`
- New actions: `connect(provider)`, `disconnect(accountId)`, `setAccounts(accounts)`

### Settings Page

The "Google Calendar" section becomes "Calendars":

- List of connected accounts, each showing:
  - Provider icon (Google "G" or Microsoft logo)
  - Email address
  - "Disconnect" button
- Below the list: "Add Google Calendar" and "Add Microsoft Outlook" buttons
- Each button triggers `calendar:connect` with the provider type

### Upcoming Page

- If no accounts connected: show prompt with both "Connect Google Calendar" and "Connect Microsoft Outlook" buttons
- If accounts connected: show merged event list (no changes to event rendering)
- The `ConnectCalendar` component updated to offer both providers

### Onboarding CalendarStep

- Updated to show both provider options
- "Skip for now" still available
- User can connect one or both during onboarding

### EventCard

No changes. Events render identically regardless of provider.

## Downstream Systems — No Changes Required

| System | Why Unaffected |
|--------|---------------|
| **Detection Service** | Receives `cachedEvents` as flat array — provider-agnostic |
| **Calendar Matcher** | Takes `CalendarEvent[]` + timestamp — field names unchanged |
| **Auto-Record Store** | Stores event IDs — unique strings regardless of provider. Note: `id` field uses `{provider}_{externalId}` format to prevent collision across providers. |
| **Speaker Suggestions** | Uses `CalendarEvent.attendees` — same field |
| **Tray Menu** | Renders from merged `cachedEvents` array |
| **Search** | Doesn't touch calendar data |

## Event Deduplication

When the same meeting appears on multiple connected accounts (e.g., a meeting invite on both a Google and Microsoft calendar), both events appear in the merged list. No cross-provider deduplication is performed in v1 — this matches how native calendar apps behave. If needed later, deduplication can be added by matching on `startTime` + `title` + overlapping attendees.

## Auth Worker Deployment

The existing Cloudflare Worker at `autodoc-auth.duetdisplay.workers.dev` needs two new endpoints:

- `POST /microsoft/auth` — code exchange (client_id, client_secret, code, redirect_uri → tokens)
- `POST /microsoft/refresh` — token refresh (client_id, client_secret, refresh_token → new access_token)

The Microsoft client secret is stored as a Worker secret (`MICROSOFT_CLIENT_SECRET`), same pattern as `GOOGLE_CLIENT_SECRET`.

## Localhost Callback Router

The current localhost server on port 42813 handles Google callbacks. It needs to be updated to:

1. Accept a `state` parameter in the OAuth request that encodes `{ provider: 'google' | 'microsoft' }`.
2. On callback, parse `state` to determine which provider's code exchange to invoke.
3. Route to the appropriate auth worker endpoint.

This is a small change to the existing HTTP server in `CalendarService` — it moves into `CalendarManager` since it's shared across providers.

## File Structure

| File | Status |
|------|--------|
| `src/main/services/calendar.ts` | Refactor → `GoogleCalendarProvider` implementing `CalendarProvider` |
| `src/main/services/microsoft-calendar.ts` | **New** — `MicrosoftCalendarProvider` |
| `src/main/services/calendar-manager.ts` | **New** — orchestrator |
| `src/main/services/calendar-types.ts` | **New** — `CalendarProvider`, `CalendarAccount` interfaces |
| `src/main/services/detection.ts` | Modified — update `googleEventId` → `externalId` references |
| `src/main/services/token-store.ts` | Modified — account-scoped keys, migration logic |
| `src/main/ipc/calendar-ipc.ts` | Modified — uses `CalendarManager`, updated channel signatures |
| `src/main/index.ts` | Modified — creates `CalendarManager` instead of `CalendarService` |
| `src/shared/types.ts` | Modified — `CalendarEvent` changes (`externalId`, `accountId`, `provider`) |
| `src/preload/ipc.d.ts` | Modified — updated channel signatures |
| `src/renderer/src/stores/calendar.ts` | Modified — `accounts` replaces `isConnected` |
| `src/renderer/src/pages/Settings.tsx` | Modified — multi-account calendar UI |
| `src/renderer/src/pages/Upcoming.tsx` | Modified — dual-provider connect prompt |
| `src/renderer/src/components/ConnectCalendar.tsx` | Modified — both provider options |
| `src/renderer/src/components/onboarding/CalendarStep.tsx` | Modified — both provider options |

## Azure AD Setup Steps (Manual)

1. Go to portal.azure.com → Azure Active Directory → App registrations → New registration
2. Name: "AutoDoc"
3. Supported account types: "Accounts in any organizational directory and personal Microsoft accounts"
4. Redirect URI: Web → `http://localhost:42813/callback`
5. Under Certificates & secrets: Create client secret, store in auth worker as `MICROSOFT_CLIENT_SECRET`
6. Under API permissions: Add `Calendars.Read`, `User.Read`, `offline_access`
7. Note the Application (client) ID for the app code
