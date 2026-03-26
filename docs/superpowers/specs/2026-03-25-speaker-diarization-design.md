# Speaker Diarization Design

## Goal

Add speaker identification to the transcription pipeline so each transcript segment is attributed to a specific speaker, color-coded in the UI, matchable to calendar attendees, and manually renamable.

## Architecture

### Two-Stream Recording

The renderer captures two separate audio streams during recording:

- **Mic stream** (`mic.webm`) — local user's microphone via `getUserMedia({ audio: true })`. All segments from this track are labeled `"me"`.
- **System stream** (`system.webm`) — remote participants' audio captured from the screen share's audio track via `desktopCapturer` with `{ audio: true }`. Pyannote diarization runs on this track to separate speakers.

The existing `audio.webm` single-stream is replaced by these two files. Both tracks are still mixed into `screen.webm` for video playback.

### Chunk Saving

`recording:save-chunk` changes from `type: 'video' | 'audio'` to `type: 'video' | 'mic' | 'system'`. The renderer sends chunks for all three streams.

### Backward Compatibility

Existing recordings with `audio.webm` continue to work. The transcription pipeline detects the old format and skips diarization — all segments display as "Speaker" (same as today).

## Diarization Pipeline

### Pyannote Sidecar

A Python script `diarize.py` bundled with the app, called via `child_process.spawn`.

- **Input:** wav file path
- **Output:** JSON to stdout with speaker-labeled time segments
- **Runtime:** Isolated virtualenv at `<userData>/python-env/`, created on first use
- **Dependencies (approved):** `pyannote.audio`, `torch`, `torchaudio`, `soundfile`
- **Forbidden:** `litellm` must never be used anywhere in this pipeline
- **Model:** Downloaded on first use (~2GB total for torch + pyannote models), cached in the models directory

### Diarization Output Format

```json
{
  "speakers": [
    { "id": "SPEAKER_00", "segments": [{ "start": 0.5, "end": 4.2 }, { "start": 8.1, "end": 12.3 }] },
    { "id": "SPEAKER_01", "segments": [{ "start": 4.5, "end": 7.9 }, { "start": 12.5, "end": 18.0 }] }
  ]
}
```

### Processing Pipeline (post-recording)

Sequential order after recording stops:

1. **Mux audio into video** (existing) — ffmpeg mixes mic + system audio into `screen.webm` for playback
2. **Transcribe** — ffmpeg merges `mic.webm` + `system.webm` into a single temporary wav. Whisper.cpp runs on this merged wav to produce timestamped text.
3. **Diarize** (new) — ffmpeg converts `system.webm` to wav. Pyannote runs on this to cluster remote speakers. Mic track segments are all assigned `"me"` based on timestamp overlap with the mic wav.
4. **Align & merge** (new) — merge whisper timestamps with pyannote speaker segments. Each transcript segment is assigned to the speaker with the most time overlap.
5. **Encrypt files** (moved to after all processing) — encrypt `mic.webm`, `system.webm`, `screen.webm`, `transcript.json`, `speakers.json`
6. **Segment via Ollama** (existing) — now receives transcript with real speaker attributions

### TranscriptionStatus Changes

Add `'diarizing'` to the status enum:

```
pending → queued → downloading → transcribing → diarizing → complete
```

## Data Model

### Transcript Type (unchanged shape)

```typescript
export interface Transcript {
  id: string
  meetingId: string
  speaker: string        // "me", "speaker_1", "speaker_2", etc.
  text: string
  startMs: number
  endMs: number
  confidence: number
}
```

The `speaker` field gets meaningful values instead of hardcoded `'Speaker'`.

### New: speakers.json (per meeting)

```json
{
  "me": { "label": "Me" },
  "speaker_1": { "label": "Speaker 1", "suggestions": ["alice@company.com", "bob@company.com"] },
  "speaker_2": { "label": "Speaker 2", "suggestions": ["alice@company.com", "bob@company.com"] }
}
```

