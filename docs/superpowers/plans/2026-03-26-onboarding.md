# Onboarding Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a beautiful multi-step onboarding wizard with permission grants, feature introduction, and contextual toast banners for missing permissions.

**Architecture:** Fullscreen gate in App.tsx before HashRouter. 9 wizard screens (welcome, 3 feature screens, 3 permission screens, AI setup, all-set). Prefs stored in electron-store. Toast Zustand store for post-onboarding permission prompts.

**Tech Stack:** React, Tailwind CSS (existing Murmur theme), electron-store, Zustand, Vitest + Testing Library

**Spec:** `docs/superpowers/specs/2026-03-26-onboarding-design.md`

---

### Task 1: Prefs Store & IPC (Main Process)

**Files:**
- Create: `src/main/services/prefs-store.ts`
- Create: `src/main/ipc/prefs-ipc.ts`
- Create: `src/main/ipc/__tests__/prefs-ipc.test.ts`
- Modify: `src/main/index.ts`
- Modify: `src/preload/ipc.d.ts`

- [ ] **Step 1: Write the prefs-store test**

Create `src/main/ipc/__tests__/prefs-ipc.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}))

vi.mock('electron-store', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      get: vi.fn(),
      set: vi.fn(),
    })),
  }
})

import { PrefsStore } from '../../services/prefs-store'

describe('PrefsStore', () => {
  let store: PrefsStore

  beforeEach(() => {
    store = new PrefsStore()
  })

  it('returns false for onboardingComplete by default', () => {
    expect(store.isOnboardingComplete()).toBe(false)
  })

  it('sets onboardingComplete to true', () => {
    store.setOnboardingComplete()
    expect(store.isOnboardingComplete()).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/ipc/__tests__/prefs-ipc.test.ts --config vitest.main.config.mts`
Expected: FAIL — `PrefsStore` module not found

- [ ] **Step 3: Implement prefs-store**

Create `src/main/services/prefs-store.ts`:

```typescript
import Store from 'electron-store'

export class PrefsStore {
  private store: Store

  constructor() {
    this.store = new Store({ name: 'autodoc-prefs' })
  }

  isOnboardingComplete(): boolean {
    return this.store.get('onboardingComplete', false) as boolean
  }

  setOnboardingComplete(): void {
    this.store.set('onboardingComplete', true)
  }
}
```

- [ ] **Step 4: Implement prefs-ipc**

Create `src/main/ipc/prefs-ipc.ts`:

```typescript
import { ipcMain } from 'electron'
import type { PrefsStore } from '../services/prefs-store'

export function registerPrefsIpc(prefsStore: PrefsStore): void {
  ipcMain.handle('prefs:get-onboarding-complete', (): boolean => {
    return prefsStore.isOnboardingComplete()
  })

  ipcMain.handle('prefs:set-onboarding-complete', (): void => {
    prefsStore.setOnboardingComplete()
  })
}
```

- [ ] **Step 5: Add IPC type definitions**

In `src/preload/ipc.d.ts`, add to `IpcInvokeEvents`:

```typescript
'prefs:get-onboarding-complete': []
'prefs:set-onboarding-complete': []
```

Add to `IpcInvokeReturns`:

```typescript
'prefs:get-onboarding-complete': boolean
'prefs:set-onboarding-complete': void
```

- [ ] **Step 6: Register in index.ts**

In `src/main/index.ts`, add import:

```typescript
import { PrefsStore } from './services/prefs-store'
import { registerPrefsIpc } from './ipc/prefs-ipc'
```

Inside `app.whenReady()`, before other IPC registrations:

```typescript
const prefsStore = new PrefsStore()
registerPrefsIpc(prefsStore)
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run src/main/ipc/__tests__/prefs-ipc.test.ts --config vitest.main.config.mts`
Expected: PASS

- [ ] **Step 8: Run all main tests**

Run: `npx vitest run --config vitest.main.config.mts`
Expected: All pass

- [ ] **Step 9: Commit**

```bash
git add src/main/services/prefs-store.ts src/main/ipc/prefs-ipc.ts src/main/ipc/__tests__/prefs-ipc.test.ts src/main/index.ts src/preload/ipc.d.ts
git commit -m "feat(onboarding): add prefs store and IPC for onboarding completion flag"
```

---

### Task 2: Ollama Setup Status IPC

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/main/ipc/llm-ipc.ts`
- Modify: `src/preload/ipc.d.ts`

- [ ] **Step 1: Define the OllamaSetupStatus type**

In `src/shared/types.ts`, add:

```typescript
export interface OllamaSetupStatus {
  phase: 'downloading' | 'pulling' | 'ready' | 'error'
  percent: number
  error?: string
}
```

- [ ] **Step 2: Add IPC type definitions**

In `src/preload/ipc.d.ts`, import `OllamaSetupStatus` and add to `IpcInvokeEvents`:

```typescript
'ollama:get-setup-status': []
'ollama:retry-setup': []
```

Add to `IpcInvokeReturns`:

```typescript
'ollama:get-setup-status': OllamaSetupStatus
'ollama:retry-setup': void
```

Add to `IpcOnEvents`:

```typescript
'ollama:setup-progress': [status: OllamaSetupStatus]
```

- [ ] **Step 3: Add handler in llm-ipc.ts**

In `src/main/ipc/llm-ipc.ts`, add a parameter for the setup state getter. Update the function signature:

```typescript
export function registerLlmIpc(
  segmentationService: SegmentationService,
  ollamaManager: OllamaManager,
  ollamaProvider: OllamaProvider,
  getOllamaSetupStatus: () => OllamaSetupStatus,
): void {
```

Add the handler inside the function:

```typescript
ipcMain.handle(
  'ollama:get-setup-status',
  (): OllamaSetupStatus => {
    return getOllamaSetupStatus()
  }
)

ipcMain.handle(
  'ollama:retry-setup',
  async (): Promise<void> => {
    await ollamaManager.startAndPull()
  }
)
```

Import `OllamaSetupStatus` from `../../shared/types`. The `ollamaManager` parameter is already available.

- [ ] **Step 4: Add state tracking and event forwarding in index.ts**

In `src/main/index.ts`, after `ollamaManager = new OllamaManager()`, add the state object and event listeners:

```typescript
import type { OllamaSetupStatus } from '../shared/types'

// Mutable state tracking Ollama setup progress
const ollamaSetupState: OllamaSetupStatus = { phase: 'downloading', percent: 0 }

function broadcastOllamaStatus(): void {
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    win.webContents.send('ollama:setup-progress', { ...ollamaSetupState })
  }
}

