# Recording Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture meeting window video + system audio + microphone audio, mix audio streams, and save recordings to disk.

**Architecture:** RecordingService in main process coordinates capture. Renderer handles MediaRecorder + AudioContext mixing (since getUserMedia/desktopCapturer must run in renderer context). Main process manages file I/O and state. IPC bridges the two. Window detection matches desktopCapturer sources against known meeting app patterns and auto-selects the best match.

**Tech Stack:** Electron desktopCapturer, MediaRecorder API (native), AudioContext for audio mixing, Node crypto.randomUUID() for IDs.

**Note on audio format:** Audio is saved as `audio.webm` (WebM/Opus format). WAV conversion for Whisper will happen in sub-project 4 (Transcription Pipeline) as a post-processing step.

---

## File Structure

```
src/
  shared/
    types.ts                          # Modify: add RecordingState, RecordingSource, RecordingPaths types
    constants.ts                      # Modify: add RECORDING_DIR, MEETING_APP_PATTERNS
  main/
    services/recording.ts             # Create: RecordingService (state management, file I/O)
    ipc/recording-ipc.ts              # Create: IPC handler registration for recording channels
    index.ts                          # Modify: initialize RecordingService, register IPC
  preload/
    ipc.d.ts                          # Modify: full replacement with recording IPC channel types added
  renderer/src/
    services/recording-capture.ts     # Create: MediaRecorder + AudioContext mixing logic (no unit test — browser APIs)
    services/window-detection.ts      # Create: Match sources against meeting app patterns
    stores/recording.ts               # Create: Zustand store for recording state
    hooks/useRecording.ts             # Create: Recording orchestration hook (timer, IPC, capture)
    components/RecordingControls.tsx   # Create: Start/stop recording UI, source picker with auto-detect
    components/RecordingBanner.tsx     # Create: Active recording banner with timer
    pages/Upcoming.tsx                 # Modify: add recording trigger from event cards
    components/Sidebar.tsx             # Modify: wire recording timer to real recording store
    components/EventCard.tsx           # Modify: add "Record" button
```

---

### Task 1: Add Recording Types and Constants

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/shared/constants.ts`

- [ ] **Step 1: Add recording types to types.ts**

```typescript
// Add after OAuthTokens interface in src/shared/types.ts

export interface RecordingSource {
  id: string
  name: string
  thumbnailDataUrl: string
}

export interface RecordingState {
  isRecording: boolean
  meetingId: string | null
  startedAt: number | null
  sourceId: string | null
  sourceName: string | null
}

export interface RecordingPaths {
  meetingId: string
  dir: string
  video: string
  audio: string
}
```

- [ ] **Step 2: Add recording constants to constants.ts**

```typescript
// Add to src/shared/constants.ts

export const RECORDING_DIR_NAME = 'AutoDoc'
export const RECORDING_SUBDIR = 'recordings'

export const MEETING_APP_PATTERNS = [
  { name: 'Zoom', pattern: /zoom/i },
  { name: 'Google Meet', pattern: /meet\.google\.com/i },
  { name: 'Microsoft Teams', pattern: /microsoft teams/i },
  { name: 'Webex', pattern: /webex/i },
  { name: 'Slack Huddle', pattern: /slack.*huddle|slack.*call/i },
]

export const VIDEO_MIME_TYPE = 'video/webm;codecs=vp9'
export const AUDIO_MIME_TYPE = 'audio/webm;codecs=opus'
```

- [ ] **Step 3: Commit**

```bash
git add src/shared/types.ts src/shared/constants.ts
git commit -m "feat(recording): add recording types and constants"
```

---

### Task 2: Create RecordingService (Main Process)

**Files:**
- Create: `src/main/services/recording.ts`
- Create: `src/main/services/__tests__/recording.test.ts`
- Create: `vitest.main.config.mts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/main/services/__tests__/recording.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RecordingService } from '../recording'

// Mock electron
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/home'),
  },
}))

// Mock fs/promises
vi.mock('fs/promises', () => ({
  mkdir: vi.fn(),
}))

// Mock crypto
vi.mock('crypto', () => ({
  randomUUID: vi.fn(() => 'test-uuid-1234'),
}))

describe('RecordingService', () => {
  let service: RecordingService

  beforeEach(() => {
    service = new RecordingService()
  })

  it('starts with idle state', () => {
    const state = service.getState()
    expect(state.isRecording).toBe(false)
    expect(state.meetingId).toBeNull()
    expect(state.startedAt).toBeNull()
  })

  it('transitions to recording state on start', async () => {
    const paths = await service.startRecording('source-123', 'Zoom Meeting')
    const state = service.getState()

    expect(state.isRecording).toBe(true)
    expect(state.meetingId).toBe('test-uuid-1234')
    expect(state.sourceId).toBe('source-123')
    expect(state.sourceName).toBe('Zoom Meeting')
    expect(paths.meetingId).toBe('test-uuid-1234')
    expect(paths.video).toContain('test-uuid-1234')
    expect(paths.video).toContain('screen.webm')
    expect(paths.audio).toContain('audio.webm')
  })

  it('transitions back to idle on stop', async () => {
    await service.startRecording('source-123', 'Zoom Meeting')
    const result = service.stopRecording()

    expect(result.meetingId).toBe('test-uuid-1234')
    expect(service.getState().isRecording).toBe(false)
    expect(service.getState().meetingId).toBeNull()
  })

  it('throws if starting while already recording', async () => {
    await service.startRecording('source-123', 'Zoom Meeting')
    await expect(service.startRecording('source-456', 'Teams'))
      .rejects.toThrow('Already recording')
  })

  it('throws if stopping when not recording', () => {
    expect(() => service.stopRecording()).toThrow('Not recording')
  })
})
```

- [ ] **Step 2: Create vitest config for main process tests**

```typescript
// vitest.main.config.mts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    include: ['src/main/**/*.{test,spec}.{ts,tsx}'],
    passWithNoTests: true,
  },
})
```

Add script to `package.json`:

```json
"test:main": "vitest --config vitest.main.config.mts",
"test:main:run": "vitest run --config vitest.main.config.mts"
```

Note: No `resolve.alias` needed — `vi.mock('electron', ...)` in each test file handles mocking inline.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run --config vitest.main.config.mts src/main/services/__tests__/recording.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Write RecordingService implementation**

```typescript
// src/main/services/recording.ts
import { app } from 'electron'
import { mkdir } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { RecordingState, RecordingPaths } from '../../shared/types'
import { RECORDING_DIR_NAME, RECORDING_SUBDIR } from '../../shared/constants'

