# Core Shell & UI Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scaffold the Electron + React app with the Warm Parchment design system, sidebar navigation, page routing, and placeholder pages for all views.

**Architecture:** electron-vite scaffolds the Electron app with separate main, preload, and renderer entry points. React renderer uses Tailwind CSS v4 for styling with the Warm Parchment theme, Zustand for state, and react-router for page navigation. Type-safe IPC bridge between main and renderer via shared type definitions + contextBridge.

**Tech Stack:** electron-vite v5, React 19, TypeScript, Vite, Tailwind CSS v4, Zustand, react-router-dom, Geist font (Fontsource), Vitest + Testing Library, Playwright

---

## File Structure

```
src/
  main/
    index.ts                     # Main process: creates BrowserWindow, registers IPC handlers
  preload/
    index.ts                     # Preload: contextBridge exposing typed electronAPI
    ipc.d.ts                     # IPC channel type contracts
  renderer/
    index.html                   # HTML entry
    src/
      main.tsx                   # React entry: fonts, CSS, createRoot
      App.tsx                    # Root component: router + layout shell
      assets/
        main.css                 # Tailwind import + Warm Parchment theme tokens
      components/
        Sidebar.tsx              # Navigation sidebar with links and status
        Sidebar.test.tsx         # Sidebar tests
        PageHeader.tsx           # Reusable page header (title + subtitle + actions)
        PageHeader.test.tsx      # PageHeader tests
      pages/
        Upcoming.tsx             # Upcoming meetings placeholder
        Recordings.tsx           # Recordings list placeholder
        MeetingDetail.tsx        # Meeting detail with Notes/Transcript tabs
        MeetingDetail.test.tsx   # MeetingDetail tab tests
        Search.tsx               # Search placeholder
        AskAI.tsx                # Ask AI placeholder
        Settings.tsx             # Settings placeholder
      stores/
        app.ts                   # App-level state (sidebar, recording status, Ollama status)
      test/
        setup.ts                 # Vitest setup: jest-dom + electronAPI mock
  shared/
    types.ts                     # Shared types: Meeting, Segment, CalendarEvent, etc.
    constants.ts                 # App constants: category names, colors, routes
electron.vite.config.ts          # Unified build config with Tailwind + React plugins
vitest.config.ts                 # Vitest config for renderer unit tests
```

---

### Task 1: Scaffold Electron App

**Files:**
- Create: entire project scaffold via `electron-vite` CLI
- Modify: `package.json` (rename, update metadata)

- [ ] **Step 1: Scaffold with electron-vite**

```bash
cd /Users/rahuldewan/Documents/GitHub/AutoDoc
npx @electron-vite/create@latest . --template react-ts
```

When prompted, use project name `autodoc`. If the CLI complains about the directory not being empty (due to existing files like `.gitignore`, `docs/`), move them temporarily, scaffold, then move them back.

- [ ] **Step 2: Install dependencies**

```bash
npm install
```

- [ ] **Step 3: Verify the app launches**

```bash
npm run dev
```

Expected: Electron window opens with the default React template page. Close it.

- [ ] **Step 4: Update package.json metadata**

Set these fields in `package.json`:
```json
{
  "name": "autodoc",
  "version": "0.1.0",
  "description": "Local-first meeting assistant"
}
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: scaffold Electron app with electron-vite react-ts template"
```

---

### Task 2: Install Dependencies & Configure Tailwind + Geist

**Files:**
- Modify: `electron.vite.config.ts`
- Modify: `src/renderer/src/assets/main.css`
- Modify: `src/renderer/src/main.tsx`

- [ ] **Step 1: Install Tailwind v4, Geist fonts, and app dependencies**

```bash
npm install tailwindcss @tailwindcss/vite @fontsource-variable/geist @fontsource-variable/geist-mono zustand react-router-dom
```

- [ ] **Step 2: Configure electron.vite.config.ts**

```typescript
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [
      tailwindcss(),
      react()
    ]
  }
})
```

- [ ] **Step 3: Set up main.css with Tailwind + Warm Parchment theme**

Replace `src/renderer/src/assets/main.css` with:

```css
@import "tailwindcss";

@theme {
  --font-sans: 'Geist Variable', sans-serif;
  --font-mono: 'Geist Mono Variable', monospace;

  /* Warm Parchment palette */
  --color-bg-primary: #fafaf8;
  --color-bg-sidebar: #f7f7f5;
  --color-bg-accent: #f0f0ee;
  --color-bg-card: #ffffff;
  --color-border: #e8e6e1;
  --color-border-subtle: #e2e0db;
  --color-ink: #1a1a1a;
  --color-ink-secondary: #3d3b37;
  --color-ink-muted: #6b6966;
  --color-ink-faint: #9b9894;
  --color-status-connected: #22c55e;
  --color-status-recording: #ef4444;
  --color-status-processing: #f59e0b;
}

@layer base {
  body {
    @apply font-sans antialiased bg-bg-primary text-ink;
  }
}
```

- [ ] **Step 4: Import fonts in main.tsx**

Update `src/renderer/src/main.tsx`:

```typescript
import '@fontsource-variable/geist/wght.css'
import '@fontsource-variable/geist-mono/wght.css'
import './assets/main.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
```

- [ ] **Step 5: Verify — run dev and confirm Geist font renders**

```bash
npm run dev
```

Expected: App launches, text renders in Geist font with warm off-white background.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: configure Tailwind v4 with Warm Parchment theme and Geist font"
```

---

### Task 3: Set Up Testing Infrastructure

**Files:**
- Create: `vitest.config.ts`
- Create: `src/renderer/src/test/setup.ts`
- Modify: `package.json` (add test scripts)

- [ ] **Step 1: Install test dependencies**

```bash
npm install -D vitest @vitest/coverage-v8 jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event @playwright/test
```

- [ ] **Step 2: Create vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/renderer/src/test/setup.ts'],
    include: ['src/renderer/src/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['src/renderer/src/**']
    }
  },
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src')
    }
  }
})
```

- [ ] **Step 3: Create test setup file**

Create `src/renderer/src/test/setup.ts`:

```typescript
import '@testing-library/jest-dom'

vi.stubGlobal('electronAPI', {
  send: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(() => vi.fn())
})
```

- [ ] **Step 4: Add test scripts to package.json**

Add to `scripts`:
```json
{
  "test": "vitest",
  "test:run": "vitest run",
  "coverage": "vitest run --coverage"
}
```

- [ ] **Step 5: Verify — run tests (should pass with no test files yet)**

```bash
npm run test:run
```

Expected: Vitest runs, finds no tests, exits cleanly.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: set up Vitest with jsdom and Testing Library"
```

---

### Task 4: Shared Types & Constants

**Files:**
- Create: `src/shared/types.ts`
- Create: `src/shared/constants.ts`

- [ ] **Step 1: Create shared types**

Create `src/shared/types.ts`:

```typescript
export type MeetingStatus = 'recording' | 'processing' | 'complete' | 'failed'

export type SegmentCategory =
  | 'decision'
  | 'action_item'
  | 'information'
  | 'discussion'
  | 'status_update'

export interface Meeting {
  id: string
  title: string
  startTime: number
  endTime: number | null
  calendarEventId: string | null
  recordingPath: string | null
  audioPath: string | null
  status: MeetingStatus
  createdAt: number
}

export interface Transcript {
  id: string
  meetingId: string
  speaker: string
  text: string
  startMs: number
  endMs: number
  confidence: number
}

export interface Segment {
  id: string
  meetingId: string
  category: SegmentCategory
  title: string
  content: string
  assignee: string | null
  deadline: string | null
  sourceStartMs: number
  sourceEndMs: number
}

export interface CalendarEvent {
  id: string
  googleEventId: string
  title: string
  startTime: number
  endTime: number
  attendees: string[]
  meetingUrl: string | null
  autoRecord: boolean
  syncedAt: number
}

export interface MeetingSegments {
  decisions: Segment[]
  actionItems: Segment[]
  information: Segment[]
  discussion: Segment[]
  statusUpdates: Segment[]
}
```

- [ ] **Step 2: Create constants**

Create `src/shared/constants.ts`:

```typescript
import type { SegmentCategory } from './types'