ollamaManager.on('download-start', () => {
  ollamaSetupState.phase = 'downloading'
  ollamaSetupState.percent = 0
  broadcastOllamaStatus()
})

ollamaManager.on('download-progress', (data: { percent: number }) => {
  ollamaSetupState.phase = 'downloading'
  ollamaSetupState.percent = data.percent
  broadcastOllamaStatus()
})

ollamaManager.on('download-complete', () => {
  ollamaSetupState.phase = 'pulling'
  ollamaSetupState.percent = 0
  broadcastOllamaStatus()
})

ollamaManager.on('pull-start', () => {
  ollamaSetupState.phase = 'pulling'
  ollamaSetupState.percent = 0
  broadcastOllamaStatus()
})

ollamaManager.on('pull-progress', (data: { percent: number }) => {
  ollamaSetupState.phase = 'pulling'
  ollamaSetupState.percent = data.percent
  broadcastOllamaStatus()
})

ollamaManager.on('pull-complete', () => {
  ollamaSetupState.phase = 'ready'
  ollamaSetupState.percent = 100
  broadcastOllamaStatus()
})
```

Update the `registerLlmIpc` call to pass the getter:

```typescript
registerLlmIpc(segmentationService, ollamaManager, ollamaProvider, () => ({ ...ollamaSetupState }))
```

Also update the `startAndPull` error handler:

```typescript
ollamaManager.startAndPull().catch((err) => {
  ollamaSetupState.phase = 'error'
  ollamaSetupState.error = err instanceof Error ? err.message : String(err)
  broadcastOllamaStatus()
  console.error('Failed to start Ollama:', err)
})
```

- [ ] **Step 5: Run all main tests**

Run: `npx vitest run --config vitest.main.config.mts`
Expected: All pass (the llm-ipc test may need the new parameter added to its mock call)

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/preload/ipc.d.ts src/main/ipc/llm-ipc.ts src/main/index.ts
git commit -m "feat(onboarding): add Ollama setup status IPC with progress forwarding"
```

---

### Task 3: Toast Store & Component

**Files:**
- Create: `src/renderer/src/stores/toast.ts`
- Create: `src/renderer/src/components/PermissionToast.tsx`
- Create: `src/renderer/src/components/__tests__/PermissionToast.test.tsx`

- [ ] **Step 1: Write the toast store test**

Create `src/renderer/src/stores/__tests__/toast.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useToastStore } from '../toast'

describe('useToastStore', () => {
  beforeEach(() => {
    useToastStore.setState({ activeToast: null })
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts with no active toast', () => {
    expect(useToastStore.getState().activeToast).toBeNull()
  })

  it('shows a toast', () => {
    useToastStore.getState().showToast({ type: 'screen', message: 'Enable screen recording' })
    expect(useToastStore.getState().activeToast).toEqual({
      type: 'screen',
      message: 'Enable screen recording',
    })
  })

  it('dismisses a toast', () => {
    useToastStore.getState().showToast({ type: 'screen', message: 'test' })
    useToastStore.getState().dismissToast()
    expect(useToastStore.getState().activeToast).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/stores/__tests__/toast.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement toast store**

Create `src/renderer/src/stores/toast.ts`:

```typescript
import { create } from 'zustand'

interface Toast {
  type: 'screen' | 'microphone' | 'calendar'
  message: string
}

interface ToastStore {
  activeToast: Toast | null
  showToast: (toast: Toast) => void
  dismissToast: () => void
}

export const useToastStore = create<ToastStore>((set) => ({
  activeToast: null,

  showToast: (toast) => set({ activeToast: toast }),

  dismissToast: () => set({ activeToast: null }),
}))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/stores/__tests__/toast.test.ts`
Expected: PASS

- [ ] **Step 5: Write the PermissionToast component test**

Create `src/renderer/src/components/__tests__/PermissionToast.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PermissionToast } from '../PermissionToast'
import { useToastStore } from '../../stores/toast'