export class RecordingService {
  private state: RecordingState = {
    isRecording: false,
    meetingId: null,
    startedAt: null,
    sourceId: null,
    sourceName: null,
  }

  getState(): RecordingState {
    return { ...this.state }
  }

  async startRecording(sourceId: string, sourceName: string): Promise<RecordingPaths> {
    if (this.state.isRecording) {
      throw new Error('Already recording')
    }

    const meetingId = randomUUID()
    const dir = this.getMeetingDir(meetingId)
    await mkdir(dir, { recursive: true })

    this.state = {
      isRecording: true,
      meetingId,
      startedAt: Date.now(),
      sourceId,
      sourceName,
    }

    return {
      meetingId,
      dir,
      video: join(dir, 'screen.webm'),
      audio: join(dir, 'audio.webm'),
    }
  }

  stopRecording(): { meetingId: string; startedAt: number } {
    if (!this.state.isRecording || !this.state.meetingId || !this.state.startedAt) {
      throw new Error('Not recording')
    }

    const { meetingId, startedAt } = this.state

    this.state = {
      isRecording: false,
      meetingId: null,
      startedAt: null,
      sourceId: null,
      sourceName: null,
    }

    return { meetingId, startedAt }
  }

  getRecordingsBaseDir(): string {
    return join(app.getPath('home'), RECORDING_DIR_NAME, RECORDING_SUBDIR)
  }

