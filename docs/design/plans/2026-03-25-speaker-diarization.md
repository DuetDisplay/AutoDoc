# Speaker Diarization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add speaker identification to transcripts using pyannote diarization on separate mic/system audio streams, with color-coded UI and manual speaker renaming.

**Architecture:** The renderer saves mic and system audio as separate streams (instead of mixing into one `audio.webm`). After transcription, pyannote runs on the system audio to cluster remote speakers. Mic segments are labeled "Me." A `speakers.json` per meeting maps speaker IDs to display names. The UI color-codes segments by speaker and lets users rename speakers via a dropdown populated from calendar attendees.

**Tech Stack:** pyannote.audio (Python sidecar), torch, torchaudio, soundfile, ffmpeg, whisper.cpp, React, Electron IPC

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `resources/diarize.py` | Python script: takes wav path, runs pyannote, outputs JSON to stdout |
| `src/main/services/diarization.ts` | DiarizationService: manages Python virtualenv, model download, spawns diarize.py |
| `src/main/services/speaker-alignment.ts` | Pure function: aligns whisper transcript timestamps with pyannote speaker segments |
| `src/main/ipc/speakers-ipc.ts` | IPC handlers for `speakers:get` and `speakers:rename` |
| `src/renderer/src/components/SpeakerLegend.tsx` | Speaker legend bar with color dots and rename buttons |
| `src/renderer/src/components/SpeakerRenameDropdown.tsx` | Dropdown with calendar attendee suggestions + free text |
| `src/main/services/__tests__/speaker-alignment.test.ts` | Tests for speaker alignment logic |
| `src/renderer/src/components/__tests__/SpeakerLegend.test.tsx` | Tests for speaker legend |
| `src/renderer/src/components/__tests__/TranscriptView.test.tsx` | Updated tests for color-coded transcript |

### Modified Files
| File | Changes |
|------|---------|
| `src/shared/types.ts` | Add `'diarizing'` to `TranscriptionStatus`, add `SpeakerMap` type |
| `src/shared/constants.ts` | Add `SPEAKER_COLORS` palette, `PYTHON_ENV_SUBDIR` |
| `src/renderer/src/services/recording-capture.ts` | Save mic and system as separate streams instead of mixing |
| `src/main/ipc/recording-ipc.ts` | Update `save-chunk` to accept `'mic' \| 'system'`, update list/detail for new filenames |
| `src/main/services/transcription.ts` | Integrate diarization after whisper, merge mic+system for whisper input, move encryption after diarization |
| `src/main/index.ts` | Register speakers IPC, wire DiarizationService |
| `src/preload/ipc.d.ts` | Add `speakers:get`, `speakers:rename` IPC types, update `save-chunk` type |
| `src/renderer/src/components/TranscriptView.tsx` | Color-coded segments with speaker names |
| `src/renderer/src/pages/MeetingDetail.tsx` | Fetch speakers, pass to TranscriptView, handle rename |

---

### Task 1: Types & Constants

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/shared/constants.ts`

- [ ] **Step 1: Add `'diarizing'` to TranscriptionStatus and add SpeakerMap type**

In `src/shared/types.ts`, add `'diarizing'` between `'transcribing'` and `'complete'` in the `TranscriptionStatus` union. Add the `SpeakerMap` type:

```typescript
export type TranscriptionStatus =
  | 'pending'
  | 'queued'
  | 'downloading'
  | 'transcribing'
  | 'diarizing'
  | 'complete'
  | 'failed'

export interface SpeakerInfo {
  label: string
  suggestions?: string[]
}

export type SpeakerMap = Record<string, SpeakerInfo>
```

- [ ] **Step 2: Add speaker color palette and Python env constant to constants**

In `src/shared/constants.ts`, add:

```typescript
export const PYTHON_ENV_SUBDIR = 'python-env'

export const SPEAKER_COLORS: { border: string; bg: string }[] = [
  { border: '#5B8C6A', bg: '#f6faf7' }, // Me — sage green
  { border: '#C4956A', bg: '#fdf8f4' }, // Speaker 1 — amber
  { border: '#7A8FB5', bg: '#f4f6fa' }, // Speaker 2 — slate blue
  { border: '#B57A8F', bg: '#faf4f6' }, // Speaker 3 — dusty rose
  { border: '#6A9E9E', bg: '#f4fafa' }, // Speaker 4 — teal
  { border: '#8F7AB5', bg: '#f6f4fa' }, // Speaker 5 — plum
  { border: '#A89460', bg: '#faf8f4' }, // Speaker 6 — ochre
  { border: '#7A8A7A', bg: '#f4f6f4' }, // Speaker 7 — slate
]
```

- [ ] **Step 3: Run type check**

Run: `npx tsc --noEmit`
Expected: Clean compile (diarizing status is added but not consumed yet — no breakage)

- [ ] **Step 4: Commit**

```bash
git add src/shared/types.ts src/shared/constants.ts
git commit -m "feat(diarization): add SpeakerMap type, diarizing status, and speaker color palette"
```

---

### Task 2: Two-Stream Recording Capture

**Files:**
- Modify: `src/renderer/src/services/recording-capture.ts`
- Modify: `src/main/ipc/recording-ipc.ts`
- Modify: `src/preload/ipc.d.ts`

- [ ] **Step 1: Update IPC types for new chunk types**

In `src/preload/ipc.d.ts`, change the `recording:save-chunk` parameter type:

```typescript
'recording:save-chunk': [meetingId: string, type: 'video' | 'mic' | 'system', chunk: ArrayBuffer]
```

- [ ] **Step 2: Update save-chunk handler in recording-ipc.ts**

In `src/main/ipc/recording-ipc.ts`, update the `recording:save-chunk` handler. Change the type parameter from `'video' | 'audio'` to `'video' | 'mic' | 'system'` and update the filename mapping:

```typescript
ipcMain.handle(
  'recording:save-chunk',
  async (_event, meetingId: string, type: 'video' | 'mic' | 'system', chunk: ArrayBuffer) => {
    const currentState = recordingService.getState()
    if (!currentState.isRecording || currentState.meetingId !== meetingId) {
      return
    }
    const baseDir = recordingService.getRecordingsBaseDir()
    const filename = type === 'video' ? 'screen.webm' : type === 'mic' ? 'mic.webm' : 'system.webm'
    const filePath = join(baseDir, meetingId, filename)
    await appendFile(filePath, Buffer.from(chunk))
  }
)
```

- [ ] **Step 3: Update recording-capture.ts to save mic and system as separate streams**

Replace the audio mixing and recording section in `src/renderer/src/services/recording-capture.ts`. The key changes:
- Instead of mixing mic + system into one `mixedAudioStream`, create two separate `MediaRecorder` instances
- Send mic chunks with type `'mic'` and system chunks with type `'system'`
- Still create a mixed stream for the video mux (screen.webm needs combined audio)

Replace the entire `recording-capture.ts` file:

```typescript
interface CaptureHandles {
  videoRecorder: MediaRecorder
  micRecorder: MediaRecorder | null
  systemRecorder: MediaRecorder | null
  videoStream: MediaStream
  audioStream: MediaStream
  micStream: MediaStream | null
}

