# Transcription Pipeline Design

## Goal

Automatically transcribe meeting recordings using a local whisper.cpp CLI, triggered when a recording stops, with results displayed in the app.

## Decisions

- **Engine:** whisper.cpp prebuilt CLI binary (not native addon, not WASM)
- **Model:** large-v3 (~3GB), downloaded on first use to `~/AutoDoc/models/`
- **Trigger:** Automatic when recording stops (no manual trigger needed)
- **Output:** Timestamped segments with text, start/end times
- **Audio conversion:** ffmpeg binary (downloaded alongside whisper.cpp) converts WebM/Opus to 16kHz mono WAV
- **Speaker diarization:** Not included — all segments attributed to "Speaker"

## Architecture

### Overview

When a recording stops, the `recording:stop` IPC handler in `recording-ipc.ts` is modified to call `TranscriptionService.enqueue(meetingId)` after `recordingService.stopRecording()`. The `TranscriptionService` processes jobs one at a time (whisper.cpp is CPU/GPU intensive). Each job converts audio to WAV, runs whisper.cpp, parses output, and writes results to the recording directory.

```
recording:stop IPC handler
  → recordingService.stopRecording() → returns { meetingId, startedAt }
  → transcriptionService.enqueue(meetingId)
  → WhisperManager.ensureReady() (download binary + model if needed, skip if present)
  → AudioConverter: audio.webm → audio.wav (16kHz mono PCM)
  → Spawn whisper-cpp CLI with -oj flag
  → whisper.cpp writes audio.wav.json to same directory
  → Parse audio.wav.json → map to Transcript[] → write transcript.json
  → Delete intermediate audio.wav and audio.wav.json
  → Broadcast status update to renderer
```

### Main Process Components

#### WhisperManager

Manages the whisper.cpp binary and model files. A new constant `MODELS_SUBDIR = 'models'` is added to `src/shared/constants.ts` alongside the existing `RECORDING_SUBDIR`.

- **Storage:** `~/AutoDoc/models/` directory (derived from `RECORDING_DIR_NAME` + `MODELS_SUBDIR`)
  - `~/AutoDoc/models/whisper-cpp` — the CLI binary
  - `~/AutoDoc/models/ggml-large-v3.bin` — the model file
  - `~/AutoDoc/models/ffmpeg` — the ffmpeg binary
- **`ensureReady(): Promise<void>`** — checks if binary and model exist, downloads if missing. No-op if already present.
- **`getWhisperPath(): string`** — returns path to whisper.cpp binary
- **`getFfmpegPath(): string`** — returns path to ffmpeg binary
- **`getModelPath(): string`** — returns path to model file
- **Progress events** — emits download progress for UI feedback during first-time setup
- **Platform detection** — downloads correct binary for current OS/arch. Initially supports macOS arm64 only; throws a clear error on unsupported platforms.
- **Download sources:**
  - whisper.cpp binary: GitHub Releases (`ggerganov/whisper.cpp`)
  - Model: Hugging Face (`ggerganov/whisper.cpp` model repo, `ggml-large-v3.bin`)
  - ffmpeg: static build from `https://evermeet.cx/ffmpeg/` (macOS, LGPL build)

#### AudioConverter

Converts WebM/Opus audio to WAV format required by whisper.cpp.

- **`convert(inputPath: string, outputPath: string, ffmpegPath: string): Promise<void>`**
- Spawns ffmpeg: `<ffmpegPath> -i <inputPath> -ar 16000 -ac 1 -f wav <outputPath>`
- Uses the actual audio file path from the recording directory (not a hardcoded filename)
- Throws on non-zero exit code

#### TranscriptionService

Job queue processing transcriptions sequentially.

- **`enqueue(meetingId: string): void`** — adds job to queue, starts processing if idle. Idempotent: skips if meetingId is already queued or in progress. Transitions status from `pending` → `queued`.
- **`getStatus(meetingId: string): TranscriptionStatus`** — returns current status (checks in-memory queue first, then filesystem)
- **`getTranscript(meetingId: string): Promise<Transcript[]>`** — reads and parses `transcript.json` from the meeting directory. Returns empty array if file doesn't exist.
- **`retry(meetingId: string): void`** — deletes `transcript.error` file and re-enqueues
- **Queue behavior:** FIFO, one job at a time
- **Job timeout:** 30 minutes per job
- **No-audio guard:** Before processing, checks if `audio.webm` exists. If not (video-only recording), skips transcription and does not mark as failed.
- **Status transitions:**
  - `pending` → `queued` (on enqueue)
  - `queued` → `downloading` (if dependencies not present) or `transcribing` (if ready)
  - `downloading` → `transcribing` (after download completes)
  - `transcribing` → `complete` / `failed`
  - `failed` → `queued` (on retry)
- **Broadcasts** status changes to all renderer windows via `transcription:status-changed` event
- **On app launch:** scans for recordings with `audio.webm` but no `transcript.json` and no `transcript.error`, re-enqueues them (deduplicates against already-queued items)
- **Cleanup:** deletes intermediate `audio.wav` and `audio.wav.json` after transcription completes (success or failure)