describe('PermissionToast', () => {
  beforeEach(() => {
    useToastStore.setState({ activeToast: null })
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders nothing when no active toast', () => {
    const { container } = render(<PermissionToast />)
    expect(container.firstChild).toBeNull()
  })

  it('renders toast message when active', () => {
    useToastStore.setState({
      activeToast: { type: 'screen', message: 'Enable screen recording' },
    })
    render(<PermissionToast />)
    expect(screen.getByText('Enable screen recording')).toBeInTheDocument()
  })

  it('dismisses on X click', async () => {
    vi.useRealTimers()
    useToastStore.setState({
      activeToast: { type: 'screen', message: 'test' },
    })
    render(<PermissionToast />)
    await userEvent.click(screen.getByTitle('Dismiss'))
    expect(useToastStore.getState().activeToast).toBeNull()
  })

  it('auto-dismisses after 8 seconds', () => {
    useToastStore.setState({
      activeToast: { type: 'microphone', message: 'test' },
    })
    render(<PermissionToast />)
    act(() => { vi.advanceTimersByTime(8000) })
    expect(useToastStore.getState().activeToast).toBeNull()
  })
})
```

- [ ] **Step 6: Implement PermissionToast component**

Create `src/renderer/src/components/PermissionToast.tsx`:

```tsx
import { useEffect } from 'react'
import { useToastStore } from '../stores/toast'

const ICONS: Record<string, string> = {
  screen: '🖥️',
  microphone: '🎤',
  calendar: '📅',
}

export function PermissionToast() {
  const { activeToast, dismissToast } = useToastStore()

  useEffect(() => {
    if (!activeToast) return
    const timer = setTimeout(dismissToast, 8000)
    return () => clearTimeout(timer)
  }, [activeToast, dismissToast])

  if (!activeToast) return null

  const handleEnable = () => {
    if (activeToast.type === 'calendar') {
      window.electronAPI.invoke('calendar:connect')
    } else {
      window.electronAPI.invoke('permissions:open-settings', activeToast.type as 'screen' | 'microphone')
    }
  }

  return (
    <div className="mx-6 mt-2 mb-0 bg-bg-card border border-border rounded-xl px-4 py-3 flex items-center gap-3 shadow-sm animate-[slideDown_300ms_ease]">
      <span className="text-[16px]">{ICONS[activeToast.type] ?? '⚠️'}</span>
      <span className="text-[12px] text-ink-secondary flex-1">{activeToast.message}</span>
      <button
        onClick={handleEnable}
        className="text-[12px] font-semibold text-sage hover:text-sage-dark whitespace-nowrap transition-colors"
      >
        Enable
      </button>
      <button
        onClick={dismissToast}
        title="Dismiss"
        className="text-[16px] text-ink-faint hover:text-ink-muted leading-none transition-colors"
      >
        ×
      </button>
    </div>
  )
}
```

Note: Add the `slideDown` keyframe in `main.css` inside `@layer base` or as a `@keyframes` block:

```css
@keyframes slideDown {
  from { opacity: 0; transform: translateY(-12px); }
  to { opacity: 1; transform: translateY(0); }
}
```

- [ ] **Step 7: Run tests**

Run: `npx vitest run src/renderer/src/components/__tests__/PermissionToast.test.tsx && npx vitest run src/renderer/src/stores/__tests__/toast.test.ts`
Expected: All pass

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/stores/toast.ts src/renderer/src/stores/__tests__/toast.test.ts src/renderer/src/components/PermissionToast.tsx src/renderer/src/components/__tests__/PermissionToast.test.tsx src/renderer/src/assets/main.css
git commit -m "feat(onboarding): add toast store and PermissionToast component"
```

---

### Task 4: Onboarding Wizard Shell & Feature Steps

**Files:**
- Create: `src/renderer/src/pages/Onboarding.tsx`
- Create: `src/renderer/src/components/onboarding/WelcomeStep.tsx`
- Create: `src/renderer/src/components/onboarding/FeatureStep.tsx`
- Create: `src/renderer/src/components/onboarding/StepDots.tsx`
- Create: `src/renderer/src/pages/__tests__/Onboarding.test.tsx`

- [ ] **Step 1: Write the Onboarding shell test**

Create `src/renderer/src/pages/__tests__/Onboarding.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Onboarding } from '../Onboarding'

describe('Onboarding', () => {
  it('renders welcome screen first', () => {
    render(<Onboarding onComplete={vi.fn()} />)
    expect(screen.getByText(/your meetings talk/i)).toBeInTheDocument()
    expect(screen.getByText('Get Started →')).toBeInTheDocument()
  })

  it('advances to next screen on Get Started click', async () => {
    render(<Onboarding onComplete={vi.fn()} />)
    await userEvent.click(screen.getByText('Get Started →'))
    expect(screen.getByText('Private by Design')).toBeInTheDocument()
  })

  it('navigates through feature screens with Next', async () => {
    render(<Onboarding onComplete={vi.fn()} />)
    await userEvent.click(screen.getByText('Get Started →'))
    // Screen 2: Private
    expect(screen.getByText('Private by Design')).toBeInTheDocument()
    await userEvent.click(screen.getByText('Next →'))
    // Screen 3: How It Works
    expect(screen.getByText('How It Works')).toBeInTheDocument()
    await userEvent.click(screen.getByText('Next →'))
    // Screen 4: Notes That Think
    expect(screen.getByText('Notes That Think')).toBeInTheDocument()
  })

  it('renders step dots', () => {
    render(<Onboarding onComplete={vi.fn()} />)
    const dots = document.querySelectorAll('[data-testid="step-dot"]')
    expect(dots.length).toBe(8)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/pages/__tests__/Onboarding.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Implement StepDots**

Create `src/renderer/src/components/onboarding/StepDots.tsx`:

```tsx
export function StepDots({ total, current }: { total: number; current: number }) {
  return (
    <div className="flex gap-1.5 justify-center">
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          data-testid="step-dot"
          className={`h-1.5 rounded-full transition-all duration-300 ${
            i < current
              ? 'w-1.5 bg-sage'
              : i === current
                ? 'w-4 bg-ink'
                : 'w-1.5 bg-border'
          }`}
        />
      ))}
    </div>
  )
}
```

- [ ] **Step 4: Implement WelcomeStep**

Create `src/renderer/src/components/onboarding/WelcomeStep.tsx`:

```tsx
export function WelcomeStep({ onNext }: { onNext: () => void }) {
  return (
    <div className="text-center">
      {/* Animated waveform */}
      <div className="flex items-center justify-center gap-[3px] h-10 mb-6">
        {[0, 0.1, 0.2, 0.3, 0.15, 0.25, 0.05].map((delay, i) => (
          <div
            key={i}
            className="w-[3px] rounded-sm bg-sage"
            style={{
              height: [12, 24, 36, 20, 32, 16, 28][i],
              transformOrigin: 'bottom',
              animation: `wave 1.2s ease-in-out ${delay}s infinite`,
            }}
          />
        ))}
      </div>

      <h1 className="font-serif text-[36px] text-ink tracking-[-0.02em]">AutoDoc</h1>
      <p className="text-[15px] text-ink-muted leading-relaxed mt-1.5 mb-8">
        Your meetings talk. We listen.
        <br />
        So you don't have to take notes.
      </p>
      <button
        onClick={onNext}
        className="px-8 py-3 bg-ink text-white rounded-[10px] text-[14px] font-semibold hover:bg-ink-secondary transition-colors"
      >
        Get Started →
      </button>
    </div>
  )
}
```

Add the `wave` keyframe to `main.css`:

```css
@keyframes wave {
  0%, 100% { transform: scaleY(0.5); }
  50% { transform: scaleY(1); }
}
```

- [ ] **Step 5: Implement FeatureStep**

Create `src/renderer/src/components/onboarding/FeatureStep.tsx`:

```tsx
interface FeatureRow {
  icon: string
  iconBg: string
  title: string
  description: string
}