export const SEGMENT_LABELS: Record<SegmentCategory, string> = {
  decision: 'Decisions',
  action_item: 'Action Items',
  information: 'Information Shared',
  discussion: 'Discussion',
  status_update: 'Status Updates',
}

export const ROUTES = {
  upcoming: '/',
  recordings: '/recordings',
  meetingDetail: '/recordings/:id',
  search: '/search',
  askAi: '/ask-ai',
  settings: '/settings',
} as const
```

- [ ] **Step 3: Commit**

```bash
git add src/shared/
git commit -m "feat: add shared types and constants"
```

---

### Task 5: Type-Safe IPC Bridge

**Files:**
- Create: `src/preload/ipc.d.ts`
- Modify: `src/preload/index.ts`
- Create: `src/renderer/src/env.d.ts`

- [ ] **Step 1: Define IPC type contracts**

Create `src/preload/ipc.d.ts`:

```typescript
export interface IpcSendEvents {
  'window:minimize': []
  'window:maximize': []
  'window:close': []
}

export interface IpcInvokeEvents {
  'app:get-version': []
}

export interface IpcInvokeReturns {
  'app:get-version': string
}

export interface IpcOnEvents {
  'recording:status-changed': [status: string]
}
```

- [ ] **Step 2: Implement preload bridge**

Replace `src/preload/index.ts` with:

```typescript
import { contextBridge, ipcRenderer } from 'electron'
import type { IpcSendEvents, IpcInvokeEvents, IpcInvokeReturns, IpcOnEvents } from './ipc'

const api = {
  send<K extends keyof IpcSendEvents>(
    channel: K,
    ...args: IpcSendEvents[K]
  ): void {
    ipcRenderer.send(channel, ...args)
  },

  invoke<K extends keyof IpcInvokeEvents>(
    channel: K,
    ...args: IpcInvokeEvents[K]
  ): Promise<IpcInvokeReturns[K]> {
    return ipcRenderer.invoke(channel, ...args)
  },

  on<K extends keyof IpcOnEvents>(
    channel: K,
    listener: (...args: IpcOnEvents[K]) => void
  ): () => void {
    const wrapped = (_e: Electron.IpcRendererEvent, ...args: IpcOnEvents[K]): void =>
      listener(...args)
    ipcRenderer.on(channel, wrapped as never)
    return () => ipcRenderer.removeListener(channel, wrapped as never)
  }
}

contextBridge.exposeInMainWorld('electronAPI', api)

export type ElectronAPI = typeof api
```

- [ ] **Step 3: Add renderer type declaration**

Create `src/renderer/src/env.d.ts`:

```typescript
import type { ElectronAPI } from '../../preload/index'

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
```

- [ ] **Step 4: Register a basic IPC handler in main**

In `src/main/index.ts`, add after app setup:

```typescript
import { ipcMain } from 'electron'

ipcMain.handle('app:get-version', () => {
  return app.getVersion()
})
```

- [ ] **Step 5: Verify — app launches with no type errors**

```bash
npm run dev
```

Expected: App launches without errors. No runtime errors in console.

- [ ] **Step 6: Commit**

```bash
git add src/preload/ src/renderer/src/env.d.ts src/main/
git commit -m "feat: add type-safe IPC bridge"
```

---

### Task 6: Zustand App Store

**Files:**
- Create: `src/renderer/src/stores/app.ts`

- [ ] **Step 1: Create the app store**

Create `src/renderer/src/stores/app.ts`:

```typescript
import { create } from 'zustand'

interface AppState {
  ollamaConnected: boolean
  isRecording: boolean
  recordingSeconds: number
  activePage: string

  setOllamaConnected: (connected: boolean) => void
  setRecording: (recording: boolean) => void
  setRecordingSeconds: (seconds: number) => void
  setActivePage: (page: string) => void
}