### Whisper.cpp Output Handling

whisper.cpp with `-oj` writes a JSON file alongside the input file (e.g., `audio.wav` → `audio.wav.json`). The service reads this file after the process exits.

whisper.cpp JSON structure:

```json
{
  "segments": [
    {
      "t0": 0,
      "t1": 320,
      "text": " Hello everyone, let's get started"
    }
  ]
}
```

Mapping to `Transcript` type:
- `id` — generated as `${meetingId}-${segmentIndex}` (deterministic, index-based)
- `meetingId` — from the job
- `speaker` — `"Speaker"` (no diarization)
- `text` — `segment.text` (trimmed)
- `startMs` — `segment.t0 * 10` (whisper.cpp uses centiseconds)
- `endMs` — `segment.t1 * 10`
- `confidence` — `-1` (whisper.cpp JSON does not include per-segment confidence; `-1` signals "not available" to downstream consumers)

### IPC Channels

New channels added to `src/preload/ipc.d.ts`:

| Channel | Args | Returns |
|---------|------|---------|
| `transcription:get-status` | `meetingId: string` | `TranscriptionStatus` |
| `transcription:get-transcript` | `meetingId: string` | `Transcript[]` |
| `transcription:retry` | `meetingId: string` | `void` |

New events added to `IpcOnEvents`:

| Event | Payload |
|-------|---------|
| `transcription:status-changed` | `{ meetingId: string, status: TranscriptionStatus }` |

The preload `ipc.d.ts` file is updated with these new channels in `IpcInvokeEvents`, `IpcInvokeReturns`, and `IpcOnEvents`.

### File Structure

```
~/AutoDoc/recordings/<uuid>/
  audio.webm          # Original recording
  screen.webm         # Original screen capture
  transcript.json     # Array of Transcript objects (final output)
  transcript.error    # Plain text error message (only if transcription failed)
```

Intermediate files (created during transcription, deleted after):
- `audio.wav` — converted audio for whisper.cpp
- `audio.wav.json` — raw whisper.cpp JSON output

### Status Tracking (File-Based)

No database required. Status derived from filesystem + in-memory queue:

- No `transcript.json` and no `transcript.error` and not in queue → `pending`
- In TranscriptionService queue → `queued` / `downloading` / `transcribing` (from in-memory state)
- `transcript.json` exists → `complete`
- `transcript.error` exists → `failed`

## Types

Added to `src/shared/types.ts`:

```typescript
export type TranscriptionStatus =
  | 'pending'
  | 'queued'
  | 'downloading'
  | 'transcribing'
  | 'complete'
  | 'failed'
```

The existing `Transcript` interface is used for the output segments.

## Constants

Added to `src/shared/constants.ts`:

```typescript
export const MODELS_SUBDIR = 'models'
```

## Renderer Changes

### Recording Cards (Recordings page)

Replace static "Awaiting transcription" badge with dynamic status:

| Status | Badge |
|--------|-------|
| `pending` / `queued` | "Awaiting transcription" |
| `downloading` | "Downloading model..." |
| `transcribing` | "Transcribing..." |
| `complete` | "Transcribed" |
| `failed` | "Failed — Retry" |

The "Failed — Retry" badge is clickable and calls `transcription:retry` IPC.

### Meeting Detail Page (`/recordings/:id`)

Display transcript when available:

- List of segments with timestamps (MM:SS) and text
- "Transcribing..." state with progress indicator
- "Failed" state with error message and retry button

## Error Handling

- **Model download fails:** Retry with exponential backoff (3 attempts), surface error to user
- **ffmpeg conversion fails:** Mark job as failed, write error message to `transcript.error`
- **whisper.cpp crashes or times out:** 30-minute timeout, mark as failed
- **App quits during transcription:** On next launch, detect incomplete jobs (has `audio.webm`, no `transcript.json`, no `transcript.error`) and re-enqueue
- **Corrupt audio file:** whisper.cpp reports error, captured and written to `transcript.error`
- **No audio file:** Video-only recordings are silently skipped (no transcription attempted)

## Testing

- **WhisperManager:** Unit tests with mocked fs/child_process for download logic, path resolution
- **AudioConverter:** Unit tests for command construction and error handling
- **TranscriptionService:** Unit tests for queue behavior, status transitions, re-enqueue on restart, retry logic, idempotent enqueue, no-audio guard
- **IPC handlers:** Unit tests mocking TranscriptionService
- **Renderer:** Test status badge rendering for each state, transcript display

## Out of Scope

- Speaker diarization (all segments use "Speaker")
- Real-time / streaming transcription
- Language selection (defaults to English)
- Model size selection UI (hardcoded to large-v3)
- Transcript editing
- SQLite storage (deferred to sub-project 6)
- Cancellation of in-progress transcription
- Disk space checks before download/conversion
- Platforms other than macOS arm64
