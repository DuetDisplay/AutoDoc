# Calendar Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect to Google Calendar via OAuth, sync upcoming events, display them in the Upcoming page with auto-record toggles, and poll for new events every 5 minutes.

**Architecture:** OAuth2 flow opens the system browser and catches the redirect on a loopback HTTP server with PKCE. Tokens are encrypted via Electron's safeStorage and persisted with electron-store. A CalendarService in the main process handles API calls and sync polling. The renderer communicates via typed IPC channels. A Zustand calendar store holds events and connection state.

**Tech Stack:** googleapis, google-auth-library, electron-store, Electron safeStorage API

---

## File Structure

```
src/
  main/
    services/
      calendar.ts          # CalendarService: OAuth flow, event fetching, sync polling
      token-store.ts        # Secure token storage via safeStorage + electron-store
    ipc/
      calendar-ipc.ts       # IPC handler registration for calendar channels
    index.ts                # Modified: register calendar IPC handlers on app ready
  preload/
    ipc.d.ts                # Modified: add calendar IPC channels
  renderer/
    src/
      stores/
        calendar.ts         # Zustand store for calendar state
      pages/
        Upcoming.tsx         # Modified: real event list with connect flow
      components/
        EventCard.tsx        # Single calendar event card with auto-record toggle
        EventCard.test.tsx   # EventCard tests
        ConnectCalendar.tsx  # Google Calendar connect prompt
  shared/
    types.ts                # Modified: add OAuthTokens type
    constants.ts            # Modified: add calendar constants
```

---

### Task 1: Install Dependencies & Add Calendar Constants

**Files:**
- Modify: `package.json`
- Modify: `src/shared/constants.ts`
- Modify: `src/shared/types.ts`

- [ ] **Step 1: Install Google API packages and electron-store**

```bash
npm install googleapis google-auth-library electron-store
```

- [ ] **Step 2: Add calendar constants**

Add to `src/shared/constants.ts`:

```typescript
export const CALENDAR_SYNC_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes

export const GOOGLE_CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events.readonly',
]

export const MEETING_URL_PATTERNS = [
  /zoom\.us\/j/i,
  /teams\.microsoft\.com\/l\/meetup-join/i,
  /meet\.google\.com/i,
  /webex\.com\/meet/i,
]
```

- [ ] **Step 3: Add OAuthTokens type to shared types**

Add to `src/shared/types.ts`:

```typescript
export interface OAuthTokens {
  access_token: string
  refresh_token?: string
  expiry_date?: number
  token_type?: string
  scope?: string
}
```

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/shared/
git commit -m "feat: add Google Calendar dependencies and constants"
```

---

### Task 2: Token Storage Service

**Files:**
- Create: `src/main/services/token-store.ts`

- [ ] **Step 1: Create the token store**

Create `src/main/services/token-store.ts`:

```typescript
import { safeStorage } from 'electron'
import Store from 'electron-store'

const store = new Store({ name: 'autodoc-tokens' })
const TOKEN_KEY = 'gcal_tokens'

export function saveTokens(tokens: object): void {
  const json = JSON.stringify(tokens)
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(json)
    store.set(TOKEN_KEY, encrypted.toString('latin1'))
    store.set(`${TOKEN_KEY}_encrypted`, true)
  } else {
    store.set(TOKEN_KEY, json)
    store.set(`${TOKEN_KEY}_encrypted`, false)
  }
}