let activeCapture: CaptureHandles | null = null

export async function startCapture(
  sourceId: string,
  meetingId: string,
): Promise<void> {
  if (activeCapture) {
    throw new Error('Capture already active')
  }

  // 1. Capture window video (no audio)
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
    audioStream.getVideoTracks().forEach((t) => t.stop())
  } catch {
    audioStream = new MediaStream()
  }

  // 3. Capture microphone
  let micStream: MediaStream | null = null
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    })
  } catch {
    // Mic may not be available
  }

  const hasSystemAudio = audioStream.getAudioTracks().length > 0
  const hasMic = micStream !== null && micStream.getAudioTracks().length > 0

  // 4. Set up video recorder
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

  // 5. Set up mic recorder (separate stream)
  let micRecorder: MediaRecorder | null = null
  if (hasMic) {
    micRecorder = new MediaRecorder(micStream!, {
      mimeType: 'audio/webm;codecs=opus',
    })
    micRecorder.ondataavailable = async (e) => {
      if (e.data.size > 0) {
        const buffer = await e.data.arrayBuffer()
        window.electronAPI.invoke('recording:save-chunk', meetingId, 'mic', buffer)
      }
    }
  }

  // 6. Set up system audio recorder (separate stream)
  let systemRecorder: MediaRecorder | null = null
  if (hasSystemAudio) {
    systemRecorder = new MediaRecorder(audioStream, {
      mimeType: 'audio/webm;codecs=opus',
    })
    systemRecorder.ondataavailable = async (e) => {
      if (e.data.size > 0) {
        const buffer = await e.data.arrayBuffer()
        window.electronAPI.invoke('recording:save-chunk', meetingId, 'system', buffer)
      }
    }
  }

  // 7. Start all recorders
  videoRecorder.start(5000)
  micRecorder?.start(5000)
  systemRecorder?.start(5000)

  activeCapture = {
    videoRecorder,
    micRecorder,
    systemRecorder,
    videoStream,
    audioStream,
    micStream,
  }
}

export function stopCapture(): void {
  if (!activeCapture) return

  const { videoRecorder, micRecorder, systemRecorder, videoStream, audioStream, micStream } = activeCapture

  if (videoRecorder.state !== 'inactive') videoRecorder.stop()
  if (micRecorder && micRecorder.state !== 'inactive') micRecorder.stop()
  if (systemRecorder && systemRecorder.state !== 'inactive') systemRecorder.stop()

  videoStream.getTracks().forEach((t) => t.stop())
  audioStream.getTracks().forEach((t) => t.stop())
  micStream?.getTracks().forEach((t) => t.stop())

  activeCapture = null
}

export function isCapturing(): boolean {
  return activeCapture !== null
}
```

- [ ] **Step 4: Update recording-ipc.ts stop handler for new filenames**

In the `recording:stop` handler in `src/main/ipc/recording-ipc.ts`, update the post-recording processing. Replace `audioPath` references with `micPath` and `systemPath`:

Change the fire-and-forget async block to reference the new filenames:

```typescript
const micPath = join(meetingDir, 'mic.webm')
const systemPath = join(meetingDir, 'system.webm')
const videoPath = join(meetingDir, 'screen.webm')
```

For the mux step, combine both mic and system into the video:

```typescript
// Mux mic + system audio into video for playback
try {
  const micStat = await stat(micPath).catch(() => null)
  const systemStat = await stat(systemPath).catch(() => null)
  const videoStat = await stat(videoPath).catch(() => null)
  if (videoStat && (micStat || systemStat)) {
    const muxedPath = join(meetingDir, 'screen-muxed.webm')
    const audioInputs: string[] = []
    if (micStat) audioInputs.push(micPath)
    if (systemStat) audioInputs.push(systemPath)
    // If we have both audio sources, merge them first
    if (audioInputs.length === 2) {
      const mergedAudioPath = join(meetingDir, 'merged-audio-tmp.webm')
      await audioConverter.mergeAudio(micPath, systemPath, mergedAudioPath, whisperManager.getFfmpegPath())
      await muxAudioIntoVideo(whisperManager.getFfmpegPath(), videoPath, mergedAudioPath, muxedPath)
      await unlink(mergedAudioPath)
    } else {
      await muxAudioIntoVideo(whisperManager.getFfmpegPath(), videoPath, audioInputs[0], muxedPath)
    }
    await unlink(videoPath)
    await rename(muxedPath, videoPath)
  }
} catch (err) {
  console.error('Failed to mux audio into video:', err)
}
```

Add a `mergeAudioFiles` method to `src/main/services/audio-converter.ts` (the existing audio utility class):

```typescript
/** Merge two audio files into one using amix filter */
mergeAudio(input1: string, input2: string, outputPath: string, ffmpegPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, [
      '-i', input1,
      '-i', input2,
      '-filter_complex', 'amix=inputs=2:duration=longest',
      '-y',
      outputPath,
    ])
    let stderr = ''
    proc.stderr.on('data', (data: Buffer) => { stderr += data.toString() })
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg merge exited with code ${code}: ${stderr.slice(-500)}`))
    })
  })
}
```

Move encryption to AFTER transcription completes (remove `encryptFileInPlace` calls from the stop handler — encryption will happen at the end of the transcription pipeline in Task 5).

- [ ] **Step 5: Update recording:list to handle new filenames with backward compat**

In the `recording:list` handler, update the audio file detection to check for both old (`audio.webm`) and new (`mic.webm`) filenames:

```typescript
const micPath = join(meetingDir, 'mic.webm')
const legacyAudioPath = join(meetingDir, 'audio.webm')
const videoPath = join(meetingDir, 'screen.webm')
const micStat = await stat(micPath).catch(() => null)
const legacyAudioStat = await stat(legacyAudioPath).catch(() => null)
const videoStat = await stat(videoPath).catch(() => null)

const hasAudio = micStat !== null || legacyAudioStat !== null
if (!hasAudio && !videoStat) continue
```

Update the `hasAudio` field in the entry to use this new logic. Similarly update the duration fallback to use `micStat ?? legacyAudioStat`.

- [ ] **Step 6: Run type check and tests**