  private getMeetingDir(meetingId: string): string {
    return join(this.getRecordingsBaseDir(), meetingId)
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run --config vitest.main.config.mts`
Expected: PASS (5 tests)

- [ ] **Step 6: Commit**

```bash
git add src/main/services/recording.ts src/main/services/__tests__/ vitest.main.config.mts package.json
git commit -m "feat(recording): add RecordingService with state management and file paths"
```

---

### Task 3: Add Recording IPC Channels

**Files:**
- Modify: `src/preload/ipc.d.ts` (full replacement)
- Create: `src/main/ipc/recording-ipc.ts`
- Modify: `src/main/index.ts`

- [ ] **Step 1: Replace ipc.d.ts with recording channels added**

This is a **full replacement** of `src/preload/ipc.d.ts`:

```typescript
import type { CalendarEvent, RecordingSource, RecordingState, RecordingPaths } from '../shared/types'

export interface IpcSendEvents {
  'window:minimize': []
  'window:maximize': []
  'window:close': []
}

export interface IpcInvokeEvents {
  'app:get-version': []
  'calendar:connect': []
  'calendar:disconnect': []
  'calendar:is-connected': []
  'calendar:get-events': []
  'calendar:sync': []
  'calendar:set-auto-record': [eventId: string, autoRecord: boolean]
  'recording:get-sources': []
  'recording:start': [sourceId: string, sourceName: string]
  'recording:stop': []
  'recording:get-state': []
  'recording:save-chunk': [meetingId: string, type: 'video' | 'audio', chunk: ArrayBuffer]
}

export interface IpcInvokeReturns {
  'app:get-version': string
  'calendar:connect': void
  'calendar:disconnect': void
  'calendar:is-connected': boolean
  'calendar:get-events': CalendarEvent[]
  'calendar:sync': CalendarEvent[]
  'calendar:set-auto-record': void
  'recording:get-sources': RecordingSource[]
  'recording:start': RecordingPaths
  'recording:stop': { meetingId: string; startedAt: number }
  'recording:get-state': RecordingState
  'recording:save-chunk': void
}

export interface IpcOnEvents {
  'recording:status-changed': [state: RecordingState]
  'calendar:events-updated': [events: CalendarEvent[]]
}
```

- [ ] **Step 2: Create recording-ipc.ts**

```typescript
// src/main/ipc/recording-ipc.ts
import { ipcMain, desktopCapturer, BrowserWindow } from 'electron'
import { appendFile } from 'fs/promises'
import { join } from 'path'
import { RecordingService } from '../services/recording'
import type { RecordingSource, RecordingState } from '../../shared/types'

export function registerRecordingIpc(recordingService: RecordingService): void {
  ipcMain.handle('recording:get-sources', async (): Promise<RecordingSource[]> => {
    const sources = await desktopCapturer.getSources({
      types: ['window', 'screen'],
      thumbnailSize: { width: 320, height: 180 },
    })

    return sources.map((source) => ({
      id: source.id,
      name: source.name,
      thumbnailDataUrl: source.thumbnail.toDataURL(),
    }))
  })

  ipcMain.handle('recording:start', async (_event, sourceId: string, sourceName: string) => {
    const paths = await recordingService.startRecording(sourceId, sourceName)
    broadcastState(recordingService.getState())
    return paths
  })

  ipcMain.handle('recording:stop', () => {
    const result = recordingService.stopRecording()
    broadcastState(recordingService.getState())
    return result
  })

  ipcMain.handle('recording:get-state', () => {
    return recordingService.getState()
  })

  ipcMain.handle(
    'recording:save-chunk',
    async (_event, meetingId: string, type: 'video' | 'audio', chunk: ArrayBuffer) => {
      const baseDir = recordingService.getRecordingsBaseDir()
      const filename = type === 'video' ? 'screen.webm' : 'audio.webm'
      const filePath = join(baseDir, meetingId, filename)
      await appendFile(filePath, Buffer.from(chunk))
    }
  )
}

function broadcastState(state: RecordingState): void {
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    win.webContents.send('recording:status-changed', state)
  }
}
```

- [ ] **Step 3: Register recording IPC in main/index.ts**

Add imports at top of `src/main/index.ts`:

```typescript
import { RecordingService } from './services/recording'
import { registerRecordingIpc } from './ipc/recording-ipc'
```

Add inside `app.whenReady()` after `registerCalendarIpc(calendarService)`:

```typescript
const recordingService = new RecordingService()
registerRecordingIpc(recordingService)
```

- [ ] **Step 4: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/preload/ipc.d.ts src/main/ipc/recording-ipc.ts src/main/index.ts
git commit -m "feat(recording): add recording IPC channels and handler registration"
```

---

### Task 4: Create Recording Zustand Store

**Files:**
- Create: `src/renderer/src/stores/recording.ts`
- Create: `src/renderer/src/stores/__tests__/recording.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/renderer/src/stores/__tests__/recording.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { useRecordingStore } from '../recording'

describe('useRecordingStore', () => {
  beforeEach(() => {
    useRecordingStore.setState({
      isRecording: false,
      meetingId: null,
      startedAt: null,
      sourceId: null,
      sourceName: null,
      elapsedSeconds: 0,
      sources: [],
      isLoadingSources: false,
    })
  })

  it('starts with idle state', () => {
    const state = useRecordingStore.getState()
    expect(state.isRecording).toBe(false)
    expect(state.meetingId).toBeNull()
    expect(state.sources).toEqual([])
  })

  it('updates recording state', () => {
    useRecordingStore.getState().setRecordingState({
      isRecording: true,
      meetingId: 'test-123',
      startedAt: Date.now(),
      sourceId: 'source-1',
      sourceName: 'Zoom',
    })

    const state = useRecordingStore.getState()
    expect(state.isRecording).toBe(true)
    expect(state.meetingId).toBe('test-123')
  })

  it('increments elapsed seconds', () => {
    useRecordingStore.getState().tick()
    expect(useRecordingStore.getState().elapsedSeconds).toBe(1)
    useRecordingStore.getState().tick()
    expect(useRecordingStore.getState().elapsedSeconds).toBe(2)
  })

  it('resets elapsed on new recording', () => {
    useRecordingStore.getState().tick()
    useRecordingStore.getState().tick()
    useRecordingStore.getState().setRecordingState({
      isRecording: true,
      meetingId: 'new',
      startedAt: Date.now(),
      sourceId: 's',
      sourceName: 'n',
    })
    expect(useRecordingStore.getState().elapsedSeconds).toBe(0)
  })

  it('sets sources', () => {
    useRecordingStore.getState().setSources([
      { id: 's1', name: 'Zoom', thumbnailDataUrl: 'data:...' },
    ])
    expect(useRecordingStore.getState().sources).toHaveLength(1)
    expect(useRecordingStore.getState().sources[0].name).toBe('Zoom')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/stores/__tests__/recording.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the recording store**

```typescript
// src/renderer/src/stores/recording.ts
import { create } from 'zustand'
import type { RecordingState, RecordingSource } from '../../../shared/types'

interface RecordingStore extends RecordingState {
  elapsedSeconds: number
  sources: RecordingSource[]
  isLoadingSources: boolean

