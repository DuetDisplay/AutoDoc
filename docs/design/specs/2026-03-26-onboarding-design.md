# Onboarding Flow Design Spec

**Goal:** Create a beautiful, multi-step onboarding wizard that introduces AutoDoc's features, helps users grant permissions (required and optional), and provides contextual toast banners when users later try features that need un-granted optional permissions.

**Architecture:** A fullscreen centered wizard (rendered as a gate in `App.tsx`, not a route) that replaces the current `SetupGuide` component. Persists completion state via electron-store. Toast system for missing-permission prompts integrated into the main app shell.

**Tech Stack:** React, Tailwind CSS (existing theme tokens), electron-store for persistence, existing IPC channels for permissions/calendar/ollama.

---

## Screens

The wizard has 8 interactive screens plus a final "All Set" screen (9 total). The step indicator shows 8 dots (screens 1-8). Screen 9 ("All Set") has no dots — it's a brief transition before entering the app.

### Screen 1: Welcome

Centered layout. Animated waveform (7 vertical bars with staggered CSS `scaleY` animation in sage green). Below the waveform, the "AutoDoc" wordmark in `font-serif` at ~36px. Creative tagline: **"Your meetings talk. We listen. So you don't have to take notes."** in `text-ink-muted`. A "Get Started →" button in `bg-ink text-white`.

Step indicator: 8 dots at top of screen. First dot active (`bg-ink`, wider pill shape), rest inactive (`bg-border`).

### Screen 2: Private by Design

Icon: lock emoji in `bg-sage-light` rounded square. Heading: **"Private by Design"**. Body text explaining: fully open source, runs entirely on your machine, recordings encrypted on disk with AES-256, never leaves your computer, no cloud, no accounts, no compromises. Mention: **"Built by ex-Apple engineers who believe your data is yours."**

"Next →" ghost button (border, no fill).

### Screen 3: How It Works

Icon: headphones emoji in `bg-dusk-light`. Heading: **"How It Works"**. Brief intro sentence. Then 3 feature rows (white cards with rounded corners):

1. **Captures audio** — "Records mic and system audio separately for clean speaker identification"
2. **Transcribes locally** — "whisper.cpp runs on-device — fast, private, no internet needed"
3. **Identifies speakers** — "Knows who's talking — labels 'Me' vs 'Them' automatically"

"Next →" ghost button.

### Screen 4: Notes That Think

Icon: clipboard emoji in `bg-clay-light`. Heading: **"Notes That Think"**. Body: "Inspired by Andy Grove's *High Output Management*, AutoDoc breaks every meeting into the patterns that matter — fully editable by you." Then 3 feature rows:

1. **Decisions** — "What was decided and why"
2. **Action Items** — "Who does what, by when"
3. **Discussion & Status** — "Key points, updates, and context"

"Next →" ghost button.

### Screen 5: Microphone (Required)

Badge: `bg-clay-light text-clay-dark` uppercase "REQUIRED". Icon: mic emoji in `bg-clay-light`. Heading: **"Microphone Access"**. Body: "AutoDoc needs your microphone to capture meeting audio. This is the core of how transcription works — without it, we can't hear your meetings."

Primary CTA: **"Enable Microphone"** button in `bg-sage text-white`. On click:
1. Call `navigator.mediaDevices.getUserMedia({ audio: true })` to trigger the OS prompt
2. If that fails (already denied), call `permissions:open-settings` IPC with argument `'microphone'` to open System Preferences
3. Re-check on window focus (same pattern as existing `SetupGuide`)

**Blocks proceeding.** The "Next" button only appears once mic permission is granted (dot turns sage green, button text changes to "Continue →"). No skip option.

### Screen 6: Screen Recording (Optional)

Badge: `bg-mist-light text-ink-muted` uppercase "OPTIONAL". Icon: monitor emoji in `bg-mist-light`. Heading: **"Screen Recording"**. Body: "AutoDoc detects your meeting window to capture screen shares and visuals. You can always enable this later in System Settings."

Primary CTA: **"Enable Screen Recording"** in `bg-ink text-white`. On click: call `permissions:open-settings` IPC with argument `'screen'`.

Secondary: **"Skip for now"** text link in `text-ink-faint`.

Re-checks on window focus. If granted, auto-advances (or shows green check + "Continue →").

### Screen 7: Google Calendar (Optional)