Run: `npx tsc --noEmit && npx vitest run && npx vitest run --config vitest.main.config.mts`
Expected: Clean compile. Some tests in `TranscriptionBadge.test.tsx` may need updating if they reference the status list — fix as needed.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/services/recording-capture.ts src/main/ipc/recording-ipc.ts src/preload/ipc.d.ts
git commit -m "feat(diarization): capture mic and system audio as separate streams"
```

---

### Task 3: Python Diarization Script

**Files:**
- Create: `resources/diarize.py`

- [ ] **Step 1: Create the diarize.py script**

Create `resources/diarize.py`:

```python
#!/usr/bin/env python3
"""
Speaker diarization using pyannote.audio.
Input: path to a WAV file (first argument)
Output: JSON to stdout with speaker segments
"""
import sys
import json
import os

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: diarize.py <wav_path>"}), file=sys.stderr)
        sys.exit(1)

    wav_path = sys.argv[1]
    if not os.path.exists(wav_path):
        print(json.dumps({"error": f"File not found: {wav_path}"}), file=sys.stderr)
        sys.exit(1)

    # Import here so errors are caught gracefully
    try:
        from pyannote.audio import Pipeline
    except ImportError as e:
        print(json.dumps({"error": f"pyannote.audio not installed: {e}"}), file=sys.stderr)
        sys.exit(1)

    # Use pretrained pipeline — downloads model on first use
    # Model is cached in ~/.cache/torch/pyannote/ by default
    hf_token = os.environ.get("HF_TOKEN", "")
    pipeline = Pipeline.from_pretrained(
        "pyannote/speaker-diarization-3.1",
        use_auth_token=hf_token if hf_token else None,
    )

    # Run diarization
    diarization = pipeline(wav_path)

    # Collect segments by speaker
    speakers = {}
    for turn, _, speaker in diarization.itertracks(yield_label=True):
        if speaker not in speakers:
            speakers[speaker] = {"id": speaker, "segments": []}
        speakers[speaker]["segments"].append({
            "start": round(turn.start, 3),
            "end": round(turn.end, 3),
        })

    result = {"speakers": list(speakers.values())}
    print(json.dumps(result))

if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Verify the script is syntactically valid**

Run: `python3 -c "import ast; ast.parse(open('resources/diarize.py').read()); print('OK')"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add resources/diarize.py
git commit -m "feat(diarization): add pyannote diarization Python script"
```

---

### Task 4: DiarizationService

**Files:**
- Create: `src/main/services/diarization.ts`

- [ ] **Step 1: Create DiarizationService**

This service manages the Python virtualenv, installs dependencies, and spawns `diarize.py`.

Create `src/main/services/diarization.ts`:

```typescript
import { app } from 'electron'
import { access, mkdir } from 'fs/promises'
import { join } from 'path'
import { spawn, execSync } from 'child_process'
import { PYTHON_ENV_SUBDIR } from '../../shared/constants'

export interface DiarizationSegment {
  start: number
  end: number
}

export interface DiarizationSpeaker {
  id: string
  segments: DiarizationSegment[]
}

export interface DiarizationResult {
  speakers: DiarizationSpeaker[]
}

export class DiarizationService {
  private ready = false
  private setupPromise: Promise<void> | null = null

  private getEnvDir(): string {
    return join(app.getPath('userData'), PYTHON_ENV_SUBDIR)
  }

  private getPythonPath(): string {
    return join(this.getEnvDir(), 'bin', 'python3')
  }

  private getScriptPath(): string {
    // In dev, resources/ is at project root; in production, it's in app.asar
    const isDev = !app.isPackaged
    if (isDev) {
      return join(app.getAppPath(), 'resources', 'diarize.py')
    }
    return join(process.resourcesPath, 'diarize.py')
  }

  async isReady(): Promise<boolean> {
    if (this.ready) return true
    try {
      await access(this.getPythonPath())
      this.ready = true
      return true
    } catch {
      return false
    }
  }

  async ensureReady(): Promise<void> {
    if (await this.isReady()) return
    if (this.setupPromise) return this.setupPromise
    this.setupPromise = this.setup()
    try {
      await this.setupPromise
    } finally {
      this.setupPromise = null
    }
  }

  private async setup(): Promise<void> {
    const envDir = this.getEnvDir()
    await mkdir(envDir, { recursive: true })

    // Find system python3
    let python3: string
    try {
      python3 = execSync('which python3', { encoding: 'utf-8' }).trim()
    } catch {
      throw new Error('python3 not found. Install Python 3 to enable speaker diarization.')
    }

    // Create virtualenv
    await this.runCommand(python3, ['-m', 'venv', envDir])

    // Install dependencies (explicitly NOT litellm)
    const pip = join(envDir, 'bin', 'pip')
    await this.runCommand(pip, [
      'install', '--upgrade', 'pip',
    ])
    await this.runCommand(pip, [
      'install',
      'pyannote.audio',
      'torch',
      'torchaudio',
      'soundfile',
    ])

    this.ready = true
  }

  async diarize(wavPath: string): Promise<DiarizationResult> {
    await this.ensureReady()

    return new Promise((resolve, reject) => {
      const proc = spawn(this.getPythonPath(), [this.getScriptPath(), wavPath], {
        env: { ...process.env, HF_TOKEN: process.env.HF_TOKEN ?? '' },
      })

      let stdout = ''
      let stderr = ''

      proc.stdout.on('data', (data: Buffer) => { stdout += data.toString() })
      proc.stderr.on('data', (data: Buffer) => { stderr += data.toString() })

      const timeout = setTimeout(() => {
        proc.kill()
        reject(new Error('Diarization timed out after 30 minutes'))
      }, 30 * 60 * 1000)

      proc.on('close', (code) => {
        clearTimeout(timeout)
        if (code === 0) {
          try {
            resolve(JSON.parse(stdout))
          } catch {
            reject(new Error(`Failed to parse diarization output: ${stdout.slice(0, 500)}`))
          }
        } else {
          reject(new Error(`diarize.py exited with code ${code}: ${stderr.slice(-500)}`))
        }
      })
    })
  }

  private runCommand(command: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args)
      let stderr = ''
      proc.stderr.on('data', (data: Buffer) => { stderr += data.toString() })
      proc.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`${command} exited with code ${code}: ${stderr.slice(-500)}`))
      })
    })
  }
}
```

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: Clean compile

- [ ] **Step 3: Commit**

```bash
git add src/main/services/diarization.ts
git commit -m "feat(diarization): add DiarizationService for pyannote virtualenv and sidecar management"
```

---

### Task 5: Speaker Alignment

**Files:**
- Create: `src/main/services/speaker-alignment.ts`
- Create: `src/main/services/__tests__/speaker-alignment.test.ts`

- [ ] **Step 1: Write tests for speaker alignment**