interface FeatureStepProps {
  icon: string
  iconBg: string
  heading: string
  body: string
  features?: FeatureRow[]
  onNext: () => void
}

export function FeatureStep({ icon, iconBg, heading, body, features, onNext }: FeatureStepProps) {
  return (
    <div className="text-center">
      <div className={`w-16 h-16 rounded-2xl ${iconBg} flex items-center justify-center text-[28px] mx-auto mb-5`}>
        {icon}
      </div>
      <h2 className="text-[20px] font-bold text-ink tracking-[-0.02em] mb-2">{heading}</h2>
      <p className="text-[14px] text-ink-muted leading-relaxed mb-7">{body}</p>

      {features && (
        <div className="flex flex-col gap-3 mb-7 text-left">
          {features.map((f) => (
            <div key={f.title} className="flex items-start gap-3 px-4 py-3 bg-bg-card border border-border rounded-xl">
              <div className={`w-9 h-9 rounded-lg ${f.iconBg} flex items-center justify-center text-[16px] shrink-0`}>
                {f.icon}
              </div>
              <div>
                <div className="text-[13px] font-semibold text-ink">{f.title}</div>
                <div className="text-[12px] text-ink-muted leading-snug mt-0.5">{f.description}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      <button
        onClick={onNext}
        className="px-8 py-3 border border-border rounded-[10px] text-[14px] font-medium text-ink hover:border-border-strong transition-colors"
      >
        Next →
      </button>
    </div>
  )
}
```

- [ ] **Step 6: Implement Onboarding shell**

Create `src/renderer/src/pages/Onboarding.tsx`:

```tsx
import { useState } from 'react'
import { StepDots } from '../components/onboarding/StepDots'
import { WelcomeStep } from '../components/onboarding/WelcomeStep'
import { FeatureStep } from '../components/onboarding/FeatureStep'
import { MicPermissionStep } from '../components/onboarding/MicPermissionStep'
import { ScreenPermissionStep } from '../components/onboarding/ScreenPermissionStep'
import { CalendarStep } from '../components/onboarding/CalendarStep'
import { OllamaStep } from '../components/onboarding/OllamaStep'
import { AllSetStep } from '../components/onboarding/AllSetStep'

const TOTAL_DOTS = 8

export function Onboarding({ onComplete }: { onComplete: () => void }) {
  const [step, setStep] = useState(0)

  const next = () => setStep((s) => s + 1)

  const handleFinish = async () => {
    await window.electronAPI.invoke('prefs:set-onboarding-complete')
    onComplete()
  }

  const renderStep = () => {
    switch (step) {
      case 0:
        return <WelcomeStep onNext={next} />
      case 1:
        return (
          <FeatureStep
            icon="🔒"
            iconBg="bg-sage-light"
            heading="Private by Design"
            body="AutoDoc is fully open source and runs entirely on your machine. Your meetings are encrypted on disk and never leave your computer. No cloud. No accounts. No compromises. Built by ex-Apple engineers who believe your data is yours."
            onNext={next}
          />
        )
      case 2:
        return (
          <FeatureStep
            icon="🎧"
            iconBg="bg-dusk-light"
            heading="How It Works"
            body="AutoDoc quietly records your meeting audio, transcribes it locally, and identifies who's speaking — all on your device."
            features={[
              { icon: '🎤', iconBg: 'bg-sage-light', title: 'Captures audio', description: 'Records mic and system audio separately for clean speaker identification' },
              { icon: '📝', iconBg: 'bg-dusk-light', title: 'Transcribes locally', description: 'whisper.cpp runs on-device — fast, private, no internet needed' },
              { icon: '👥', iconBg: 'bg-mist-light', title: 'Identifies speakers', description: "Knows who's talking — labels \"Me\" vs \"Them\" automatically" },
            ]}
            onNext={next}
          />
        )
      case 3:
        return (
          <FeatureStep
            icon="📋"
            iconBg="bg-clay-light"
            heading="Notes That Think"
            body="Inspired by Andy Grove's High Output Management, AutoDoc breaks every meeting into the patterns that matter — fully editable by you."
            features={[
              { icon: '✅', iconBg: 'bg-[#FEF3C7]', title: 'Decisions', description: 'What was decided and why' },
              { icon: '📌', iconBg: 'bg-clay-light', title: 'Action Items', description: 'Who does what, by when' },
              { icon: '💬', iconBg: 'bg-sage-light', title: 'Discussion & Status', description: 'Key points, updates, and context' },
            ]}
            onNext={next}
          />
        )
      case 4:
        return <MicPermissionStep onNext={next} />
      case 5:
        return <ScreenPermissionStep onNext={next} />
      case 6:
        return <CalendarStep onNext={next} />
      case 7:
        return <OllamaStep onNext={next} />
      case 8:
        return <AllSetStep onFinish={handleFinish} />
      default:
        return null
    }
  }

  return (
    <div className="h-screen bg-bg-primary flex flex-col items-center justify-center relative">
      {/* macOS drag region */}
      <div
        className="absolute top-0 left-0 right-0 h-[52px]"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      />

      {/* Step dots (hidden on All Set screen) */}
      {step < TOTAL_DOTS && (
        <div className="absolute top-7 left-1/2 -translate-x-1/2">
          <StepDots total={TOTAL_DOTS} current={step} />
        </div>
      )}

      {/* Content */}
      <div className="max-w-[440px] w-full px-6 animate-[fadeUp_400ms_ease]" key={step}>
        {renderStep()}
      </div>
    </div>
  )
}
```

Add `fadeUp` keyframe to `main.css`:

```css
@keyframes fadeUp {
  from { opacity: 0; transform: translateY(16px); }
  to { opacity: 1; transform: translateY(0); }
}
```

Note: For this step, create stub files for `MicPermissionStep`, `ScreenPermissionStep`, `CalendarStep`, `OllamaStep`, and `AllSetStep` that just render a placeholder `<div>` so the imports don't fail. They'll be implemented in subsequent tasks.

Stub example (repeat for each):
```tsx
export function MicPermissionStep({ onNext }: { onNext: () => void }) {
  return <div><button onClick={onNext}>Continue →</button></div>
}
```

- [ ] **Step 7: Run tests**

Run: `npx vitest run src/renderer/src/pages/__tests__/Onboarding.test.tsx`
Expected: All pass

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/pages/Onboarding.tsx src/renderer/src/pages/__tests__/Onboarding.test.tsx src/renderer/src/components/onboarding/ src/renderer/src/assets/main.css
git commit -m "feat(onboarding): add wizard shell with welcome and feature steps"
```

---

### Task 5: Permission Steps (Mic, Screen, Calendar)

**Files:**
- Modify: `src/renderer/src/components/onboarding/MicPermissionStep.tsx`
- Modify: `src/renderer/src/components/onboarding/ScreenPermissionStep.tsx`
- Modify: `src/renderer/src/components/onboarding/CalendarStep.tsx`
- Create: `src/renderer/src/components/onboarding/__tests__/MicPermissionStep.test.tsx`

- [ ] **Step 1: Write the MicPermissionStep test**

Create `src/renderer/src/components/onboarding/__tests__/MicPermissionStep.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MicPermissionStep } from '../MicPermissionStep'

describe('MicPermissionStep', () => {
  it('renders required badge and enable button', () => {
    render(<MicPermissionStep onNext={vi.fn()} />)
    expect(screen.getByText('REQUIRED')).toBeInTheDocument()
    expect(screen.getByText('Enable Microphone')).toBeInTheDocument()
  })

  it('does not show Continue until permission granted', () => {
    render(<MicPermissionStep onNext={vi.fn()} />)
    expect(screen.queryByText('Continue →')).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Implement MicPermissionStep**

Replace `src/renderer/src/components/onboarding/MicPermissionStep.tsx`:

```tsx
import { useState, useEffect, useCallback } from 'react'

export function MicPermissionStep({ onNext }: { onNext: () => void }) {
  const [granted, setGranted] = useState(false)

  const checkPermission = useCallback(async () => {
    const perms = await window.electronAPI.invoke('permissions:check')
    if (perms.microphone) setGranted(true)
  }, [])

  useEffect(() => {
    checkPermission()
    const handleFocus = () => checkPermission()
    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [checkPermission])

  const handleEnable = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach((t) => t.stop())
      await checkPermission()
    } catch {
      window.electronAPI.invoke('permissions:open-settings', 'microphone')
    }
  }

  return (
    <div className="text-center">
      <span className="inline-block px-2.5 py-1 bg-clay-light text-clay-dark rounded-md text-[11px] font-semibold uppercase tracking-wider mb-4">
        REQUIRED
      </span>
      <div className="w-16 h-16 rounded-2xl bg-clay-light flex items-center justify-center text-[28px] mx-auto mb-5">
        🎤
      </div>
      <h2 className="text-[20px] font-bold text-ink tracking-[-0.02em] mb-2">Microphone Access</h2>
      <p className="text-[14px] text-ink-muted leading-relaxed mb-7">
        AutoDoc needs your microphone to capture meeting audio. This is the core of how transcription works — without it, we can't hear your meetings.
      </p>

      {granted ? (
        <button
          onClick={onNext}
          className="px-8 py-3 bg-sage text-white rounded-[10px] text-[14px] font-semibold hover:opacity-90 transition-opacity"
        >
          Continue →
        </button>
      ) : (
        <button
          onClick={handleEnable}
          className="px-8 py-3 bg-sage text-white rounded-[10px] text-[14px] font-semibold hover:opacity-90 transition-opacity"
        >
          Enable Microphone
        </button>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Implement ScreenPermissionStep**

Replace `src/renderer/src/components/onboarding/ScreenPermissionStep.tsx`:

```tsx
import { useState, useEffect, useCallback } from 'react'

export function ScreenPermissionStep({ onNext }: { onNext: () => void }) {
  const [granted, setGranted] = useState(false)

  const checkPermission = useCallback(async () => {
    const perms = await window.electronAPI.invoke('permissions:check')
    if (perms.screen) setGranted(true)
  }, [])

  useEffect(() => {
    checkPermission()
    const handleFocus = () => checkPermission()
    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [checkPermission])

  return (
    <div className="text-center">
      <span className="inline-block px-2.5 py-1 bg-mist-light text-ink-muted rounded-md text-[11px] font-semibold uppercase tracking-wider mb-4">
        OPTIONAL
      </span>
      <div className="w-16 h-16 rounded-2xl bg-mist-light flex items-center justify-center text-[28px] mx-auto mb-5">
        🖥️
      </div>
      <h2 className="text-[20px] font-bold text-ink tracking-[-0.02em] mb-2">Screen Recording</h2>
      <p className="text-[14px] text-ink-muted leading-relaxed mb-7">
        AutoDoc detects your meeting window to capture screen shares and visuals. You can always enable this later in System Settings.
      </p>

      {granted ? (
        <button
          onClick={onNext}
          className="px-8 py-3 bg-sage text-white rounded-[10px] text-[14px] font-semibold hover:opacity-90 transition-opacity"
        >
          Continue →
        </button>
      ) : (
        <>
          <button
            onClick={() => window.electronAPI.invoke('permissions:open-settings', 'screen')}
            className="px-8 py-3 bg-ink text-white rounded-[10px] text-[14px] font-semibold hover:bg-ink-secondary transition-colors"
          >
            Enable Screen Recording
          </button>
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

- [ ] **Step 4: Implement CalendarStep**

Replace `src/renderer/src/components/onboarding/CalendarStep.tsx`:

```tsx
import { useState } from 'react'

export function CalendarStep({ onNext }: { onNext: () => void }) {
  const [connecting, setConnecting] = useState(false)
  const [connected, setConnected] = useState(false)

  const handleConnect = async () => {
    setConnecting(true)
    try {
      await window.electronAPI.invoke('calendar:connect')
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
      <h2 className="text-[20px] font-bold text-ink tracking-[-0.02em] mb-2">Google Calendar</h2>
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
          <button
            onClick={handleConnect}
            disabled={connecting}
            className="px-8 py-3 bg-ink text-white rounded-[10px] text-[14px] font-semibold hover:bg-ink-secondary transition-colors disabled:opacity-50"
          >
            {connecting ? 'Connecting...' : 'Connect Google Calendar'}
          </button>
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

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/renderer/src/components/onboarding/__tests__/MicPermissionStep.test.tsx && npx vitest run src/renderer/src/pages/__tests__/Onboarding.test.tsx`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/onboarding/
git commit -m "feat(onboarding): implement mic, screen recording, and calendar permission steps"
```

---

### Task 6: Ollama Step & All Set Step

**Files:**
- Modify: `src/renderer/src/components/onboarding/OllamaStep.tsx`
- Modify: `src/renderer/src/components/onboarding/AllSetStep.tsx`
- Create: `src/renderer/src/components/onboarding/__tests__/OllamaStep.test.tsx`

- [ ] **Step 1: Write the OllamaStep test**

Create `src/renderer/src/components/onboarding/__tests__/OllamaStep.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { OllamaStep } from '../OllamaStep'

describe('OllamaStep', () => {
  it('renders AI setup heading', () => {
    vi.mocked(window.electronAPI.invoke).mockResolvedValue({ phase: 'downloading', percent: 42 })
    render(<OllamaStep onNext={vi.fn()} />)
    expect(screen.getByText('Setting Up AI')).toBeInTheDocument()
  })

  it('auto-advances when already ready', async () => {
    const onNext = vi.fn()
    vi.mocked(window.electronAPI.invoke).mockResolvedValue({ phase: 'ready', percent: 100 })
    render(<OllamaStep onNext={onNext} />)
    await act(() => Promise.resolve())
    expect(onNext).toHaveBeenCalled()
  })

  it('shows skip link after 5 seconds', () => {
    vi.useFakeTimers()
    vi.mocked(window.electronAPI.invoke).mockResolvedValue({ phase: 'downloading', percent: 10 })
    render(<OllamaStep onNext={vi.fn()} />)
    expect(screen.queryByText(/continue/i)).not.toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(5000) })
    expect(screen.getByText(/continue/i)).toBeInTheDocument()
    vi.useRealTimers()
  })
})
```

- [ ] **Step 2: Implement OllamaStep**

Replace `src/renderer/src/components/onboarding/OllamaStep.tsx`:

```tsx
import { useState, useEffect } from 'react'

export function OllamaStep({ onNext }: { onNext: () => void }) {
  const [phase, setPhase] = useState<string>('downloading')
  const [percent, setPercent] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [showSkip, setShowSkip] = useState(false)

  useEffect(() => {
    // Check initial status
    window.electronAPI.invoke('ollama:get-setup-status').then((status) => {
      setPhase(status.phase)
      setPercent(status.percent)
      if (status.phase === 'ready') onNext()
      if (status.phase === 'error') setError(status.error ?? 'Unknown error')
    })

    // Listen for progress updates
    const unsub = window.electronAPI.on('ollama:setup-progress', (status) => {
      setPhase(status.phase)
      setPercent(status.percent)
      if (status.phase === 'ready') onNext()
      if (status.phase === 'error') setError(status.error ?? 'Unknown error')
    })

    return unsub
  }, [onNext])

  useEffect(() => {
    const timer = setTimeout(() => setShowSkip(true), 5000)
    return () => clearTimeout(timer)
  }, [])

  const statusLabel = phase === 'downloading'
    ? `Downloading AI model... ${percent}%`
    : phase === 'pulling'
      ? `Installing model... ${percent}%`
      : error
        ? `Setup failed: ${error}`
        : 'Ready'

  return (
    <div className="text-center">
      <div className="w-16 h-16 rounded-2xl bg-dusk-light flex items-center justify-center text-[28px] mx-auto mb-5">
        🤖
      </div>
      <h2 className="text-[20px] font-bold text-ink tracking-[-0.02em] mb-2">Setting Up AI</h2>
      <p className="text-[14px] text-ink-muted leading-relaxed mb-7">
        AutoDoc uses a local AI model to analyze your transcripts and generate smart notes. This downloads once and runs entirely on your machine.
      </p>

      {/* Progress bar */}
      <div className="w-60 h-1 bg-border rounded-full mx-auto mb-2 overflow-hidden">
        <div
          className="h-full bg-sage rounded-full transition-all duration-300"
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="text-[12px] text-ink-faint mb-5">{statusLabel}</div>

      {error && (
        <button
          onClick={async () => {
            setError(null)
            setPhase('downloading')
            setPercent(0)
            await window.electronAPI.invoke('ollama:retry-setup')
          }}
          className="px-6 py-2.5 bg-ink text-white rounded-[10px] text-[14px] font-semibold hover:bg-ink-secondary transition-colors"
        >
          Retry
        </button>
      )}

      {showSkip && !error && (
        <button
          onClick={onNext}
          className="text-[13px] text-ink-faint hover:text-ink-muted transition-colors"
        >
          Continue — this will finish in the background
        </button>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Implement AllSetStep**

Replace `src/renderer/src/components/onboarding/AllSetStep.tsx`:

```tsx
export function AllSetStep({ onFinish }: { onFinish: () => void }) {
  return (
    <div className="text-center">
      {/* Green check circle */}
      <div className="w-16 h-16 rounded-full bg-sage-light flex items-center justify-center mx-auto mb-5">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#4A6B4E" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </div>
      <h2 className="text-[20px] font-bold text-ink tracking-[-0.02em] mb-2">You're All Set</h2>
      <p className="text-[14px] text-ink-muted leading-relaxed mb-7">
        AutoDoc is ready to go. Start or join a meeting and we'll take it from here.
      </p>
      <button
        onClick={onFinish}
        className="px-8 py-3 bg-sage text-white rounded-[10px] text-[14px] font-semibold hover:opacity-90 transition-opacity"
      >
        Open AutoDoc
      </button>
    </div>
  )
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/renderer/src/components/onboarding/__tests__/OllamaStep.test.tsx && npx vitest run src/renderer/src/pages/__tests__/Onboarding.test.tsx`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/onboarding/
git commit -m "feat(onboarding): implement Ollama progress step and All Set completion screen"
```

---

### Task 7: Wire App.tsx Gate & Remove SetupGuide

**Files:**
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/pages/Upcoming.tsx`
- Delete: `src/renderer/src/components/SetupGuide.tsx`
- Modify: `src/renderer/src/pages/MeetingDetail.test.tsx` (if affected)

- [ ] **Step 1: Modify App.tsx to add onboarding gate**

In `src/renderer/src/App.tsx`, add the gate. The key change: wrap the entire existing return in a conditional. Import `Onboarding` and add state:

```tsx
import { useEffect, useState } from 'react'
import { Onboarding } from './pages/Onboarding'
// ... other existing imports

export default function App() {
  const [onboardingDone, setOnboardingDone] = useState<boolean | null>(null)
  const { isRecording, sourceName, elapsedSeconds, handleStop, fetchSources, handleStart } = useRecording()

  useEffect(() => {
    window.electronAPI.invoke('prefs:get-onboarding-complete').then(setOnboardingDone)
  }, [])

  // ... keep existing auto-record useEffect

  if (onboardingDone === null) return null

  if (!onboardingDone) {
    return <Onboarding onComplete={() => setOnboardingDone(true)} />
  }

  return (
    <HashRouter>
      {/* ... existing app shell unchanged ... */}
    </HashRouter>
  )
}
```

- [ ] **Step 2: Remove SetupGuide from Upcoming.tsx**

In `src/renderer/src/pages/Upcoming.tsx`:
- Remove the `import { SetupGuide }` line
- Remove the `setupComplete` state and its `useEffect`
- Remove the `if (setupComplete === false) return <SetupGuide ...>` conditional
- The page should now always render its normal content

- [ ] **Step 3: Delete SetupGuide.tsx**

Delete `src/renderer/src/components/SetupGuide.tsx`.

- [ ] **Step 4: Add PermissionToast to App.tsx main shell**

Inside the main app return (the HashRouter branch), add `<PermissionToast />` inside `<main>`, after `<MeetingDetectedBanner />`:

```tsx
import { PermissionToast } from './components/PermissionToast'

// Inside the main shell:
<main className="flex-1 overflow-hidden flex flex-col pt-[52px]">
  <RecordingBanner ... />
  <MeetingDetectedBanner />
  <PermissionToast />
  <div className="flex-1 overflow-hidden">
    <Routes>...</Routes>
  </div>
</main>
```

- [ ] **Step 5: Run all tests**

Run: `npx vitest run && npx vitest run --config vitest.main.config.mts`
Expected: All pass. If any test imports `SetupGuide`, update or remove that test.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/App.tsx src/renderer/src/pages/Upcoming.tsx src/renderer/src/components/PermissionToast.tsx
git rm src/renderer/src/components/SetupGuide.tsx
git commit -m "feat(onboarding): wire onboarding gate in App.tsx, remove SetupGuide"
```

---

### Task 8: Toast Triggers in Recording Capture

**Files:**
- Modify: `src/renderer/src/services/recording-capture.ts`
- Modify: `src/renderer/src/pages/Upcoming.tsx`

- [ ] **Step 1: Add toast triggers to recording-capture.ts**

In `src/renderer/src/services/recording-capture.ts`, import the toast store:

```typescript
import { useToastStore } from '../stores/toast'
```

After the `videoStream` capture (around line 21-30), check screen recording permission. Note: on macOS, Electron's desktop capturer returns valid tracks even when permission is denied (they're just black frames), so checking `getVideoTracks().length` is unreliable. Instead, use the existing `permissions:check` IPC:

```typescript
// After getting videoStream — check actual permission status
const perms = await window.electronAPI.invoke('permissions:check')
if (!perms.screen) {
  useToastStore.getState().showToast({
    type: 'screen',
    message: 'Screen recording lets AutoDoc capture meeting visuals. Enable it in System Settings → Privacy → Screen Recording.',
  })
}
```

After the `micStream` capture (around line 56-61), in the catch block and after checking tracks:

```typescript
let micStream: MediaStream | null = null
try {
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
  })
  if (micStream.getAudioTracks().length === 0) {
    micStream = null
  }
} catch {
  // Mic permission revoked or unavailable
}

if (!micStream) {
  useToastStore.getState().showToast({
    type: 'microphone',
    message: 'Microphone access was revoked. AutoDoc needs it to record meetings. Enable it in System Settings → Privacy → Microphone.',
  })
}
```

Note: The mic toast should not prevent recording — the recording can still proceed with system audio only. It's informational.

- [ ] **Step 2: Add calendar toast in Upcoming.tsx**

In `src/renderer/src/pages/Upcoming.tsx`, after the calendar connection check, add a one-time session toast. Only show it if the user completed onboarding (which means they skipped calendar during it, since connected users won't hit this path). Use a module-level flag to ensure it shows at most once per app session:

```typescript
import { useToastStore } from '../stores/toast'

let calendarToastShown = false

// Inside the component, after the existing useEffect that checks calendar connection:
useEffect(() => {
  if (!isConnected && !calendarToastShown) {
    // Only show once per session. Users who connected during onboarding
    // will have isConnected=true and won't reach this branch.
    // Users who haven't completed onboarding yet will see the onboarding
    // calendar step instead of this toast.
    calendarToastShown = true
    useToastStore.getState().showToast({
      type: 'calendar',
      message: 'Connect Google Calendar to see upcoming meetings and auto-name recordings.',
    })
  }
}, [isConnected])
```

- [ ] **Step 3: Run all tests**

Run: `npx vitest run && npx vitest run --config vitest.main.config.mts`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/services/recording-capture.ts src/renderer/src/pages/Upcoming.tsx
git commit -m "feat(onboarding): add permission toast triggers for screen, mic, and calendar"
```

---

### Task 9: Update `recording:get-media` Return Type

The return type of `recording:get-media` was changed earlier in this session to include `audioFile`. Update the type definition to match.

**Files:**
- Modify: `src/preload/ipc.d.ts`

- [ ] **Step 1: Update the return type**

In `src/preload/ipc.d.ts`, change:

```typescript
'recording:get-media': { hasVideo: boolean; hasAudio: boolean }
```

To:

```typescript
'recording:get-media': { hasVideo: boolean; hasAudio: boolean; audioFile?: string }
```

- [ ] **Step 2: Run all tests**

Run: `npx vitest run && npx vitest run --config vitest.main.config.mts`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add src/preload/ipc.d.ts
git commit -m "fix: update recording:get-media return type to include audioFile"
```

---

### Task 10: Final Integration Test & Cleanup

**Files:**
- All previously created/modified files

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run && npx vitest run --config vitest.main.config.mts`
Expected: All pass — both renderer (57+ tests) and main (49+ tests)

- [ ] **Step 2: Manual smoke test**

Run: `npm run dev`

Verify:
1. App shows onboarding wizard on first launch (or after clearing `autodoc-prefs.json`)
2. Welcome screen shows waveform animation and tagline
3. Feature screens (Private, How It Works, Notes) navigate with Next →
4. Mic step blocks until permission granted
5. Screen Recording step has Skip option
6. Calendar step has Skip option and Connect button
7. AI Setup shows Ollama progress (or skip link after 5s)
8. All Set screen → "Open AutoDoc" → enters main app
9. Subsequent launches skip onboarding
10. Toast appears when starting a recording without screen permission

- [ ] **Step 3: Final commit if any cleanup needed**

```bash
git add -A
git commit -m "feat(onboarding): final integration cleanup"
```