- `label` — the display name shown in the UI
- `suggestions` — calendar attendee emails from the matched event, presented as rename options
- The `me` speaker always has label `"Me"` and no suggestions

When the user renames a speaker, only `speakers.json` is updated. Transcript segments reference stable IDs (`speaker_1`, etc.) and are never modified.

### New IPC Channels

- `speakers:get(meetingId)` → returns `Record<string, { label: string; suggestions?: string[] }>`
- `speakers:rename(meetingId, speakerId, newLabel)` → updates `speakers.json`

## UI Design

### TranscriptView Changes

Each transcript segment is color-coded by speaker:

- **Left border** (3px) in the speaker's color
- **Tinted background** — a very subtle wash of the speaker's color
- **Speaker name** above the text in the speaker's color, bold
- **Timestamp** remains on the left, clickable for seeking

### Speaker Legend

A bar at the top of the transcript showing all speakers with their color dots:

- `"Me"` — always shown, no rename button
- Other speakers — shown with a "rename" button

### Rename Dropdown

Clicking "rename" opens a dropdown with:

1. **Calendar attendee emails** from the matched event (if any), under a "From calendar invite" header
2. **Free text input** at the bottom for typing a custom name

### Color Palette

Warm, earthy tones matching the app's light theme:

| Speaker | Border/Text Color | Background Tint |
|---------|------------------|-----------------|
| Me | Sage green `#5B8C6A` | `#f6faf7` |
| Speaker 1 | Amber `#C4956A` | `#fdf8f4` |
| Speaker 2 | Slate blue `#7A8FB5` | `#f4f6fa` |
| Speaker 3 | Dusty rose `#B57A8F` | `#faf4f6` |
| Speaker 4 | Teal `#6A9E9E` | `#f4fafa` |
| Speaker 5 | Plum `#8F7AB5` | `#f6f4fa` |
| Speaker 6 | Ochre `#A89460` | `#faf8f4` |
| Speaker 7 | Slate `#7A8A7A` | `#f4f6f4` |

Supports up to 8 speakers. Beyond that, colors cycle.

## Edge Cases

### Single-participant recording
Only mic track present, no system audio. Everything labeled "Me", no diarization runs.

### System audio unavailable
User denies permission or screen source has no audio track. Fall back to mic-only. Transcript works but without speaker separation for remote participants.

### Pyannote setup failure
If Python or pip is unavailable, or virtualenv creation fails, skip diarization gracefully. Transcript is produced without speaker labels (all "Speaker"), same as today. Show a warning in the UI.

### Old recordings
Recordings with `audio.webm` (pre-diarization) display normally. No migration. All segments show as "Speaker" with no color coding.

## Files Affected

### New Files
- `src/main/services/diarization.ts` — DiarizationService: manages pyannote sidecar, virtualenv setup, model download
- `src/main/services/speaker-alignment.ts` — aligns whisper transcripts with pyannote speaker segments
- `resources/diarize.py` — Python diarization script
- `src/main/ipc/speakers-ipc.ts` — IPC handlers for speakers:get and speakers:rename
- `src/renderer/src/components/SpeakerLegend.tsx` — speaker legend bar with rename
- `src/renderer/src/components/SpeakerRenameDropdown.tsx` — rename dropdown component

### Modified Files
- `src/shared/types.ts` — add `'diarizing'` to TranscriptionStatus, add SpeakerMap type
- `src/shared/constants.ts` — speaker color palette
- `src/main/services/transcription.ts` — integrate diarization step after whisper
- `src/main/services/recording.ts` — handle mic.webm + system.webm
- `src/main/ipc/recording-ipc.ts` — update save-chunk type, handle new file names
- `src/main/index.ts` — register speakers IPC, wire up DiarizationService
- `src/renderer/src/components/TranscriptView.tsx` — color-coded segments with speaker names
- `src/renderer/src/pages/MeetingDetail.tsx` — fetch speakers, pass to TranscriptView, handle rename
- `src/preload/ipc.d.ts` — new IPC channel types
- `src/renderer/src/hooks/useRecording.ts` — capture two audio streams