Create `src/main/services/__tests__/speaker-alignment.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { alignSpeakers } from '../speaker-alignment'
import type { Transcript } from '../../../shared/types'
import type { DiarizationResult } from '../diarization'

function makeTranscript(overrides: Partial<Transcript> & { startMs: number; endMs: number }): Transcript {
  return {
    id: 'test',
    meetingId: 'meeting-1',
    speaker: 'Speaker',
    text: 'test text',
    confidence: -1,
    ...overrides,
  }
}

describe('alignSpeakers', () => {
  it('assigns speaker with most overlap to each transcript segment', () => {
    const transcripts: Transcript[] = [
      makeTranscript({ id: 't1', startMs: 0, endMs: 5000 }),
      makeTranscript({ id: 't2', startMs: 5000, endMs: 10000 }),
    ]

    const diarization: DiarizationResult = {
      speakers: [
        { id: 'SPEAKER_00', segments: [{ start: 0, end: 5.5 }] },
        { id: 'SPEAKER_01', segments: [{ start: 5.5, end: 10.0 }] },
      ],
    }

    const result = alignSpeakers(transcripts, diarization, null)

    expect(result[0].speaker).toBe('speaker_1')
    expect(result[1].speaker).toBe('speaker_2')
  })

  it('labels mic-overlapping segments as "me" when micDuration is provided', () => {
    const transcripts: Transcript[] = [
      makeTranscript({ id: 't1', startMs: 0, endMs: 3000 }),
      makeTranscript({ id: 't2', startMs: 3000, endMs: 6000 }),
    ]

    // Diarization only ran on system audio — so all segments are remote
    const diarization: DiarizationResult = {
      speakers: [
        { id: 'SPEAKER_00', segments: [{ start: 0, end: 6.0 }] },
      ],
    }

    // Mic was active for 0-3s, then silent — so t1 is "me", t2 is remote
    const micSegments = [{ start: 0, end: 3.0 }]

    const result = alignSpeakers(transcripts, diarization, micSegments)

    expect(result[0].speaker).toBe('me')
    expect(result[1].speaker).toBe('speaker_1')
  })

  it('returns transcripts unchanged when diarization is null', () => {
    const transcripts: Transcript[] = [
      makeTranscript({ id: 't1', startMs: 0, endMs: 5000 }),
    ]

    const result = alignSpeakers(transcripts, null, null)

    expect(result[0].speaker).toBe('Speaker')
  })

  it('handles empty diarization speakers', () => {
    const transcripts: Transcript[] = [
      makeTranscript({ id: 't1', startMs: 0, endMs: 5000 }),
    ]

    const diarization: DiarizationResult = { speakers: [] }

    const result = alignSpeakers(transcripts, diarization, null)

    expect(result[0].speaker).toBe('Speaker')
  })

  it('maps pyannote speaker IDs to sequential speaker_N IDs', () => {
    const transcripts: Transcript[] = [
      makeTranscript({ id: 't1', startMs: 0, endMs: 3000 }),
      makeTranscript({ id: 't2', startMs: 3000, endMs: 6000 }),
      makeTranscript({ id: 't3', startMs: 6000, endMs: 9000 }),
    ]

    const diarization: DiarizationResult = {
      speakers: [
        { id: 'SPEAKER_02', segments: [{ start: 0, end: 3.0 }] },
        { id: 'SPEAKER_00', segments: [{ start: 3.0, end: 6.0 }] },
        { id: 'SPEAKER_02', segments: [{ start: 6.0, end: 9.0 }] },
      ],
    }

    const result = alignSpeakers(transcripts, diarization, null)

    expect(result[0].speaker).toBe('speaker_1')
    expect(result[1].speaker).toBe('speaker_2')
    expect(result[2].speaker).toBe('speaker_1') // same pyannote speaker as t1
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --config vitest.main.config.mts src/main/services/__tests__/speaker-alignment.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement speaker alignment**

Create `src/main/services/speaker-alignment.ts`:

```typescript
import type { Transcript } from '../../shared/types'
import type { DiarizationResult } from './diarization'

interface TimeSegment {
  start: number
  end: number
}

/**
 * Calculate overlap in seconds between two time ranges.
 */
function overlap(aStartMs: number, aEndMs: number, bStartSec: number, bEndSec: number): number {
  const aStartSec = aStartMs / 1000
  const aEndSec = aEndMs / 1000
  const overlapStart = Math.max(aStartSec, bStartSec)
  const overlapEnd = Math.min(aEndSec, bEndSec)
  return Math.max(0, overlapEnd - overlapStart)
}

/**
 * Align whisper transcript segments with pyannote diarization results.
 *
 * - If diarization is null or has no speakers, returns transcripts unchanged.
 * - If micSegments is provided, segments overlapping with mic activity are labeled "me".
 * - Remote speakers are labeled "speaker_1", "speaker_2", etc. (sequential by first appearance).
 */