  setRecordingState: (state: RecordingState) => void
  tick: () => void
  setSources: (sources: RecordingSource[]) => void
  setLoadingSources: (loading: boolean) => void
  reset: () => void
}

export const useRecordingStore = create<RecordingStore>((set) => ({
  isRecording: false,
  meetingId: null,
  startedAt: null,
  sourceId: null,
  sourceName: null,
  elapsedSeconds: 0,
  sources: [],
  isLoadingSources: false,

  setRecordingState: (state) =>
    set({
      ...state,
      elapsedSeconds: 0,
    }),

  tick: () => set((s) => ({ elapsedSeconds: s.elapsedSeconds + 1 })),

  setSources: (sources) => set({ sources }),
  setLoadingSources: (loading) => set({ isLoadingSources: loading }),

  reset: () =>
    set({
      isRecording: false,
      meetingId: null,
      startedAt: null,
      sourceId: null,
      sourceName: null,
      elapsedSeconds: 0,
    }),
}))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/stores/__tests__/recording.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/stores/recording.ts src/renderer/src/stores/__tests__/recording.test.ts
git commit -m "feat(recording): add recording Zustand store"
```

---

### Task 5: Create Window Detection Utility

**Files:**
- Create: `src/renderer/src/services/window-detection.ts`
- Create: `src/renderer/src/services/__tests__/window-detection.test.ts`

Matches desktopCapturer sources against known meeting app patterns and auto-selects the best match.

- [ ] **Step 1: Write the failing test**

```typescript
// src/renderer/src/services/__tests__/window-detection.test.ts
import { describe, it, expect } from 'vitest'
import { detectMeetingWindow } from '../window-detection'
import type { RecordingSource } from '../../../../shared/types'

describe('detectMeetingWindow', () => {
  const sources: RecordingSource[] = [
    { id: 'w:1', name: 'Zoom Meeting - Sprint Planning', thumbnailDataUrl: '' },
    { id: 'w:2', name: 'Visual Studio Code', thumbnailDataUrl: '' },
    { id: 'w:3', name: 'Google Chrome - meet.google.com/abc-defg-hij', thumbnailDataUrl: '' },
    { id: 's:0', name: 'Entire Screen', thumbnailDataUrl: '' },
  ]

  it('detects Zoom window', () => {
    const result = detectMeetingWindow(sources)
    expect(result).not.toBeNull()
    expect(result!.id).toBe('w:1')
  })

  it('detects Google Meet in browser', () => {
    const noZoom = sources.filter((s) => !s.name.includes('Zoom'))
    const result = detectMeetingWindow(noZoom)
    expect(result).not.toBeNull()
    expect(result!.id).toBe('w:3')
  })

  it('returns null when no meeting window found', () => {
    const noMeeting = [
      { id: 'w:2', name: 'Visual Studio Code', thumbnailDataUrl: '' },
      { id: 's:0', name: 'Entire Screen', thumbnailDataUrl: '' },
    ]
    const result = detectMeetingWindow(noMeeting)
    expect(result).toBeNull()
  })

  it('detects Teams window', () => {
    const teams: RecordingSource[] = [
      { id: 'w:5', name: 'Microsoft Teams - Meeting', thumbnailDataUrl: '' },
    ]
    const result = detectMeetingWindow(teams)
    expect(result).not.toBeNull()
    expect(result!.id).toBe('w:5')
  })

  it('ignores screen sources', () => {
    const screenOnly: RecordingSource[] = [
      { id: 'screen:0', name: 'Zoom Entire Screen', thumbnailDataUrl: '' },
    ]
    const result = detectMeetingWindow(screenOnly)
    expect(result).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/services/__tests__/window-detection.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write window detection utility**

```typescript
// src/renderer/src/services/window-detection.ts
import { MEETING_APP_PATTERNS } from '../../../shared/constants'
import type { RecordingSource } from '../../../shared/types'

export function detectMeetingWindow(sources: RecordingSource[]): RecordingSource | null {
  // Only check actual windows, not full-screen captures
  const windows = sources.filter((s) => !s.id.startsWith('screen:'))

  for (const { pattern } of MEETING_APP_PATTERNS) {
    const match = windows.find((s) => pattern.test(s.name))
    if (match) return match
  }

  return null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/services/__tests__/window-detection.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/services/window-detection.ts src/renderer/src/services/__tests__/window-detection.test.ts
git commit -m "feat(recording): add window detection utility for meeting apps"
```

---

### Task 6: Create Recording Capture Service (Renderer)

**Files:**
- Create: `src/renderer/src/services/recording-capture.ts`

This runs in the renderer because `getUserMedia` and `MediaRecorder` are browser APIs. No unit test — these APIs cannot be meaningfully mocked in jsdom. Tested via manual integration and the integration test in Task 12.

- [ ] **Step 1: Write the recording capture service**

```typescript
// src/renderer/src/services/recording-capture.ts
import type { RecordingPaths } from '../../../shared/types'

interface CaptureHandles {
  videoRecorder: MediaRecorder
  audioRecorder: MediaRecorder
  videoStream: MediaStream
  audioStream: MediaStream
  micStream: MediaStream | null
  audioContext: AudioContext | null
}

let activeCapture: CaptureHandles | null = null

export async function startCapture(
  sourceId: string,
  meetingId: string,
): Promise<void> {
  if (activeCapture) {
    throw new Error('Capture already active')
  }

  // 1. Capture window video (no audio — desktopCapturer can't get per-window audio)
  const videoStream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        maxFrameRate: 15,
      },
    } as MediaTrackConstraints,
  })

  // 2. Capture system audio (entire desktop audio)
  let audioStream: MediaStream
  try {
    audioStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'desktop',
        },
      } as MediaTrackConstraints,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          maxFrameRate: 1,
        },
      } as MediaTrackConstraints,
    })
    // Remove the video track — we only want audio from this stream
    audioStream.getVideoTracks().forEach((t) => t.stop())
  } catch {
    // System audio may not be available (especially macOS without loopback)
    audioStream = new MediaStream()
  }

  // 3. Capture microphone
  let micStream: MediaStream | null = null
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    })
  } catch {
    // Mic may not be available — continue without it
  }

  // 4. Mix audio streams via AudioContext
  let mixedAudioStream: MediaStream
  let audioContext: AudioContext | null = null

  const hasSystemAudio = audioStream.getAudioTracks().length > 0
  const hasMic = micStream !== null && micStream.getAudioTracks().length > 0

  if (hasSystemAudio && hasMic) {
    audioContext = new AudioContext({ sampleRate: 16000 })
    const destination = audioContext.createMediaStreamDestination()

    const systemSource = audioContext.createMediaStreamSource(audioStream)
    systemSource.connect(destination)

    const micSource = audioContext.createMediaStreamSource(micStream!)
    micSource.connect(destination)

    mixedAudioStream = destination.stream
  } else if (hasSystemAudio) {
    mixedAudioStream = audioStream
  } else if (hasMic) {
    mixedAudioStream = micStream!
  } else {
    mixedAudioStream = new MediaStream()
  }

  // 5. Set up video recorder (WebM)
  const videoRecorder = new MediaRecorder(videoStream, {
    mimeType: 'video/webm;codecs=vp9',
    videoBitsPerSecond: 1_500_000,
  })

  videoRecorder.ondataavailable = async (e) => {
    if (e.data.size > 0) {
      const buffer = await e.data.arrayBuffer()
      window.electronAPI.invoke('recording:save-chunk', meetingId, 'video', buffer)
    }
  }

  // 6. Set up audio recorder (WebM/Opus — converted to WAV in transcription sub-project)
  let audioRecorder: MediaRecorder
  if (mixedAudioStream.getAudioTracks().length > 0) {
    audioRecorder = new MediaRecorder(mixedAudioStream, {
      mimeType: 'audio/webm;codecs=opus',
    })
    audioRecorder.ondataavailable = async (e) => {
      if (e.data.size > 0) {
        const buffer = await e.data.arrayBuffer()
        window.electronAPI.invoke('recording:save-chunk', meetingId, 'audio', buffer)
      }
    }
  } else {
    audioRecorder = new MediaRecorder(new MediaStream())
  }

  // 7. Start recording — chunk every 5 seconds
  videoRecorder.start(5000)
  if (mixedAudioStream.getAudioTracks().length > 0) {
    audioRecorder.start(5000)
  }

  activeCapture = {
    videoRecorder,
    audioRecorder,
    videoStream,
    audioStream,
    micStream,
    audioContext,
  }
}

export function stopCapture(): void {
  if (!activeCapture) return

  const { videoRecorder, audioRecorder, videoStream, audioStream, micStream, audioContext } = activeCapture

  if (videoRecorder.state !== 'inactive') videoRecorder.stop()
  if (audioRecorder.state !== 'inactive') audioRecorder.stop()

  videoStream.getTracks().forEach((t) => t.stop())
  audioStream.getTracks().forEach((t) => t.stop())
  micStream?.getTracks().forEach((t) => t.stop())

  if (audioContext && audioContext.state !== 'closed') {
    audioContext.close()
  }

  activeCapture = null
}

export function isCapturing(): boolean {
  return activeCapture !== null
}
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/services/recording-capture.ts
git commit -m "feat(recording): add renderer-side capture service with audio mixing"
```

---

### Task 7: Create useRecording Hook

**Files:**
- Create: `src/renderer/src/hooks/useRecording.ts`

Extracted as a standalone hook so any page/component can access recording controls. Manages IPC subscription, timer, and start/stop orchestration. **Only this hook manages the timer** — the capture service does not.

- [ ] **Step 1: Write the hook**

```typescript
// src/renderer/src/hooks/useRecording.ts
import { useEffect, useCallback, useRef } from 'react'
import { useRecordingStore } from '../stores/recording'
import { startCapture, stopCapture } from '../services/recording-capture'
import { detectMeetingWindow } from '../services/window-detection'

export function useRecording() {
  const {
    isRecording,
    meetingId,
    sourceName,
    elapsedSeconds,
    sources,
    isLoadingSources,
    setRecordingState,
    tick,
    reset,
    setSources,
    setLoadingSources,
  } = useRecordingStore()

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Subscribe to recording state changes from main process
  useEffect(() => {
    const unsubscribe = window.electronAPI.on('recording:status-changed', (state) => {
      setRecordingState(state)
    })

    // Get initial state
    window.electronAPI.invoke('recording:get-state').then(setRecordingState)

    return unsubscribe
  }, [setRecordingState])

  // Timer management — single source of truth for elapsed time
  useEffect(() => {
    if (isRecording) {
      timerRef.current = setInterval(tick, 1000)
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [isRecording, tick])

  const fetchSources = useCallback(async () => {
    setLoadingSources(true)
    try {
      const fetchedSources = await window.electronAPI.invoke('recording:get-sources')
      setSources(fetchedSources)
      return fetchedSources
    } finally {
      setLoadingSources(false)
    }
  }, [setSources, setLoadingSources])

  const handleStart = useCallback(async (sourceId: string, sourceNameParam: string) => {
    const paths = await window.electronAPI.invoke('recording:start', sourceId, sourceNameParam)
    await startCapture(sourceId, paths.meetingId)
  }, [])

  const handleStop = useCallback(async () => {
    stopCapture()
    await window.electronAPI.invoke('recording:stop')
    reset()
  }, [reset])

  return {
    isRecording,
    meetingId,
    sourceName,
    elapsedSeconds,
    sources,
    isLoadingSources,
    fetchSources,
    handleStart,
    handleStop,
    detectMeetingWindow,
  }
}
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/hooks/useRecording.ts
git commit -m "feat(recording): add useRecording orchestration hook"
```

---

### Task 8: Create RecordingControls Component

**Files:**
- Create: `src/renderer/src/components/RecordingControls.tsx`
- Create: `src/renderer/src/components/__tests__/RecordingControls.test.tsx`

Shows a "Record" button that fetches sources, highlights auto-detected meeting window, and lets user pick. Shows "Stop Recording" during active recording.

- [ ] **Step 1: Write the failing test**

```typescript
// src/renderer/src/components/__tests__/RecordingControls.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RecordingControls } from '../RecordingControls'

const mockInvoke = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  window.electronAPI = {
    send: vi.fn(),
    invoke: mockInvoke,
    on: vi.fn(() => () => {}),
  } as any
})

describe('RecordingControls', () => {
  it('renders start recording button when not recording', () => {
    render(<RecordingControls isRecording={false} onStartRecording={() => {}} onStopRecording={() => {}} onFetchSources={async () => []} />)
    expect(screen.getByText('Record')).toBeInTheDocument()
  })

  it('renders stop button when recording', () => {
    render(<RecordingControls isRecording onStartRecording={() => {}} onStopRecording={() => {}} onFetchSources={async () => []} />)
    expect(screen.getByText('Stop Recording')).toBeInTheDocument()
  })

  it('shows source picker with auto-detected source highlighted when Record is clicked', async () => {
    const sources = [
      { id: 'window:1', name: 'Zoom Meeting', thumbnailDataUrl: 'data:image/png;base64,abc' },
      { id: 'window:2', name: 'Visual Studio Code', thumbnailDataUrl: 'data:image/png;base64,def' },
    ]
    const fetchSources = vi.fn(async () => sources)

    render(
      <RecordingControls
        isRecording={false}
        onStartRecording={() => {}}
        onStopRecording={() => {}}
        onFetchSources={fetchSources}
      />
    )
    await userEvent.click(screen.getByText('Record'))

    expect(fetchSources).toHaveBeenCalled()
    expect(await screen.findByText('Zoom Meeting')).toBeInTheDocument()
    expect(await screen.findByText('Visual Studio Code')).toBeInTheDocument()
  })

  it('calls onStartRecording when a source is selected', async () => {
    const onStart = vi.fn()
    const sources = [
      { id: 'window:1', name: 'Zoom Meeting', thumbnailDataUrl: 'data:image/png;base64,abc' },
    ]
    const fetchSources = vi.fn(async () => sources)

    render(
      <RecordingControls
        isRecording={false}
        onStartRecording={onStart}
        onStopRecording={() => {}}
        onFetchSources={fetchSources}
      />
    )
    await userEvent.click(screen.getByText('Record'))
    await userEvent.click(await screen.findByText('Zoom Meeting'))

    expect(onStart).toHaveBeenCalledWith('window:1', 'Zoom Meeting')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/components/__tests__/RecordingControls.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Write RecordingControls component**

```tsx
// src/renderer/src/components/RecordingControls.tsx
import { useState } from 'react'
import type { RecordingSource } from '../../../shared/types'
import { detectMeetingWindow } from '../services/window-detection'

interface RecordingControlsProps {
  isRecording: boolean
  onStartRecording: (sourceId: string, sourceName: string) => void
  onStopRecording: () => void
  onFetchSources: () => Promise<RecordingSource[]>
}

export function RecordingControls({
  isRecording,
  onStartRecording,
  onStopRecording,
  onFetchSources,
}: RecordingControlsProps) {
  const [showPicker, setShowPicker] = useState(false)
  const [sources, setSources] = useState<RecordingSource[]>([])
  const [detectedId, setDetectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const handleRecordClick = async () => {
    setLoading(true)
    try {
      const fetchedSources = await onFetchSources()
      setSources(fetchedSources)

      // Auto-detect meeting window
      const detected = detectMeetingWindow(fetchedSources)
      setDetectedId(detected?.id ?? null)

      setShowPicker(true)
    } finally {
      setLoading(false)
    }
  }

  const handleSourceSelect = (source: RecordingSource) => {
    setShowPicker(false)
    onStartRecording(source.id, source.name)
  }

  if (isRecording) {
    return (
      <button
        onClick={onStopRecording}
        className="text-[11px] font-medium text-white bg-status-recording px-3 py-1.5 rounded-md hover:opacity-90 transition-opacity"
      >
        Stop Recording
      </button>
    )
  }

  return (
    <div className="relative">
      <button
        onClick={handleRecordClick}
        disabled={loading}
        className="text-[11px] font-medium text-white bg-ink px-3 py-1.5 rounded-md hover:opacity-90 transition-opacity disabled:opacity-50"
      >
        {loading ? 'Loading...' : 'Record'}
      </button>

      {showPicker && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setShowPicker(false)}
          />
          <div className="absolute right-0 top-full mt-2 z-50 w-80 bg-bg-card border border-border rounded-xl shadow-lg p-3 max-h-96 overflow-y-auto">
            <p className="text-[11px] font-medium text-ink-muted mb-2">
              Select a window to record
            </p>
            <div className="flex flex-col gap-1.5">
              {sources.map((source) => (
                <button
                  key={source.id}
                  onClick={() => handleSourceSelect(source)}
                  className={`flex items-center gap-3 p-2 rounded-lg hover:bg-bg-accent transition-colors text-left ${
                    source.id === detectedId ? 'ring-2 ring-ink bg-bg-accent' : ''
                  }`}
                >
                  <img
                    src={source.thumbnailDataUrl}
                    alt={source.name}
                    className="w-20 h-12 object-cover rounded border border-border-subtle"
                  />
                  <div className="flex flex-col flex-1 min-w-0">
                    <span className="text-[12px] text-ink truncate">
                      {source.name}
                    </span>
                    {source.id === detectedId && (
                      <span className="text-[10px] text-status-connected font-medium">
                        Detected meeting
                      </span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/components/__tests__/RecordingControls.test.tsx`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/RecordingControls.tsx src/renderer/src/components/__tests__/RecordingControls.test.tsx
git commit -m "feat(recording): add RecordingControls component with source picker and auto-detect"
```

---

### Task 9: Create RecordingBanner Component

**Files:**
- Create: `src/renderer/src/components/RecordingBanner.tsx`
- Create: `src/renderer/src/components/__tests__/RecordingBanner.test.tsx`

Persistent banner shown at the top of the content area during active recording.

- [ ] **Step 1: Write the failing test**

```typescript
// src/renderer/src/components/__tests__/RecordingBanner.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RecordingBanner } from '../RecordingBanner'

describe('RecordingBanner', () => {
  it('renders nothing when not recording', () => {
    const { container } = render(
      <RecordingBanner isRecording={false} elapsedSeconds={0} sourceName={null} onStop={() => {}} />
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders banner with source name and timer', () => {
    render(
      <RecordingBanner isRecording elapsedSeconds={125} sourceName="Zoom Meeting" onStop={() => {}} />
    )
    expect(screen.getByText(/Recording/)).toBeInTheDocument()
    expect(screen.getByText(/Zoom Meeting/)).toBeInTheDocument()
    expect(screen.getByText('2:05')).toBeInTheDocument()
  })

  it('calls onStop when stop button clicked', async () => {
    const onStop = vi.fn()
    render(
      <RecordingBanner isRecording elapsedSeconds={10} sourceName="Meet" onStop={onStop} />
    )
    await userEvent.click(screen.getByText('Stop'))
    expect(onStop).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/components/__tests__/RecordingBanner.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Write RecordingBanner component**

```tsx
// src/renderer/src/components/RecordingBanner.tsx

interface RecordingBannerProps {
  isRecording: boolean
  elapsedSeconds: number
  sourceName: string | null
  onStop: () => void
}

export function RecordingBanner({ isRecording, elapsedSeconds, sourceName, onStop }: RecordingBannerProps) {
  if (!isRecording) return null

  const minutes = Math.floor(elapsedSeconds / 60)
  const seconds = elapsedSeconds % 60
  const timeStr = `${minutes}:${seconds.toString().padStart(2, '0')}`

  return (
    <div className="flex items-center gap-3 px-5 py-2.5 bg-bg-accent border-b border-border">
      <div className="w-2 h-2 rounded-full bg-status-recording animate-pulse" />
      <span className="text-[12px] font-medium text-ink">Recording</span>
      {sourceName && (
        <span className="text-[11px] text-ink-muted truncate max-w-xs">
          {sourceName}
        </span>
      )}
      <span className="text-[12px] font-mono text-ink-secondary ml-auto">
        {timeStr}
      </span>
      <button
        onClick={onStop}
        className="text-[11px] font-medium text-status-recording hover:opacity-80 transition-opacity"
      >
        Stop
      </button>
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/components/__tests__/RecordingBanner.test.tsx`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/RecordingBanner.tsx src/renderer/src/components/__tests__/RecordingBanner.test.tsx
git commit -m "feat(recording): add RecordingBanner component with timer and stop button"
```

---

### Task 10: Wire Recording into App Shell

**Files:**
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/components/Sidebar.tsx`
- Modify: `src/renderer/src/stores/app.ts`

- [ ] **Step 1: Read current App.tsx**

Read `src/renderer/src/App.tsx` to understand current structure.

- [ ] **Step 2: Update App.tsx to include RecordingBanner**

Add the `useRecording` hook and render `RecordingBanner` above the content area:

```tsx
// In App.tsx — add imports:
import { useRecording } from './hooks/useRecording'
import { RecordingBanner } from './components/RecordingBanner'

// Inside the App component, before return:
const { isRecording, sourceName, elapsedSeconds, handleStop } = useRecording()

// In the JSX, add RecordingBanner between the sidebar and the routes container:
// <RecordingBanner isRecording={isRecording} elapsedSeconds={elapsedSeconds} sourceName={sourceName} onStop={handleStop} />
```

The exact JSX placement is above the `<Routes>` block but inside the main content flex column, so it appears as a top bar above whatever page is active.

- [ ] **Step 3: Update Sidebar to use recording store**

In `src/renderer/src/components/Sidebar.tsx`, replace app store recording selectors:

```tsx
// Replace:
import { useAppStore } from '../stores/app'
// ...
const isRecording = useAppStore((s) => s.isRecording)
const recordingSeconds = useAppStore((s) => s.recordingSeconds)

// With:
import { useRecordingStore } from '../stores/recording'
// ...
const isRecording = useRecordingStore((s) => s.isRecording)
const recordingSeconds = useRecordingStore((s) => s.elapsedSeconds)
```

Keep `useAppStore` import for `ollamaConnected`.

- [ ] **Step 4: Remove recording fields from app store**

In `src/renderer/src/stores/app.ts`, remove `isRecording`, `recordingSeconds`, `setRecording`, `setRecordingSeconds`:

```typescript
import { create } from 'zustand'

interface AppState {
  ollamaConnected: boolean
  activePage: string

  setOllamaConnected: (connected: boolean) => void
  setActivePage: (page: string) => void
}

export const useAppStore = create<AppState>((set) => ({
  ollamaConnected: false,
  activePage: '/',

  setOllamaConnected: (connected) => set({ ollamaConnected: connected }),
  setActivePage: (page) => set({ activePage: page }),
}))
```

- [ ] **Step 5: Fix any test imports referencing removed app store fields**

Update `src/renderer/src/components/Sidebar.test.tsx` if it references `isRecording` or `recordingSeconds` from the app store — these now come from the recording store.

- [ ] **Step 6: Run all renderer tests**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 7: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/App.tsx src/renderer/src/components/Sidebar.tsx src/renderer/src/stores/app.ts src/renderer/src/components/Sidebar.test.tsx
git commit -m "feat(recording): wire recording into app shell with banner and timer"
```

---

### Task 11: Add Recording to Upcoming Page and EventCard

**Files:**
- Modify: `src/renderer/src/pages/Upcoming.tsx`
- Modify: `src/renderer/src/components/EventCard.tsx`
- Modify: `src/renderer/src/components/__tests__/EventCard.test.tsx`

- [ ] **Step 1: Add onRecord prop to EventCard**

Read current `src/renderer/src/components/EventCard.tsx`, then add:

```tsx
// Add to EventCard props:
onRecord?: (eventId: string) => void

// Add button in the card's action area next to auto-record toggle:
{onRecord && (
  <button
    onClick={() => onRecord(event.id)}
    className="text-[11px] font-medium text-white bg-ink px-2.5 py-1 rounded-md hover:opacity-90 transition-opacity"
  >
    Record
  </button>
)}
```

- [ ] **Step 2: Add failing test for Record button**

```typescript
// Add to existing EventCard.test.tsx:
it('renders Record button when onRecord provided', () => {
  render(
    <EventCard
      event={mockEvent}
      onToggleAutoRecord={() => {}}
      onRecord={() => {}}
    />
  )
  expect(screen.getByText('Record')).toBeInTheDocument()
})

it('calls onRecord when Record button clicked', async () => {
  const onRecord = vi.fn()
  render(
    <EventCard
      event={mockEvent}
      onToggleAutoRecord={() => {}}
      onRecord={onRecord}
    />
  )
  await userEvent.click(screen.getByText('Record'))
  expect(onRecord).toHaveBeenCalledWith(mockEvent.id)
})
```

- [ ] **Step 3: Run EventCard tests**

Run: `npx vitest run src/renderer/src/components/__tests__/EventCard.test.tsx`
Expected: PASS

- [ ] **Step 4: Wire RecordingControls into Upcoming.tsx**

```tsx
// In Upcoming.tsx, add imports:
import { RecordingControls } from '../components/RecordingControls'
import { useRecording } from '../hooks/useRecording'

// In component body:
const { isRecording, fetchSources, handleStart, handleStop } = useRecording()

// Replace PageHeader action to include RecordingControls:
action={
  isConnected ? (
    <div className="flex items-center gap-2">
      <RecordingControls
        isRecording={isRecording}
        onStartRecording={handleStart}
        onStopRecording={handleStop}
        onFetchSources={fetchSources}
      />
      <button
        onClick={handleSync}
        disabled={isSyncing}
        className="text-[11px] font-medium text-ink-muted bg-bg-accent px-3 py-1.5 rounded-md border border-border-subtle hover:border-ink-muted transition-colors disabled:opacity-50"
      >
        {isSyncing ? 'Syncing...' : 'Sync'}
      </button>
    </div>
  ) : undefined
}

// Pass handleStart to EventCards via onRecord:
<EventCard
  key={event.id}
  event={event}
  onToggleAutoRecord={handleToggleAutoRecord}
  onRecord={() => {
    // When recording from an event card, fetch sources and auto-start with detected window
    fetchSources().then((sources) => {
      const detected = detectMeetingWindow(sources)
      if (detected) {
        handleStart(detected.id, detected.name)
      }
    })
  }}
/>
```

Import `detectMeetingWindow` from `../services/window-detection`.

- [ ] **Step 5: Run all tests**

Run: `npx vitest run`
Expected: All pass

- [ ] **Step 6: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/pages/Upcoming.tsx src/renderer/src/components/EventCard.tsx src/renderer/src/components/__tests__/EventCard.test.tsx
git commit -m "feat(recording): add recording controls to Upcoming page and EventCard"
```

---

### Task 12: Integration Test — Full Recording Flow

**Files:**
- Create: `src/renderer/src/__tests__/recording-flow.test.tsx`

- [ ] **Step 1: Write the integration test**

```typescript
// src/renderer/src/__tests__/recording-flow.test.tsx
import { describe, it, expect, beforeEach } from 'vitest'
import { useRecordingStore } from '../stores/recording'
import { detectMeetingWindow } from '../services/window-detection'
import type { RecordingSource } from '../../../shared/types'

describe('Recording flow integration', () => {
  beforeEach(() => {
    useRecordingStore.getState().reset()
  })

  it('full state lifecycle: idle -> recording -> stopped', () => {
    const store = useRecordingStore

    // Initial state
    expect(store.getState().isRecording).toBe(false)
    expect(store.getState().meetingId).toBeNull()

    // Start recording
    store.getState().setRecordingState({
      isRecording: true,
      meetingId: 'meeting-1',
      startedAt: 1000,
      sourceId: 'window:1',
      sourceName: 'Zoom Meeting',
    })

    expect(store.getState().isRecording).toBe(true)
    expect(store.getState().meetingId).toBe('meeting-1')
    expect(store.getState().sourceName).toBe('Zoom Meeting')
    expect(store.getState().elapsedSeconds).toBe(0)

    // Timer ticks
    store.getState().tick()
    store.getState().tick()
    store.getState().tick()
    expect(store.getState().elapsedSeconds).toBe(3)

    // Stop recording
    store.getState().reset()
    expect(store.getState().isRecording).toBe(false)
    expect(store.getState().meetingId).toBeNull()
    expect(store.getState().elapsedSeconds).toBe(0)
  })

  it('window detection integrates with source selection', () => {
    const sources: RecordingSource[] = [
      { id: 'window:1', name: 'Zoom Meeting - Standup', thumbnailDataUrl: '' },
      { id: 'window:2', name: 'Visual Studio Code', thumbnailDataUrl: '' },
      { id: 'screen:0', name: 'Entire Screen', thumbnailDataUrl: '' },
    ]

    const detected = detectMeetingWindow(sources)
    expect(detected).not.toBeNull()
    expect(detected!.name).toContain('Zoom')

    // Simulate using detected window to start recording
    useRecordingStore.getState().setRecordingState({
      isRecording: true,
      meetingId: 'meeting-2',
      startedAt: Date.now(),
      sourceId: detected!.id,
      sourceName: detected!.name,
    })

    expect(useRecordingStore.getState().sourceName).toContain('Zoom')
  })
})
```

- [ ] **Step 2: Run the integration test**

Run: `npx vitest run src/renderer/src/__tests__/recording-flow.test.tsx`
Expected: PASS

- [ ] **Step 3: Run full test suites**

Run: `npx vitest run && npm run test:main:run`
Expected: All tests pass

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/__tests__/recording-flow.test.tsx
git commit -m "test(recording): add recording flow integration test"
```