export function loadTokens(): object | null {
  const raw = store.get(TOKEN_KEY) as string | undefined
  if (!raw) return null

  try {
    const isEncrypted = store.get(`${TOKEN_KEY}_encrypted`) as boolean
    if (isEncrypted && safeStorage.isEncryptionAvailable()) {
      const decrypted = safeStorage.decryptString(Buffer.from(raw, 'latin1'))
      return JSON.parse(decrypted)
    }
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function clearTokens(): void {
  store.delete(TOKEN_KEY)
  store.delete(`${TOKEN_KEY}_encrypted`)
}
```

- [ ] **Step 2: Commit**

```bash
git add src/main/services/
git commit -m "feat: add secure token storage service"
```

---

### Task 3: Calendar Service

**Files:**
- Create: `src/main/services/calendar.ts`

- [ ] **Step 1: Create the calendar service**

Create `src/main/services/calendar.ts`:

```typescript
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
const REDIRECT_URI = `http://127.0.0.1:${OAUTH_PORT}`

// These will be set via environment or config.
// For development, set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET env vars.
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? ''
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? ''

export class CalendarService {
  private oauth2Client: OAuth2Client
  private syncInterval: ReturnType<typeof setInterval> | null = null
  private onEventsUpdated: ((events: CalendarEvent[]) => void) | null = null

  constructor() {
    this.oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI)

    // Auto-persist refreshed tokens
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
      code_challenge_method: 'S256',
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

  private extractMeetingUrl(event: { hangoutLink?: string | null; conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] } | null; location?: string | null; description?: string | null }): string | null {
    // 1. Google Meet dedicated field
    if (event.hangoutLink) {
      return event.hangoutLink
    }

    // 2. conferenceData entry points (Meet, Zoom add-on, etc.)
    const entryPoints = event.conferenceData?.entryPoints ?? []
    const videoEntry = entryPoints.find((ep) => ep.entryPointType === 'video')
    if (videoEntry?.uri) {
      return videoEntry.uri
    }

    // 3. URL in location field
    const location = event.location ?? ''
    const locationMatch = location.match(
      /https?:\/\/[^\s,]*(zoom\.us\/j|teams\.microsoft\.com\/l\/meetup-join|meet\.google\.com|webex\.com\/meet)[^\s,]*/i
    )
    if (locationMatch) {
      return locationMatch[0]
    }

    // 4. URL in description
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
```

- [ ] **Step 2: Commit**

```bash
git add src/main/services/calendar.ts
git commit -m "feat: add CalendarService with OAuth, event fetching, and sync"
```

---

### Task 4: Calendar IPC Channels

**Files:**
- Modify: `src/preload/ipc.d.ts`
- Create: `src/main/ipc/calendar-ipc.ts`
- Modify: `src/main/index.ts`

- [ ] **Step 1: Add calendar IPC channel types**

Read `src/preload/ipc.d.ts` first, then add these channels:

Add to `IpcInvokeEvents`:
```typescript
'calendar:connect': []
'calendar:disconnect': []
'calendar:is-connected': []
'calendar:get-events': []
'calendar:sync': []
'calendar:set-auto-record': [eventId: string, autoRecord: boolean]
```

Add to `IpcInvokeReturns`:
```typescript
'calendar:connect': void
'calendar:disconnect': void
'calendar:is-connected': boolean
'calendar:get-events': CalendarEvent[]
'calendar:sync': CalendarEvent[]
'calendar:set-auto-record': void
```

Import `CalendarEvent` from the shared types at the top of the file:
```typescript
import type { CalendarEvent } from '../shared/types'
```

- [ ] **Step 2: Create calendar IPC handler file**

Create `src/main/ipc/calendar-ipc.ts`:

```typescript
import { ipcMain, BrowserWindow } from 'electron'
import { CalendarService } from '../services/calendar'
import type { CalendarEvent } from '../../shared/types'

export function registerCalendarIpc(calendarService: CalendarService): void {
  ipcMain.handle('calendar:connect', async () => {
    await calendarService.connect()

    // Start sync and push events to renderer
    const events = await calendarService.fetchUpcomingEvents()
    pushEventsToRenderer(events)

    calendarService.startSync((updatedEvents) => {
      pushEventsToRenderer(updatedEvents)
    })
  })

  ipcMain.handle('calendar:disconnect', async () => {
    await calendarService.disconnect()
  })

  ipcMain.handle('calendar:is-connected', () => {
    return calendarService.isConnected()
  })

  ipcMain.handle('calendar:get-events', async () => {
    return calendarService.fetchUpcomingEvents()
  })

  ipcMain.handle('calendar:sync', async () => {
    const events = await calendarService.fetchUpcomingEvents()
    pushEventsToRenderer(events)
    return events
  })

  ipcMain.handle('calendar:set-auto-record', (_event, eventId: string, autoRecord: boolean) => {
    // Auto-record state is stored locally in the renderer store for now.
    // Will be persisted in SQLite in the storage sub-project.
    void eventId
    void autoRecord
  })
}

function pushEventsToRenderer(events: CalendarEvent[]): void {
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    win.webContents.send('calendar:events-updated', events)
  }
}
```

- [ ] **Step 3: Add calendar:events-updated to IpcOnEvents**

In `src/preload/ipc.d.ts`, add to `IpcOnEvents`:

```typescript
'calendar:events-updated': [events: CalendarEvent[]]
```

- [ ] **Step 4: Wire up calendar service in main process**

Read `src/main/index.ts` first. Then modify it to:
1. Import `CalendarService` and `registerCalendarIpc`
2. Create and initialize the calendar service in `app.whenReady()`
3. Register calendar IPC handlers
4. If already connected (tokens exist), start sync

Add imports at top:
```typescript
import { CalendarService } from './services/calendar'
import { registerCalendarIpc } from './ipc/calendar-ipc'
```

Inside `app.whenReady().then(async () => {`:
```typescript
  const calendarService = new CalendarService()
  registerCalendarIpc(calendarService)

  // Restore calendar connection if tokens exist
  const wasConnected = await calendarService.initialize()
  if (wasConnected) {
    calendarService.startSync((events) => {
      const windows = BrowserWindow.getAllWindows()
      for (const win of windows) {
        win.webContents.send('calendar:events-updated', events)
      }
    })
  }
```

- [ ] **Step 5: Verify build**

```bash
npm run build
```

Expected: Build succeeds with no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/preload/ipc.d.ts src/main/ipc/ src/main/index.ts
git commit -m "feat: add calendar IPC channels and wire up to main process"
```

---

### Task 5: Calendar Zustand Store

**Files:**
- Create: `src/renderer/src/stores/calendar.ts`

- [ ] **Step 1: Create the calendar store**

Create `src/renderer/src/stores/calendar.ts`:

```typescript
import { create } from 'zustand'
import type { CalendarEvent } from '../../../shared/types'

interface CalendarState {
  isConnected: boolean
  isConnecting: boolean
  events: CalendarEvent[]
  isSyncing: boolean

  setConnected: (connected: boolean) => void
  setConnecting: (connecting: boolean) => void
  setEvents: (events: CalendarEvent[]) => void
  setSyncing: (syncing: boolean) => void
  toggleAutoRecord: (eventId: string) => void
}

export const useCalendarStore = create<CalendarState>((set) => ({
  isConnected: false,
  isConnecting: false,
  events: [],
  isSyncing: false,

  setConnected: (connected) => set({ isConnected: connected }),
  setConnecting: (connecting) => set({ isConnecting: connecting }),
  setEvents: (events) => set({ events }),
  setSyncing: (syncing) => set({ isSyncing: syncing }),
  toggleAutoRecord: (eventId) =>
    set((state) => ({
      events: state.events.map((e) =>
        e.id === eventId ? { ...e, autoRecord: !e.autoRecord } : e
      ),
    })),
}))
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/src/stores/calendar.ts
git commit -m "feat: add calendar Zustand store"
```

---

### Task 6: EventCard Component

**Files:**
- Create: `src/renderer/src/components/EventCard.tsx`
- Create: `src/renderer/src/components/EventCard.test.tsx`

- [ ] **Step 1: Write failing tests**

Create `src/renderer/src/components/EventCard.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
import { EventCard } from './EventCard'
import type { CalendarEvent } from '../../../shared/types'

const mockEvent: CalendarEvent = {
  id: 'evt-1',
  googleEventId: 'google-1',
  title: 'Sprint Planning',
  startTime: new Date('2026-03-24T10:00:00').getTime(),
  endTime: new Date('2026-03-24T10:30:00').getTime(),
  attendees: ['alice@example.com', 'bob@example.com'],
  meetingUrl: 'https://meet.google.com/abc-defg-hij',
  autoRecord: false,
  syncedAt: Date.now(),
}

describe('EventCard', () => {
  it('renders event title and time', () => {
    render(<EventCard event={mockEvent} onToggleAutoRecord={vi.fn()} />)
    expect(screen.getByText('Sprint Planning')).toBeInTheDocument()
    expect(screen.getByText(/10:00/)).toBeInTheDocument()
  })

  it('renders meeting platform when URL is present', () => {
    render(<EventCard event={mockEvent} onToggleAutoRecord={vi.fn()} />)
    expect(screen.getByText(/Google Meet/i)).toBeInTheDocument()
  })

  it('shows auto-record badge when enabled', () => {
    const autoRecordEvent = { ...mockEvent, autoRecord: true }
    render(<EventCard event={autoRecordEvent} onToggleAutoRecord={vi.fn()} />)
    expect(screen.getByText('Auto-record')).toBeInTheDocument()
  })

  it('calls onToggleAutoRecord when toggle is clicked', async () => {
    const onToggle = vi.fn()
    const user = userEvent.setup()
    render(<EventCard event={mockEvent} onToggleAutoRecord={onToggle} />)

    await user.click(screen.getByRole('button', { name: /auto-record/i }))
    expect(onToggle).toHaveBeenCalledWith('evt-1')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm run test:run
```

Expected: FAIL — `EventCard` module not found.

- [ ] **Step 3: Implement EventCard**

Create `src/renderer/src/components/EventCard.tsx`:

```tsx
import type { CalendarEvent } from '../../../shared/types'

interface EventCardProps {
  event: CalendarEvent
  onToggleAutoRecord: (eventId: string) => void
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

function getPlatform(url: string | null): string | null {
  if (!url) return null
  if (url.includes('meet.google.com')) return 'Google Meet'
  if (url.includes('zoom.us')) return 'Zoom'
  if (url.includes('teams.microsoft.com')) return 'Teams'
  if (url.includes('webex.com')) return 'Webex'
  return null
}

export function EventCard({ event, onToggleAutoRecord }: EventCardProps) {
  const platform = getPlatform(event.meetingUrl)

  return (
    <div className="px-4 py-3.5 bg-bg-card border border-border rounded-xl flex justify-between items-center">
      <div>
        <div className="text-[13.5px] font-semibold text-ink tracking-[-0.01em]">
          {event.title}
        </div>
        <div className="text-[11.5px] text-ink-faint mt-0.5">
          {formatTime(event.startTime)} - {formatTime(event.endTime)}
          {platform && <span>  ·  {platform}</span>}
        </div>
      </div>
      <button
        onClick={() => onToggleAutoRecord(event.id)}
        aria-label={event.autoRecord ? 'Disable auto-record' : 'Enable auto-record'}
        className={`text-[10px] font-medium px-2.5 py-1 rounded-full border transition-colors ${
          event.autoRecord
            ? 'bg-ink text-white border-ink'
            : 'bg-bg-accent text-ink border-border-subtle hover:border-ink-muted'
        }`}
      >
        Auto-record
      </button>
    </div>
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm run test:run
```

Expected: All EventCard tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/EventCard*
git commit -m "feat: add EventCard component with auto-record toggle"
```

---

### Task 7: ConnectCalendar Component

**Files:**
- Create: `src/renderer/src/components/ConnectCalendar.tsx`

- [ ] **Step 1: Create ConnectCalendar component**

Create `src/renderer/src/components/ConnectCalendar.tsx`:

```tsx
interface ConnectCalendarProps {
  isConnecting: boolean
  onConnect: () => void
}

export function ConnectCalendar({ isConnecting, onConnect }: ConnectCalendarProps) {
  return (
    <div className="flex-1 flex items-center justify-center p-6">
      <div className="text-center">
        <p className="text-ink-muted text-[13px]">
          Connect Google Calendar to see upcoming meetings
        </p>
        <button
          onClick={onConnect}
          disabled={isConnecting}
          className="mt-4 text-[12px] font-medium text-white bg-ink px-4 py-2 rounded-lg hover:bg-ink-secondary transition-colors disabled:opacity-50"
        >
          {isConnecting ? 'Connecting...' : 'Connect Calendar'}
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/src/components/ConnectCalendar.tsx
git commit -m "feat: add ConnectCalendar component"
```

---

### Task 8: Update Upcoming Page

**Files:**
- Modify: `src/renderer/src/pages/Upcoming.tsx`

- [ ] **Step 1: Read the current Upcoming.tsx**

Read `src/renderer/src/pages/Upcoming.tsx` to see the current placeholder.

- [ ] **Step 2: Replace with real implementation**

Replace `src/renderer/src/pages/Upcoming.tsx` with:

```tsx
import { useEffect } from 'react'
import { PageHeader } from '../components/PageHeader'
import { EventCard } from '../components/EventCard'
import { ConnectCalendar } from '../components/ConnectCalendar'
import { useCalendarStore } from '../stores/calendar'

export function Upcoming() {
  const {
    isConnected,
    isConnecting,
    events,
    isSyncing,
    setConnected,
    setConnecting,
    setEvents,
    setSyncing,
    toggleAutoRecord,
  } = useCalendarStore()

  useEffect(() => {
    // Check connection status on mount
    window.electronAPI.invoke('calendar:is-connected').then(setConnected)

    // Listen for event updates from main process
    const unsubscribe = window.electronAPI.on('calendar:events-updated', (updatedEvents) => {
      setEvents(updatedEvents)
    })

    // If already connected, fetch events
    window.electronAPI.invoke('calendar:is-connected').then(async (connected) => {
      if (connected) {
        const fetchedEvents = await window.electronAPI.invoke('calendar:get-events')
        setEvents(fetchedEvents)
      }
    })

    return unsubscribe
  }, [setConnected, setEvents])

  const handleConnect = async () => {
    setConnecting(true)
    try {
      await window.electronAPI.invoke('calendar:connect')
      setConnected(true)
      const fetchedEvents = await window.electronAPI.invoke('calendar:get-events')
      setEvents(fetchedEvents)
    } catch (err) {
      console.error('Failed to connect calendar:', err)
    } finally {
      setConnecting(false)
    }
  }

  const handleSync = async () => {
    setSyncing(true)
    try {
      const syncedEvents = await window.electronAPI.invoke('calendar:sync')
      setEvents(syncedEvents)
    } finally {
      setSyncing(false)
    }
  }

  const handleToggleAutoRecord = (eventId: string) => {
    toggleAutoRecord(eventId)
    const event = events.find((e) => e.id === eventId)
    if (event) {
      window.electronAPI.invoke('calendar:set-auto-record', eventId, !event.autoRecord)
    }
  }

  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Upcoming"
        subtitle={today}
        action={
          isConnected ? (
            <button
              onClick={handleSync}
              disabled={isSyncing}
              className="text-[11px] font-medium text-ink-muted bg-bg-accent px-3 py-1.5 rounded-md border border-border-subtle hover:border-ink-muted transition-colors disabled:opacity-50"
            >
              {isSyncing ? 'Syncing...' : 'Sync'}
            </button>
          ) : undefined
        }
      />

      {!isConnected ? (
        <ConnectCalendar isConnecting={isConnecting} onConnect={handleConnect} />
      ) : events.length === 0 ? (
        <div className="flex-1 flex items-center justify-center p-6">
          <p className="text-ink-muted text-[13px]">No upcoming meetings</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-6">
          <div className="flex flex-col gap-2">
            {events.map((event) => (
              <EventCard
                key={event.id}
                event={event}
                onToggleAutoRecord={handleToggleAutoRecord}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Verify build**

```bash
npm run build
```

Expected: Build succeeds.

- [ ] **Step 4: Run tests**

```bash
npm run test:run
```

Expected: All existing tests pass (EventCard + previous tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/pages/Upcoming.tsx
git commit -m "feat: update Upcoming page with real calendar integration"
```

---

### Task 9: Update Settings Page with Calendar Connection

**Files:**
- Modify: `src/renderer/src/pages/Settings.tsx`

- [ ] **Step 1: Read current Settings.tsx**

Read `src/renderer/src/pages/Settings.tsx`.

- [ ] **Step 2: Update Google Calendar section**

Replace the Settings component to show connection status and connect/disconnect buttons:

```tsx
import { PageHeader } from '../components/PageHeader'
import { useCalendarStore } from '../stores/calendar'

export function Settings() {
  const { isConnected, isConnecting, setConnected, setConnecting, setEvents } = useCalendarStore()

  const handleConnect = async () => {
    setConnecting(true)
    try {
      await window.electronAPI.invoke('calendar:connect')
      setConnected(true)
      const events = await window.electronAPI.invoke('calendar:get-events')
      setEvents(events)
    } catch (err) {
      console.error('Failed to connect calendar:', err)
    } finally {
      setConnecting(false)
    }
  }

  const handleDisconnect = async () => {
    await window.electronAPI.invoke('calendar:disconnect')
    setConnected(false)
    setEvents([])
  }

  return (
    <div className="flex flex-col h-full">
      <PageHeader title="Settings" />
      <div className="p-6 flex flex-col gap-6">
        <div>
          <h3 className="text-[13px] font-semibold text-ink mb-2">Google Calendar</h3>
          {isConnected ? (
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-status-connected" />
                <span className="text-[12px] text-ink-muted">Connected</span>
              </div>
              <button
                onClick={handleDisconnect}
                className="text-[12px] font-medium text-ink-muted bg-bg-accent px-3 py-1.5 rounded-lg border border-border-subtle hover:border-ink-muted transition-colors"
              >
                Disconnect
              </button>
            </div>
          ) : (
            <button
              onClick={handleConnect}
              disabled={isConnecting}
              className="text-[12px] font-medium text-white bg-ink px-4 py-2 rounded-lg hover:bg-ink-secondary transition-colors disabled:opacity-50"
            >
              {isConnecting ? 'Connecting...' : 'Connect'}
            </button>
          )}
        </div>
        <div>
          <h3 className="text-[13px] font-semibold text-ink mb-2">Auto-record</h3>
          <p className="text-[12px] text-ink-muted">Default: off</p>
        </div>
        <div>
          <h3 className="text-[13px] font-semibold text-ink mb-2">Ollama Model</h3>
          <p className="text-[12px] text-ink-muted">llama3 (default)</p>
        </div>
        <div>
          <h3 className="text-[13px] font-semibold text-ink mb-2">Storage Path</h3>
          <p className="text-[12px] text-ink-muted font-mono">~/AutoDoc/</p>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Verify build and tests**

```bash
npm run build && npm run test:run
```

Expected: Build succeeds, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/pages/Settings.tsx
git commit -m "feat: update Settings page with calendar connect/disconnect"
```