export function alignSpeakers(
  transcripts: Transcript[],
  diarization: DiarizationResult | null,
  micSegments: TimeSegment[] | null,
): Transcript[] {
  if (!diarization || diarization.speakers.length === 0) {
    return transcripts
  }

  // Build a flat list of (pyannote_id, start, end) for quick lookup
  const diarSegments: { pyId: string; start: number; end: number }[] = []
  for (const speaker of diarization.speakers) {
    for (const seg of speaker.segments) {
      diarSegments.push({ pyId: speaker.id, start: seg.start, end: seg.end })
    }
  }

  // Map pyannote IDs to sequential speaker_N IDs (by order of first appearance)
  const pyIdToSpeakerId = new Map<string, string>()
  let nextSpeakerNum = 1

  return transcripts.map((t) => {
    // Check if this segment overlaps with mic activity
    if (micSegments) {
      let micOverlap = 0
      for (const mic of micSegments) {
        micOverlap += overlap(t.startMs, t.endMs, mic.start, mic.end)
      }
      let systemOverlap = 0
      for (const seg of diarSegments) {
        systemOverlap += overlap(t.startMs, t.endMs, seg.start, seg.end)
      }
      if (micOverlap > systemOverlap) {
        return { ...t, speaker: 'me' }
      }
    }

    // Find the pyannote speaker with the most overlap
    let bestPyId: string | null = null
    let bestOverlap = 0
    for (const seg of diarSegments) {
      const ov = overlap(t.startMs, t.endMs, seg.start, seg.end)
      if (ov > bestOverlap) {
        bestOverlap = ov
        bestPyId = seg.pyId
      }
    }

    if (!bestPyId) {
      return t // no overlap — keep original speaker
    }

    // Assign sequential ID
    if (!pyIdToSpeakerId.has(bestPyId)) {
      pyIdToSpeakerId.set(bestPyId, `speaker_${nextSpeakerNum++}`)
    }

    return { ...t, speaker: pyIdToSpeakerId.get(bestPyId)! }
  })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --config vitest.main.config.mts src/main/services/__tests__/speaker-alignment.test.ts`
Expected: All 5 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/main/services/speaker-alignment.ts src/main/services/__tests__/speaker-alignment.test.ts
git commit -m "feat(diarization): add speaker alignment with tests"
```

---

### Task 6: Integrate Diarization into Transcription Pipeline

**Files:**
- Modify: `src/main/services/transcription.ts`
- Modify: `src/main/index.ts`

- [ ] **Step 1: Update TranscriptionService to accept DiarizationService**

In `src/main/services/transcription.ts`, update the constructor to accept a `DiarizationService` and a `CalendarService`:

```typescript
import { DiarizationService } from './diarization'
import { alignSpeakers } from './speaker-alignment'
import type { CalendarService } from './calendar'
import type { SpeakerMap, CalendarEvent } from '../../shared/types'
```

Add to constructor:

```typescript
constructor(
  private whisperManager: WhisperManager,
  private audioConverter: AudioConverter,
  private recordingsBaseDir: string,
  private diarizationService: DiarizationService,
  private calendarService: CalendarService,
) {}
```

- [ ] **Step 2: Update processJob to include diarization step**

In the `processJob` method, after whisper completes and before saving the transcript, add:

1. Check if `system.webm` exists (new two-stream recording)
2. If so, convert it to wav and run diarization
3. Detect mic activity segments from `mic.webm` using ffmpeg silence detection
4. Run `alignSpeakers` to assign speaker IDs
5. Generate `speakers.json` with calendar attendee suggestions
6. Encrypt all files at the end (moved from recording-ipc.ts stop handler)

Key additions to `processJob`:

```typescript
// After whisper transcription produces the transcripts array...

// Diarization (only for new two-stream recordings)
const systemWebm = join(meetingDir, 'system.webm')
const micWebm = join(meetingDir, 'mic.webm')
let alignedTranscripts = transcripts

if (await this.fileExists(systemWebm)) {
  try {
    this.activeStatus = 'diarizing'
    this.broadcastStatus(meetingId, 'diarizing')

    // Convert system audio to wav for pyannote
    const tempSystemWav = `${tempPrefix}-system.wav`
    await this.audioConverter.convert(systemWebm, tempSystemWav, this.whisperManager.getFfmpegPath())

    const diarization = await this.diarizationService.diarize(tempSystemWav)
    await unlink(tempSystemWav).catch(() => {})

    // Detect mic activity for "me" labeling
    let micSegments: { start: number; end: number }[] | null = null
    if (await this.fileExists(micWebm)) {
      const tempMicWav = `${tempPrefix}-mic.wav`
      await this.audioConverter.convert(micWebm, tempMicWav, this.whisperManager.getFfmpegPath())
      micSegments = await this.detectAudioActivity(tempMicWav)
      await unlink(tempMicWav).catch(() => {})
    }

    alignedTranscripts = alignSpeakers(transcripts, diarization, micSegments)

    // Generate speakers.json
    await this.generateSpeakersJson(meetingId, alignedTranscripts)
  } catch (err) {
    console.error('Diarization failed, using un-diarized transcript:', err)
    // Fall through — use original transcripts without speaker labels
  }
}

await encryptJSON(alignedTranscripts, transcriptPath)
```

- [ ] **Step 3: Add helper methods to TranscriptionService**

Add a `detectAudioActivity` method that uses ffmpeg's silencedetect filter to find when the mic was active:

```typescript
private detectAudioActivity(wavPath: string): Promise<{ start: number; end: number }[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn(this.whisperManager.getFfmpegPath(), [
      '-i', wavPath,
      '-af', 'silencedetect=noise=-30dB:d=0.5',
      '-f', 'null', '-',
    ])
    let stderr = ''
    proc.stderr.on('data', (data: Buffer) => { stderr += data.toString() })
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg silencedetect failed: ${stderr.slice(-500)}`))
        return
      }
      // Parse silence_start/silence_end from ffmpeg output
      // Active segments = gaps between silence
      const silenceStarts: number[] = []
      const silenceEnds: number[] = []
      for (const match of stderr.matchAll(/silence_start:\s*([\d.]+)/g)) {
        silenceStarts.push(parseFloat(match[1]))
      }
      for (const match of stderr.matchAll(/silence_end:\s*([\d.]+)/g)) {
        silenceEnds.push(parseFloat(match[1]))
      }

      // Get total duration
      const durMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/)
      const totalDuration = durMatch
        ? parseInt(durMatch[1]) * 3600 + parseInt(durMatch[2]) * 60 + parseInt(durMatch[3])
        : 0

      // Build active (non-silent) segments
      const active: { start: number; end: number }[] = []
      let pos = 0
      for (let i = 0; i < silenceStarts.length; i++) {
        if (silenceStarts[i] > pos) {
          active.push({ start: pos, end: silenceStarts[i] })
        }
        pos = silenceEnds[i] ?? silenceStarts[i]
      }
      if (pos < totalDuration) {
        active.push({ start: pos, end: totalDuration })
      }

      resolve(active)
    })
  })
}
```

Add `generateSpeakersJson`:

```typescript
private async generateSpeakersJson(meetingId: string, transcripts: Transcript[]): Promise<void> {
  const meetingDir = join(this.recordingsBaseDir, meetingId)
  const speakersPath = join(meetingDir, 'speakers.json')

  // Collect unique speaker IDs
  const speakerIds = new Set(transcripts.map((t) => t.speaker))

  // Get calendar suggestions
  let suggestions: string[] = []
  try {
    if (this.calendarService.isConnected()) {
      const metadata = await this.readMetadata(meetingDir)
      if (metadata?.startedAt) {
        const events = await this.calendarService.fetchRecentEvents(30)
        const matched = this.matchCalendarEvent(events, metadata.startedAt)
        if (matched) {
          suggestions = matched.attendees
        }
      }
    }
  } catch {
    // Calendar fetch failed
  }

  const speakerMap: Record<string, { label: string; suggestions?: string[] }> = {}
  let speakerNum = 0
  for (const id of speakerIds) {
    if (id === 'me') {
      speakerMap[id] = { label: 'Me' }
    } else {
      speakerNum++
      speakerMap[id] = {
        label: `Speaker ${speakerNum}`,
        ...(suggestions.length > 0 ? { suggestions } : {}),
      }
    }
  }

  await encryptJSON(speakerMap, speakersPath)
}
```

Note: `matchCalendarEvent` is already defined in `recording-ipc.ts` (lines 33-50). Extract it to a new file `src/main/services/calendar-matcher.ts` so both `recording-ipc.ts` and `transcription.ts` can import it. Similarly, `readMetadata` (lines 52-62 of `recording-ipc.ts`) should be extracted there. Then update `recording-ipc.ts` to import from this shared module instead of defining them locally. The function signatures are:

```typescript
// src/main/services/calendar-matcher.ts
import type { CalendarEvent, MeetingMetadata } from '../../shared/types'
import { join } from 'path'
import { readFile } from 'fs/promises'
import { isEncrypted, decryptJSON } from './crypto'