Badge: `bg-mist-light text-ink-muted` uppercase "OPTIONAL". Icon: calendar emoji in `bg-sage-light`. Heading: **"Google Calendar"**. Body: "Connect your calendar to automatically name recordings after meetings and suggest speaker names from attendee lists."

Primary CTA: **"Connect Google Calendar"** in `bg-ink text-white`. On click: call `calendar:connect` IPC (same flow as existing `ConnectCalendar` component). Show "Connecting..." disabled state while the promise is pending. When the promise resolves, show green check + "Continue →".

Secondary: **"Skip for now"** text link.

### Screen 8: AI Setup (Ollama)

Icon: robot emoji in `bg-dusk-light`. Heading: **"Setting Up AI"**. Body: "AutoDoc uses a local AI model to analyze your transcripts and generate smart notes. This downloads once and runs entirely on your machine."

Below the text: a progress bar (4px tall, sage green fill, rounded) and a percentage/status label. This screen is non-interactive — it reflects the status of `OllamaManager` which is already running `startAndPull()` in the background since app startup.

**IPC additions needed:**

1. **`ollama:get-setup-status`** handler — returns `{ phase: 'downloading' | 'pulling' | 'ready' | 'error', percent: number, error?: string }`. Implemented by maintaining a mutable `ollamaSetupState` object in `index.ts` that is updated by subscribing to `OllamaManager`'s EventEmitter events (`download-start`, `download-progress`, `download-complete`, `pull-start`, `pull-progress`, `pull-complete`). The handler simply returns the current state.

2. **`ollama:setup-progress`** IPC event — broadcasts progress to the renderer. Implemented by forwarding `OllamaManager` EventEmitter events to the renderer via `win.webContents.send('ollama:setup-progress', ollamaSetupState)` in `index.ts`, inside the same EventEmitter subscribers that update the state object.

Behavior:
- If Ollama is already ready when this screen mounts (check via `ollama:get-setup-status`): auto-advance to "All Set"
- If downloading/pulling: show progress, update in real-time via `ollama:setup-progress` events
- After 5 seconds on this screen regardless of progress: show a **"Continue — this will finish in the background"** text link. Clicking this advances to the "All Set" screen (which then sets `onboardingComplete`).
- If error: show error message + "Retry" button

### Screen 9: All Set

No step dots. Green check circle (sage green background, dark sage checkmark SVG). Heading: **"You're All Set"**. Body: "AutoDoc is ready to go. Start or join a meeting and we'll take it from here."

CTA: **"Open AutoDoc"** in `bg-sage text-white`. On click: calls `prefs:set-onboarding-complete` IPC, then calls `onComplete` callback which transitions to the main app.

---

## Persistence

New electron-store instance: `autodoc-prefs` (file: `autodoc-prefs.json` in app userData).

Key: `onboardingComplete` (boolean). Checked on app launch.

**New IPC channels:**
- `prefs:get-onboarding-complete` → returns `boolean` (no arguments)
- `prefs:set-onboarding-complete` → no arguments, unconditionally sets `onboardingComplete` to `true`, returns `void`

---

## App.tsx Gate (not a route)

The onboarding renders as a gate *before* the `HashRouter` tree, not as a route within it. This prevents any flash of the main app shell.

```tsx
// Pseudocode
const [onboardingDone, setOnboardingDone] = useState<boolean | null>(null)

useEffect(() => {
  window.electronAPI.invoke('prefs:get-onboarding-complete').then(setOnboardingDone)
}, [])

// Loading — render nothing (bg-primary background from CSS prevents flash)
if (onboardingDone === null) return null

// Onboarding gate — fullscreen, no sidebar, no router
if (!onboardingDone) {
  return <Onboarding onComplete={() => setOnboardingDone(true)} />
}

// Main app — existing HashRouter shell
return (
  <HashRouter>
    <div className="flex h-screen bg-bg-primary relative">
      <Sidebar />
      <main>...</main>
    </div>
  </HashRouter>
)
```

The `<Onboarding>` component manages its own step state internally. The 52px top drag region is preserved for macOS traffic lights.

---

## Missing Permission Toasts

When a user tries a feature that requires an optional permission they haven't granted, show a toast banner.

### Toast Component

A `PermissionToast` component rendered at the top of the main content area (inside `<main>`, below the recording banner). Slides down with a CSS animation (`translateY(-12px)` → `0`). Contains:

- An icon (emoji matching the permission)
- A description text
- An "Enable" link (sage colored, calls `permissions:open-settings` with the relevant panel argument)
- A dismiss "×" button

Auto-dismisses after 8 seconds. Only one toast at a time.

### Toast State

A Zustand store: `useToastStore` with `{ activeToast: { type: 'screen' | 'microphone' | 'calendar', message: string } | null, showToast: (toast) => void, dismissToast: () => void }`.

### Trigger Points

1. **Microphone revoked post-onboarding:** When `startCapture()` in `recording-capture.ts` calls `getUserMedia({ audio: ... })` and it throws or returns no audio tracks, show toast: "Microphone access was revoked. AutoDoc needs it to record meetings. Enable it in System Settings → Privacy → Microphone." This covers the edge case where the user grants mic during onboarding but later revokes it.

2. **Screen recording missing:** When `startCapture()` begins, check screen recording permission via `permissions:check` IPC (returns `{ screen: boolean }`). If `!perms.screen`, show toast: "Screen recording lets AutoDoc capture meeting visuals. Enable it in System Settings → Privacy → Screen Recording." Note: Electron's desktop capturer returns valid tracks even when permission is denied (they're just black frames), so checking `getVideoTracks().length` is unreliable on macOS.

3. **Calendar not connected:** When the user lands on the Upcoming page and calendar is not connected, and they skipped calendar during onboarding (check via a session-level flag so it only shows once per app session), show toast: "Connect Google Calendar to see upcoming meetings and auto-name recordings."

---

## Removing SetupGuide

The existing `SetupGuide` component in `Upcoming.tsx` becomes redundant. Remove the `setupComplete` state and `SetupGuide` rendering from `Upcoming.tsx`. The `SetupGuide.tsx` component file can be deleted.

---

## Components

### New Files
- `src/renderer/src/pages/Onboarding.tsx` — the wizard shell (manages current step, transitions)
- `src/renderer/src/components/onboarding/WelcomeStep.tsx`
- `src/renderer/src/components/onboarding/FeatureStep.tsx` — reusable for screens 2-4 (accepts icon, title, body, feature rows)
- `src/renderer/src/components/onboarding/MicPermissionStep.tsx`
- `src/renderer/src/components/onboarding/ScreenPermissionStep.tsx`
- `src/renderer/src/components/onboarding/CalendarStep.tsx`
- `src/renderer/src/components/onboarding/OllamaStep.tsx`
- `src/renderer/src/components/onboarding/AllSetStep.tsx`
- `src/renderer/src/components/PermissionToast.tsx` — the toast banner
- `src/renderer/src/stores/toast.ts` — Zustand store for toast state
- `src/main/services/prefs-store.ts` — electron-store wrapper for `autodoc-prefs`
- `src/main/ipc/prefs-ipc.ts` — IPC handlers for prefs

### Modified Files
- `src/renderer/src/App.tsx` — add onboarding gate (wraps HashRouter)
- `src/main/index.ts` — register prefs IPC, add `ollamaSetupState` tracking + `ollama:setup-progress` forwarding
- `src/main/ipc/llm-ipc.ts` — add `ollama:get-setup-status` handler
- `src/preload/ipc.d.ts` — add new IPC type definitions for prefs and ollama setup
- `src/renderer/src/pages/Upcoming.tsx` — remove SetupGuide usage
- `src/renderer/src/services/recording-capture.ts` — add toast triggers for missing screen/mic permissions

### Deleted Files
- `src/renderer/src/components/SetupGuide.tsx` — replaced by onboarding

---

## Animation & Transitions

- **Waveform** (Welcome screen): 7 vertical bars, `3px` wide, sage green, staggered `scaleY` animation with `ease-in-out`, 1.2s cycle
- **Screen transitions**: `fadeUp` animation — `opacity: 0, translateY(16px)` → `opacity: 1, translateY(0)`, 400ms ease
- **Step dots**: smooth `width` transition on the active dot (6px circle → 18px pill), `background-color` transition for completed dots
- **Permission granted**: dot transitions to sage green, brief scale pulse
- **Toast**: slides down from top, `translateY(-12px)` → `0`, 300ms ease

---

## Visual Reference

See mockup at `.superpowers/brainstorm/10769-1774520146/onboarding-flow.html` — interactive prototype with all 8 screens plus toast example.