export const useAppStore = create<AppState>((set) => ({
  ollamaConnected: false,
  isRecording: false,
  recordingSeconds: 0,
  activePage: '/',

  setOllamaConnected: (connected) => set({ ollamaConnected: connected }),
  setRecording: (recording) => set({ isRecording: recording }),
  setRecordingSeconds: (seconds) => set({ recordingSeconds: seconds }),
  setActivePage: (page) => set({ activePage: page }),
}))
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/src/stores/
git commit -m "feat: add Zustand app store"
```

---

### Task 7: Sidebar Component

**Files:**
- Create: `src/renderer/src/components/Sidebar.tsx`
- Create: `src/renderer/src/components/Sidebar.test.tsx`

- [ ] **Step 1: Write failing tests for Sidebar**

Create `src/renderer/src/components/Sidebar.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect } from 'vitest'
import { Sidebar } from './Sidebar'

function renderSidebar() {
  return render(
    <MemoryRouter>
      <Sidebar />
    </MemoryRouter>
  )
}

describe('Sidebar', () => {
  it('renders the app name', () => {
    renderSidebar()
    expect(screen.getByText('AutoDoc')).toBeInTheDocument()
  })

  it('renders all navigation links', () => {
    renderSidebar()
    expect(screen.getByText('Upcoming')).toBeInTheDocument()
    expect(screen.getByText('Recordings')).toBeInTheDocument()
    expect(screen.getByText('Search')).toBeInTheDocument()
    expect(screen.getByText('Ask AI')).toBeInTheDocument()
  })

  it('renders settings link', () => {
    renderSidebar()
    expect(screen.getByText('Settings')).toBeInTheDocument()
  })

  it('renders Ollama status indicator', () => {
    renderSidebar()
    expect(screen.getByText(/ollama/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm run test:run
```

Expected: FAIL — `Sidebar` module not found.

- [ ] **Step 3: Implement Sidebar**

Create `src/renderer/src/components/Sidebar.tsx`:

```tsx
import { NavLink } from 'react-router-dom'
import { useAppStore } from '../stores/app'
import { ROUTES } from '../../../shared/constants'

const navItems = [
  { to: ROUTES.upcoming, label: 'Upcoming' },
  { to: ROUTES.recordings, label: 'Recordings' },
  { to: ROUTES.search, label: 'Search' },
  { to: ROUTES.askAi, label: 'Ask AI' },
]

export function Sidebar() {
  const ollamaConnected = useAppStore((s) => s.ollamaConnected)
  const isRecording = useAppStore((s) => s.isRecording)
  const recordingSeconds = useAppStore((s) => s.recordingSeconds)

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60)
    const s = seconds % 60
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  return (
    <aside className="w-[200px] bg-bg-sidebar border-r border-border flex flex-col p-5 shrink-0">
      <div className="text-[15px] font-bold text-ink tracking-[-0.03em]">
        AutoDoc
      </div>

      <nav className="mt-6 flex flex-col gap-0.5">
        {navItems.map(({ to, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `px-2.5 py-2 rounded-lg text-[12.5px] font-medium transition-colors ${
                isActive
                  ? 'bg-ink text-white'
                  : 'text-ink-muted hover:text-ink hover:bg-bg-accent'
              }`
            }
          >
            {label}
          </NavLink>
        ))}
      </nav>

      <div className="mt-auto flex flex-col gap-2">
        {isRecording && (
          <div className="flex items-center gap-2 px-2.5 py-2 bg-bg-accent rounded-lg">
            <div className="w-2 h-2 rounded-full bg-status-recording animate-pulse" />
            <span className="text-[11px] text-ink-muted">
              Recording · {formatTime(recordingSeconds)}
            </span>
          </div>
        )}

        <div className="flex items-center gap-2 px-2.5 py-2.5 bg-bg-accent rounded-lg">
          <div
            className={`w-2 h-2 rounded-full ${
              ollamaConnected ? 'bg-status-connected' : 'bg-status-recording'
            }`}
          />
          <span className="text-[11px] text-ink-muted">
            Ollama {ollamaConnected ? 'connected' : 'disconnected'}
          </span>
        </div>

        <NavLink
          to={ROUTES.settings}
          className={({ isActive }) =>
            `px-2.5 py-2 rounded-lg text-[12.5px] font-medium transition-colors ${
              isActive
                ? 'bg-ink text-white'
                : 'text-ink-muted hover:text-ink hover:bg-bg-accent'
            }`
          }
        >
          Settings
        </NavLink>
      </div>
    </aside>
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm run test:run
```

Expected: All 4 Sidebar tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/Sidebar*
git commit -m "feat: add Sidebar component with navigation and status"
```

---

### Task 8: PageHeader Component

**Files:**
- Create: `src/renderer/src/components/PageHeader.tsx`
- Create: `src/renderer/src/components/PageHeader.test.tsx`

- [ ] **Step 1: Write failing tests**

Create `src/renderer/src/components/PageHeader.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { PageHeader } from './PageHeader'

describe('PageHeader', () => {
  it('renders title', () => {
    render(<PageHeader title="Upcoming" />)
    expect(screen.getByText('Upcoming')).toBeInTheDocument()
  })

  it('renders subtitle when provided', () => {
    render(<PageHeader title="Upcoming" subtitle="Monday, March 24" />)
    expect(screen.getByText('Monday, March 24')).toBeInTheDocument()
  })

  it('renders action slot when provided', () => {
    render(<PageHeader title="Test" action={<button>Click</button>} />)
    expect(screen.getByText('Click')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm run test:run
```

Expected: FAIL — `PageHeader` module not found.

- [ ] **Step 3: Implement PageHeader**

Create `src/renderer/src/components/PageHeader.tsx`:

```tsx
import type { ReactNode } from 'react'

interface PageHeaderProps {
  title: string
  subtitle?: string
  action?: ReactNode
}

export function PageHeader({ title, subtitle, action }: PageHeaderProps) {
  return (
    <div className="flex justify-between items-baseline px-6 py-5 border-b border-border">
      <div>
        <h1 className="text-[18px] font-bold text-ink tracking-[-0.03em]">
          {title}
        </h1>
        {subtitle && (
          <p className="text-[12px] text-ink-faint mt-0.5">{subtitle}</p>
        )}
      </div>
      {action && <div>{action}</div>}
    </div>
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm run test:run
```

Expected: All PageHeader tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/PageHeader*
git commit -m "feat: add PageHeader component"
```

---

### Task 9: Placeholder Pages

**Files:**
- Create: `src/renderer/src/pages/Upcoming.tsx`
- Create: `src/renderer/src/pages/Recordings.tsx`
- Create: `src/renderer/src/pages/MeetingDetail.tsx`
- Create: `src/renderer/src/pages/MeetingDetail.test.tsx`
- Create: `src/renderer/src/pages/Search.tsx`
- Create: `src/renderer/src/pages/AskAI.tsx`
- Create: `src/renderer/src/pages/Settings.tsx`

- [ ] **Step 1: Create Upcoming page**

Create `src/renderer/src/pages/Upcoming.tsx`:

```tsx
import { PageHeader } from '../components/PageHeader'

export function Upcoming() {
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
          <button className="text-[11px] font-medium text-white bg-ink px-3 py-1.5 rounded-md hover:bg-ink-secondary transition-colors">
            + New meeting
          </button>
        }
      />
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="text-center">
          <p className="text-ink-muted text-[13px]">
            Connect Google Calendar to see upcoming meetings
          </p>
          <button className="mt-4 text-[12px] font-medium text-white bg-ink px-4 py-2 rounded-lg hover:bg-ink-secondary transition-colors">
            Connect Calendar
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Create Recordings page**

Create `src/renderer/src/pages/Recordings.tsx`:

```tsx
import { PageHeader } from '../components/PageHeader'

export function Recordings() {
  return (
    <div className="flex flex-col h-full">
      <PageHeader title="Recordings" />
      <div className="flex-1 flex items-center justify-center p-6">
        <p className="text-ink-muted text-[13px]">
          No recordings yet. Start a meeting to begin.
        </p>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Create MeetingDetail page with tabs**

Create `src/renderer/src/pages/MeetingDetail.tsx`:

```tsx
import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { SEGMENT_LABELS } from '../../../shared/constants'
import type { SegmentCategory } from '../../../shared/types'

type Tab = 'notes' | 'transcript'

const CATEGORY_ORDER: SegmentCategory[] = [
  'decision',
  'action_item',
  'information',
  'discussion',
  'status_update',
]

export function MeetingDetail() {
  const { id } = useParams<{ id: string }>()
  const [activeTab, setActiveTab] = useState<Tab>('notes')

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-4 border-b border-border">
        <h1 className="text-[16px] font-bold text-ink tracking-[-0.02em]">
          Meeting
        </h1>
        <p className="text-[11px] text-ink-faint mt-0.5">ID: {id}</p>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border px-6">
        {(['notes', 'transcript'] as Tab[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-3.5 py-2.5 text-[11.5px] font-semibold transition-colors ${
              activeTab === tab
                ? 'text-ink border-b-2 border-ink -mb-px'
                : 'text-ink-faint hover:text-ink-muted'
            }`}
          >
            {tab === 'notes' ? 'Notes' : 'Transcript'}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {activeTab === 'notes' ? (
          <div className="flex flex-col gap-4">
            {CATEGORY_ORDER.map((category) => (
              <div
                key={category}
                className="bg-bg-card border border-border rounded-xl p-4"
              >
                <div className="flex items-center gap-1.5 mb-2">
                  <div className="w-1.5 h-1.5 rounded-full bg-ink" />
                  <span className="text-[11px] font-bold text-ink tracking-[0.03em] uppercase">
                    {SEGMENT_LABELS[category]}
                  </span>
                </div>
                <p className="text-[12px] text-ink-muted leading-relaxed">
                  No {SEGMENT_LABELS[category].toLowerCase()} recorded yet.
                </p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[12px] text-ink-muted">
            Transcript will appear here after processing.
          </p>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Write MeetingDetail tab tests**

Create `src/renderer/src/pages/MeetingDetail.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect } from 'vitest'
import { MeetingDetail } from './MeetingDetail'

function renderMeetingDetail() {
  return render(
    <MemoryRouter initialEntries={['/recordings/test-123']}>
      <Routes>
        <Route path="/recordings/:id" element={<MeetingDetail />} />
      </Routes>
    </MemoryRouter>
  )
}

describe('MeetingDetail', () => {
  it('renders Notes tab by default with all HOM categories', () => {
    renderMeetingDetail()
    expect(screen.getByText('Notes')).toBeInTheDocument()
    expect(screen.getByText('Decisions')).toBeInTheDocument()
    expect(screen.getByText('Action Items')).toBeInTheDocument()
    expect(screen.getByText('Information Shared')).toBeInTheDocument()
    expect(screen.getByText('Discussion')).toBeInTheDocument()
    expect(screen.getByText('Status Updates')).toBeInTheDocument()
  })

  it('switches to Transcript tab on click', async () => {
    renderMeetingDetail()
    const user = userEvent.setup()

    await user.click(screen.getByText('Transcript'))
    expect(screen.getByText(/transcript will appear/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 5: Create Search page**

Create `src/renderer/src/pages/Search.tsx`:

```tsx
import { PageHeader } from '../components/PageHeader'

export function Search() {
  return (
    <div className="flex flex-col h-full">
      <PageHeader title="Search" />
      <div className="p-6">
        <input
          type="text"
          placeholder="Search across all meetings..."
          className="w-full px-4 py-2.5 bg-bg-card border border-border rounded-lg text-[13px] text-ink placeholder:text-ink-faint focus:outline-none focus:border-ink-muted transition-colors"
        />
      </div>
      <div className="flex-1 flex items-center justify-center">
        <p className="text-ink-muted text-[13px]">
          Search results will appear here
        </p>
      </div>
    </div>
  )
}
```

- [ ] **Step 6: Create AskAI page**

Create `src/renderer/src/pages/AskAI.tsx`:

```tsx
import { PageHeader } from '../components/PageHeader'

export function AskAI() {
  return (
    <div className="flex flex-col h-full">
      <PageHeader title="Ask AI" />
      <div className="flex-1 flex items-center justify-center p-6">
        <p className="text-ink-muted text-[13px]">
          Ask questions about your meetings
        </p>
      </div>
      <div className="p-6 border-t border-border">
        <input
          type="text"
          placeholder="Ask a question about your meetings..."
          className="w-full px-4 py-2.5 bg-bg-card border border-border rounded-lg text-[13px] text-ink placeholder:text-ink-faint focus:outline-none focus:border-ink-muted transition-colors"
        />
      </div>
    </div>
  )
}
```

- [ ] **Step 7: Create Settings page**

Create `src/renderer/src/pages/Settings.tsx`:

```tsx
import { PageHeader } from '../components/PageHeader'

export function Settings() {
  return (
    <div className="flex flex-col h-full">
      <PageHeader title="Settings" />
      <div className="p-6 flex flex-col gap-6">
        <div>
          <h3 className="text-[13px] font-semibold text-ink mb-2">Google Calendar</h3>
          <button className="text-[12px] font-medium text-white bg-ink px-4 py-2 rounded-lg hover:bg-ink-secondary transition-colors">
            Connect
          </button>
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

- [ ] **Step 8: Run all tests**

```bash
npm run test:run
```

Expected: All tests pass (Sidebar, PageHeader, MeetingDetail).

- [ ] **Step 9: Commit**

```bash
git add src/renderer/src/pages/
git commit -m "feat: add all placeholder pages with MeetingDetail tabs"
```

---

### Task 10: App Layout & Routing

**Files:**
- Modify: `src/renderer/src/App.tsx`

- [ ] **Step 1: Wire up router and layout in App.tsx**

Replace `src/renderer/src/App.tsx` with:

```tsx
import { HashRouter, Routes, Route } from 'react-router-dom'
import { Sidebar } from './components/Sidebar'
import { Upcoming } from './pages/Upcoming'
import { Recordings } from './pages/Recordings'
import { MeetingDetail } from './pages/MeetingDetail'
import { Search } from './pages/Search'
import { AskAI } from './pages/AskAI'
import { Settings } from './pages/Settings'
import { ROUTES } from '../../shared/constants'

export default function App() {
  return (
    <HashRouter>
      <div className="flex h-screen bg-bg-primary">
        <Sidebar />
        <main className="flex-1 overflow-hidden">
          <Routes>
            <Route path={ROUTES.upcoming} element={<Upcoming />} />
            <Route path={ROUTES.recordings} element={<Recordings />} />
            <Route path={ROUTES.meetingDetail} element={<MeetingDetail />} />
            <Route path={ROUTES.search} element={<Search />} />
            <Route path={ROUTES.askAi} element={<AskAI />} />
            <Route path={ROUTES.settings} element={<Settings />} />
          </Routes>
        </main>
      </div>
    </HashRouter>
  )
}
```

- [ ] **Step 2: Run tests to verify nothing broke**

```bash
npm run test:run
```

Expected: All tests still pass.

- [ ] **Step 3: Run the app and visually verify**

```bash
npm run dev
```

Expected: App launches with warm parchment theme, sidebar with all nav items, Upcoming page visible by default. Clicking nav items switches pages. MeetingDetail is accessible (will be wired up in later sub-projects).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/App.tsx
git commit -m "feat: wire up router and app shell layout"
```

---

### Task 11: Main Process Window Setup

**Files:**
- Modify: `src/main/index.ts`

- [ ] **Step 1: Configure main process window**

Replace `src/main/index.ts` with a clean setup:

```typescript
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 800,
    minHeight: 600,
    show: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#fafaf8',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  ipcMain.handle('app:get-version', () => app.getVersion())

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
```

- [ ] **Step 2: Verify app launches with proper window**

```bash
npm run dev
```

Expected: App launches with 1100x720 window, hidden title bar on macOS, warm background color during load.

- [ ] **Step 3: Commit**

```bash
git add src/main/index.ts
git commit -m "feat: configure main process window with proper defaults"
```

---

### Task 12: Clean Up & Final Verification

**Files:**
- Remove: any unused template files from scaffolding (e.g., default assets, logos)

- [ ] **Step 1: Remove scaffolding artifacts**

Delete any files not listed in the File Structure at the top of this plan — these are scaffolding artifacts (e.g., `src/renderer/src/assets/electron.svg`, template logos, default component files). Keep only the files we've created or modified.

- [ ] **Step 2: Run full test suite**

```bash
npm run test:run
```

Expected: All tests pass.

- [ ] **Step 3: Build the app**

```bash
npm run build
```

Expected: Build completes without errors.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: clean up scaffolding artifacts"
```