export function matchCalendarEvent(events: CalendarEvent[], recordingStartMs: number): CalendarEvent | null { ... }
export async function readMetadata(meetingDir: string): Promise<MeetingMetadata | null> { ... }
```

- [ ] **Step 4: Add encryption at end of processJob**

After saving transcript and speakers.json, encrypt the raw audio files:

```typescript
// Encrypt raw files (moved from recording:stop handler)
const filesToEncrypt = [
  join(meetingDir, 'mic.webm'),
  join(meetingDir, 'system.webm'),
  join(meetingDir, 'screen.webm'),
]
for (const filePath of filesToEncrypt) {
  try {
    if (await this.fileExists(filePath)) {
      await encryptFileInPlace(filePath)
    }
  } catch (err) {
    console.error(`Failed to encrypt ${filePath}:`, err)
  }
}
```

Add the import: `import { encryptFileInPlace } from './crypto'`

- [ ] **Step 5: Update processJob to merge mic+system for whisper input**

Replace the current single-file whisper input logic with merging both streams:

```typescript
// Merge mic + system audio for whisper (or fall back to legacy audio.webm)
const micWebm = join(meetingDir, 'mic.webm')
const systemWebm = join(meetingDir, 'system.webm')
const legacyAudio = join(meetingDir, 'audio.webm')

let audioInput: string
if (await this.fileExists(micWebm)) {
  // New two-stream format — merge for whisper
  if (await this.fileExists(systemWebm)) {
    const mergedPath = `${tempPrefix}-merged.webm`
    await mergeAudioFiles(this.whisperManager.getFfmpegPath(), micWebm, systemWebm, mergedPath)
    audioInput = mergedPath
  } else {
    audioInput = micWebm
  }
} else {
  audioInput = legacyAudio
}
```

Use `this.audioConverter.mergeAudio()` which was added to `AudioConverter` in Task 2.

- [ ] **Step 6: Update index.ts to wire DiarizationService**

In `src/main/index.ts`:

```typescript
import { DiarizationService } from './services/diarization'
```

Create the instance and pass to TranscriptionService:

```typescript
const diarizationService = new DiarizationService()
const transcriptionService = new TranscriptionService(
  whisperManager,
  audioConverter,
  recordingService.getRecordingsBaseDir(),
  diarizationService,
  calendarService,
)
```

- [ ] **Step 7: Run type check and all tests**

Run: `npx tsc --noEmit && npx vitest run && npx vitest run --config vitest.main.config.mts`
Expected: Clean compile and all tests pass. Fix any test failures from the constructor change (mock the new parameters).

- [ ] **Step 8: Commit**

```bash
git add src/main/services/transcription.ts src/main/index.ts
git commit -m "feat(diarization): integrate diarization into transcription pipeline"
```

---

### Task 7: Speakers IPC

**Files:**
- Create: `src/main/ipc/speakers-ipc.ts`
- Modify: `src/preload/ipc.d.ts`
- Modify: `src/main/index.ts`

- [ ] **Step 1: Add IPC types**

In `src/preload/ipc.d.ts`, add to `IpcInvokeEvents`:

```typescript
'speakers:get': [meetingId: string]
'speakers:rename': [meetingId: string, speakerId: string, newLabel: string]
```

Add to `IpcInvokeReturns`:

```typescript
'speakers:get': SpeakerMap
'speakers:rename': void
```

Add `SpeakerMap` to the imports from `../../shared/types`.

- [ ] **Step 2: Create speakers-ipc.ts**

Create `src/main/ipc/speakers-ipc.ts`:

```typescript
import { ipcMain } from 'electron'
import { join } from 'path'
import { readFile } from 'fs/promises'
import { encryptJSON, decryptJSON, isEncrypted } from '../services/crypto'
import type { SpeakerMap } from '../../shared/types'

export function registerSpeakersIpc(recordingsBaseDir: string): void {
  ipcMain.handle('speakers:get', async (_event, meetingId: string): Promise<SpeakerMap> => {
    const speakersPath = join(recordingsBaseDir, meetingId, 'speakers.json')
    try {
      if (await isEncrypted(speakersPath)) {
        return await decryptJSON<SpeakerMap>(speakersPath)
      }
      return JSON.parse(await readFile(speakersPath, 'utf-8'))
    } catch {
      return {}
    }
  })

  ipcMain.handle(
    'speakers:rename',
    async (_event, meetingId: string, speakerId: string, newLabel: string): Promise<void> => {
      const speakersPath = join(recordingsBaseDir, meetingId, 'speakers.json')
      let speakers: SpeakerMap
      try {
        if (await isEncrypted(speakersPath)) {
          speakers = await decryptJSON<SpeakerMap>(speakersPath)
        } else {
          speakers = JSON.parse(await readFile(speakersPath, 'utf-8'))
        }
      } catch {
        speakers = {}
      }

      if (speakers[speakerId]) {
        speakers[speakerId].label = newLabel
      } else {
        speakers[speakerId] = { label: newLabel }
      }

      await encryptJSON(speakers, speakersPath)
    }
  )
}
```

- [ ] **Step 3: Register in index.ts**

In `src/main/index.ts`, add:

```typescript
import { registerSpeakersIpc } from './ipc/speakers-ipc'
```

And call it:

```typescript
registerSpeakersIpc(recordingService.getRecordingsBaseDir())
```

- [ ] **Step 4: Run type check**

Run: `npx tsc --noEmit`
Expected: Clean compile

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc/speakers-ipc.ts src/preload/ipc.d.ts src/main/index.ts
git commit -m "feat(diarization): add speakers:get and speakers:rename IPC handlers"
```

---

### Task 8: TranscriptView Color-Coded UI

**Files:**
- Modify: `src/renderer/src/components/TranscriptView.tsx`
- Modify: `src/renderer/src/components/__tests__/TranscriptView.test.tsx`

- [ ] **Step 1: Update TranscriptView props and rendering**

Update `src/renderer/src/components/TranscriptView.tsx` to accept a `speakers` prop and render color-coded segments:

```typescript
import type { Transcript, TranscriptionStatus, SpeakerMap } from '../../../shared/types'
import { SPEAKER_COLORS } from '../../../shared/constants'

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

function getSpeakerColor(speakerId: string, speakerIds: string[]): { border: string; bg: string } {
  if (speakerId === 'me') return SPEAKER_COLORS[0]
  const index = speakerIds.filter((id) => id !== 'me').indexOf(speakerId)
  // +1 to skip the "me" color at index 0
  const colorIndex = (index >= 0 ? index + 1 : 1) % SPEAKER_COLORS.length
  return SPEAKER_COLORS[colorIndex]
}

interface TranscriptViewProps {
  segments: Transcript[]
  status: TranscriptionStatus
  speakers?: SpeakerMap
  onSeek?: (ms: number) => void
}

export function TranscriptView({ segments, status, speakers, onSeek }: TranscriptViewProps) {
  // ... keep existing status rendering for pending/queued/downloading/transcribing/failed ...

  if (status === 'diarizing') {
    return (
      <div className="flex items-center gap-2">
        <div className="w-2 h-2 rounded-full bg-ink-muted animate-pulse" />
        <p className="text-[12px] text-ink-muted">
          Identifying speakers...
        </p>
      </div>
    )
  }

  // ... keep existing empty check ...

  // Collect unique speaker IDs in order of first appearance
  const speakerIds = [...new Set(segments.map((s) => s.speaker))]
  const hasSpeakers = speakers && Object.keys(speakers).length > 0

  return (
    <div className="flex flex-col gap-1">
      {segments.map((seg) => {
        const speakerLabel = speakers?.[seg.speaker]?.label ?? seg.speaker
        const color = hasSpeakers ? getSpeakerColor(seg.speaker, speakerIds) : null

        return (
          <div
            key={seg.id}
            className="flex gap-3 rounded-lg px-3 py-2"
            style={color ? {
              borderLeft: `3px solid ${color.border}`,
              backgroundColor: color.bg,
            } : undefined}
          >
            {onSeek ? (
              <button
                onClick={() => onSeek(seg.startMs)}
                className="text-[11px] text-ink-faint font-mono w-10 shrink-0 pt-0.5 text-left hover:text-ink hover:underline transition-colors cursor-pointer"
              >
                {formatTimestamp(seg.startMs)}
              </button>
            ) : (
              <span className="text-[11px] text-ink-faint font-mono w-10 shrink-0 pt-0.5">
                {formatTimestamp(seg.startMs)}
              </span>
            )}
            <div>
              {hasSpeakers && (
                <span
                  className="text-[11px] font-semibold block"
                  style={{ color: color?.border }}
                >
                  {speakerLabel}
                </span>
              )}
              <p className="text-[12.5px] text-ink leading-relaxed">
                {seg.text}
              </p>
            </div>
          </div>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 2: Update TranscriptView tests**

Update `src/renderer/src/components/__tests__/TranscriptView.test.tsx` to test color-coded rendering:

Add new test cases:

```typescript
it('renders speaker names when speakers map is provided', () => {
  const speakers = {
    me: { label: 'Me' },
    speaker_1: { label: 'Alice' },
  }
  const segments = [
    { id: 's1', meetingId: 'm1', speaker: 'me', text: 'Hello', startMs: 0, endMs: 3000, confidence: -1 },
    { id: 's2', meetingId: 'm1', speaker: 'speaker_1', text: 'Hi there', startMs: 3000, endMs: 6000, confidence: -1 },
  ]
  render(<TranscriptView segments={segments} status="complete" speakers={speakers} />)
  expect(screen.getByText('Me')).toBeInTheDocument()
  expect(screen.getByText('Alice')).toBeInTheDocument()
})

it('renders diarizing status', () => {
  render(<TranscriptView segments={[]} status="diarizing" />)
  expect(screen.getByText('Identifying speakers...')).toBeInTheDocument()
})
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/renderer/src/components/__tests__/TranscriptView.test.tsx`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/TranscriptView.tsx src/renderer/src/components/__tests__/TranscriptView.test.tsx
git commit -m "feat(diarization): color-coded speaker segments in TranscriptView"
```

---

### Task 9: SpeakerLegend and SpeakerRenameDropdown Components

**Files:**
- Create: `src/renderer/src/components/SpeakerLegend.tsx`
- Create: `src/renderer/src/components/SpeakerRenameDropdown.tsx`
- Create: `src/renderer/src/components/__tests__/SpeakerLegend.test.tsx`

- [ ] **Step 1: Write SpeakerLegend tests**

Create `src/renderer/src/components/__tests__/SpeakerLegend.test.tsx`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SpeakerLegend } from '../SpeakerLegend'

describe('SpeakerLegend', () => {
  const speakers = {
    me: { label: 'Me' },
    speaker_1: { label: 'Speaker 1', suggestions: ['alice@co.com'] },
    speaker_2: { label: 'Speaker 2', suggestions: ['alice@co.com'] },
  }

  it('renders all speaker labels', () => {
    render(<SpeakerLegend speakers={speakers} speakerIds={['me', 'speaker_1', 'speaker_2']} onRename={vi.fn()} />)
    expect(screen.getByText('Me')).toBeInTheDocument()
    expect(screen.getByText('Speaker 1')).toBeInTheDocument()
    expect(screen.getByText('Speaker 2')).toBeInTheDocument()
  })

  it('does not show rename button for "me"', () => {
    render(<SpeakerLegend speakers={speakers} speakerIds={['me', 'speaker_1']} onRename={vi.fn()} />)
    const renameButtons = screen.getAllByText('rename')
    expect(renameButtons).toHaveLength(1) // only for speaker_1
  })

  it('calls onRename when a suggestion is clicked', async () => {
    const onRename = vi.fn()
    render(<SpeakerLegend speakers={speakers} speakerIds={['me', 'speaker_1']} onRename={onRename} />)
    fireEvent.click(screen.getByText('rename'))
    fireEvent.click(screen.getByText('alice@co.com'))
    expect(onRename).toHaveBeenCalledWith('speaker_1', 'alice@co.com')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/renderer/src/components/__tests__/SpeakerLegend.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Create SpeakerRenameDropdown**

Create `src/renderer/src/components/SpeakerRenameDropdown.tsx`:

```typescript
import { useState, useRef, useEffect } from 'react'

interface SpeakerRenameDropdownProps {
  suggestions?: string[]
  onRename: (name: string) => void
  onClose: () => void
}

export function SpeakerRenameDropdown({ suggestions, onRename, onClose }: SpeakerRenameDropdownProps) {
  const [customName, setCustomName] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [onClose])

  const handleSubmit = () => {
    const trimmed = customName.trim()
    if (trimmed) {
      onRename(trimmed)
      onClose()
    }
  }

  return (
    <div
      ref={ref}
      className="absolute top-full left-0 mt-1 z-50 bg-bg-card border border-border rounded-lg shadow-lg min-w-[200px]"
    >
      {suggestions && suggestions.length > 0 && (
        <>
          <div className="px-3 py-1.5 text-[10px] text-ink-faint uppercase tracking-wider">
            From calendar invite
          </div>
          {suggestions.map((email) => (
            <button
              key={email}
              onClick={() => { onRename(email); onClose() }}
              className="block w-full text-left px-3 py-2 text-[12px] text-ink hover:bg-bg-accent/60 transition-colors"
            >
              {email}
            </button>
          ))}
          <div className="border-t border-border my-1" />
        </>
      )}
      <div className="px-3 py-2">
        <input
          ref={inputRef}
          type="text"
          value={customName}
          onChange={(e) => setCustomName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); if (e.key === 'Escape') onClose() }}
          placeholder="Type a custom name..."
          className="w-full border border-border rounded px-2 py-1.5 text-[12px] outline-none focus:border-ink-muted bg-transparent"
        />
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Create SpeakerLegend**

Create `src/renderer/src/components/SpeakerLegend.tsx`:

```typescript
import { useState } from 'react'
import { SPEAKER_COLORS } from '../../../shared/constants'
import { SpeakerRenameDropdown } from './SpeakerRenameDropdown'
import type { SpeakerMap } from '../../../shared/types'

function getSpeakerColor(speakerId: string, speakerIds: string[]): string {
  if (speakerId === 'me') return SPEAKER_COLORS[0].border
  const index = speakerIds.filter((id) => id !== 'me').indexOf(speakerId)
  const colorIndex = (index >= 0 ? index + 1 : 1) % SPEAKER_COLORS.length
  return SPEAKER_COLORS[colorIndex].border
}

interface SpeakerLegendProps {
  speakers: SpeakerMap
  speakerIds: string[]
  onRename: (speakerId: string, newLabel: string) => void
}

export function SpeakerLegend({ speakers, speakerIds, onRename }: SpeakerLegendProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null)

  return (
    <div className="flex gap-4 px-4 py-3 bg-bg-card border border-border rounded-xl mb-3 items-center flex-wrap">
      <span className="text-[11px] text-ink-faint">Speakers:</span>
      {speakerIds.map((id) => {
        const info = speakers[id]
        const color = getSpeakerColor(id, speakerIds)
        return (
          <div key={id} className="relative flex items-center gap-1.5">
            <div
              className="w-2 h-2 rounded-full"
              style={{ backgroundColor: color }}
            />
            <span className="text-[12px] text-ink font-medium">
              {info?.label ?? id}
            </span>
            {id !== 'me' && (
              <button
                onClick={() => setRenamingId(renamingId === id ? null : id)}
                className="text-[10px] text-ink-faint border border-border rounded px-1.5 py-px hover:text-ink-muted transition-colors"
              >
                rename
              </button>
            )}
            {renamingId === id && (
              <SpeakerRenameDropdown
                suggestions={info?.suggestions}
                onRename={(name) => onRename(id, name)}
                onClose={() => setRenamingId(null)}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/renderer/src/components/__tests__/SpeakerLegend.test.tsx`
Expected: All 3 tests pass

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/SpeakerLegend.tsx src/renderer/src/components/SpeakerRenameDropdown.tsx src/renderer/src/components/__tests__/SpeakerLegend.test.tsx
git commit -m "feat(diarization): add SpeakerLegend and SpeakerRenameDropdown components"
```

---

### Task 10: Wire Everything in MeetingDetail Page

**Files:**
- Modify: `src/renderer/src/pages/MeetingDetail.tsx`

- [ ] **Step 1: Add speakers state and fetching**

In `src/renderer/src/pages/MeetingDetail.tsx`, add state and data fetching for speakers:

```typescript
import type { SpeakerMap } from '../../../shared/types'
import { SpeakerLegend } from '../components/SpeakerLegend'
```

Add state:

```typescript
const [speakers, setSpeakers] = useState<SpeakerMap>({})
```

In the `useEffect` that fetches data on mount, add:

```typescript
window.electronAPI.invoke('speakers:get', id).then(setSpeakers)
```

In the transcription status-changed listener, when status is `'complete'`, also refetch speakers:

```typescript
if (payload.status === 'complete') {
  window.electronAPI.invoke('transcription:get-transcript', id).then(setTranscript)
  window.electronAPI.invoke('speakers:get', id).then(setSpeakers)
}
```

- [ ] **Step 2: Add rename handler**

```typescript
const handleRenameSpeaker = useCallback(async (speakerId: string, newLabel: string) => {
  if (!id) return
  await window.electronAPI.invoke('speakers:rename', id, speakerId, newLabel)
  setSpeakers((prev) => ({
    ...prev,
    [speakerId]: { ...prev[speakerId], label: newLabel },
  }))
}, [id])
```

- [ ] **Step 3: Update transcript tab rendering**

In the transcript tab section, add the SpeakerLegend above the TranscriptView when speakers exist, and pass speakers to TranscriptView:

```typescript
{Object.keys(speakers).length > 0 && (
  <SpeakerLegend
    speakers={speakers}
    speakerIds={[...new Set(transcript.map((t) => t.speaker))]}
    onRename={handleRenameSpeaker}
  />
)}
<TranscriptView
  segments={transcript}
  status={transcriptionStatus}
  speakers={speakers}
  onSeek={(media?.hasVideo || media?.hasAudio) ? handleSeek : undefined}
/>
```

- [ ] **Step 4: Update TranscriptionBadge for diarizing status**

Check if `TranscriptionBadge` needs a config entry for `'diarizing'`. Read `src/renderer/src/components/TranscriptionBadge.tsx` — if it uses a status map, add:

```typescript
diarizing: { label: 'Identifying speakers...', className: '...' }
```

Use the same styling as `transcribing`.

- [ ] **Step 5: Run all tests**

Run: `npx tsc --noEmit && npx vitest run && npx vitest run --config vitest.main.config.mts`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/pages/MeetingDetail.tsx src/renderer/src/components/TranscriptionBadge.tsx
git commit -m "feat(diarization): wire speaker legend and color-coded transcript in MeetingDetail"
```

---

### Task 11: Update Existing Tests

**Files:**
- Modify: `src/main/services/__tests__/transcription.test.ts`
- Modify: `src/renderer/src/components/__tests__/TranscriptionBadge.test.tsx`

- [ ] **Step 1: Update transcription test mocks**

The `TranscriptionService` constructor now takes additional parameters (`DiarizationService`, `CalendarService`). Update the test to mock these:

```typescript
const mockDiarizationService = { diarize: vi.fn(), isReady: vi.fn(), ensureReady: vi.fn() }
const mockCalendarService = { isConnected: vi.fn(() => false) }

// Update constructor call:
const service = new TranscriptionService(
  mockWhisperManager as any,
  mockAudioConverter as any,
  baseDir,
  mockDiarizationService as any,
  mockCalendarService as any,
)
```

- [ ] **Step 2: Update TranscriptionBadge tests for 'diarizing' status**

Add a test for the new status in `TranscriptionBadge.test.tsx`:

```typescript
it('shows identifying speakers status', () => {
  render(<TranscriptionBadge status="diarizing" />)
  expect(screen.getByText(/identifying speakers/i)).toBeInTheDocument()
})
```

- [ ] **Step 3: Run all tests**

Run: `npx vitest run && npx vitest run --config vitest.main.config.mts`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/main/services/__tests__/transcription.test.ts src/renderer/src/components/__tests__/TranscriptionBadge.test.tsx
git commit -m "test(diarization): update existing tests for new constructor params and diarizing status"
```
