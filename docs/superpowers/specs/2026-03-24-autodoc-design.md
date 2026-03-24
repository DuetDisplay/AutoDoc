# AutoDoc — Local Meeting Assistant

## Overview

AutoDoc is a cross-platform, local-first meeting assistant that records meetings, transcribes audio, and uses a local LLM to organize notes into structured categories based on Andy Grove's High Output Management framework. All processing happens on-device — no cloud services required.

## Tech Stack

- **Runtime:** Electron (Chromium + Node.js)
- **Frontend:** React + TypeScript, Vite bundler
- **Styling:** Tailwind CSS
- **State Management:** Zustand
- **Storage:** better-sqlite3 (SQLite with FTS5 for full-text search)
- **Local LLM:** Ollama via HTTP API (localhost:11434)
- **Transcription:** whisper.cpp via Node bindings
- **Screen/Audio Capture:** Electron desktopCapturer API + native addons for system audio
- **Calendar:** Google Calendar API via googleapis npm package

## Architecture

Monolithic main process with service modules. React renderer communicates via IPC.

```
Renderer (React UI)  <--IPC-->  Main Process
                                  ├── RecordingService
                                  ├── TranscriptionService (Whisper)
                                  ├── LLMService (Ollama HTTP)
                                  ├── CalendarService (Google API)
                                  ├── StorageService (SQLite)
                                  └── DetectionService (mic/camera/window)
```

Each service sits behind a clean interface. Any service can be extracted into a worker thread or child process later if performance demands it.

### LLM Provider Abstraction

```typescript
interface LLMProvider {
  summarize(transcript: string): Promise<MeetingSegments>
  askQuestion(question: string, context: MeetingContext[]): Promise<string>
}
```

OllamaProvider implements this for v1. The interface enables swapping to a cloud provider (Claude, OpenAI) as a future upgrade path.

## Project Structure

```
src/
  main/                  # Electron main process
    services/
      recording.ts       # Screen + audio capture
      transcription.ts   # Whisper integration
      llm.ts             # Ollama client (swappable provider interface)
      calendar.ts        # Google Calendar sync
      storage.ts         # SQLite operations
      detection.ts       # Mic/camera/window detection
    ipc/                 # IPC handler registration
    index.ts             # Main process entry
  renderer/              # React app
    components/
    pages/
    hooks/
    stores/              # Zustand stores
    index.tsx
  shared/                # Types & constants shared between main/renderer
    types.ts
    constants.ts
```

## Data Model

### meetings

| Column            | Type    | Description                              |
|-------------------|---------|------------------------------------------|
| id                | TEXT PK | UUID                                     |
| title             | TEXT    | From calendar or user-entered            |
| start_time        | INTEGER | Unix timestamp                           |
| end_time          | INTEGER | Unix timestamp                           |
| calendar_event_id | TEXT    | Google Calendar event ID (nullable)      |
| recording_path    | TEXT    | Path to video file on disk               |
| audio_path        | TEXT    | Path to audio file on disk               |
| status            | TEXT    | 'recording' | 'processing' | 'complete' | 'failed' |
| created_at        | INTEGER | Unix timestamp                           |

### transcripts

| Column     | Type    | Description                          |
|------------|---------|--------------------------------------|
| id         | TEXT PK | UUID                                 |
| meeting_id | TEXT FK | References meetings(id)              |
| speaker    | TEXT    | Speaker label (Speaker 1, etc.)      |
| text       | TEXT    | Transcript text                      |
| start_ms   | INTEGER | Timestamp offset from meeting start  |
| end_ms     | INTEGER | Timestamp offset from meeting start  |
| confidence | REAL    | Transcription confidence score       |

### segments

| Column          | Type    | Description                                                              |
|-----------------|---------|--------------------------------------------------------------------------|
| id              | TEXT PK | UUID                                                                     |
| meeting_id      | TEXT FK | References meetings(id)                                                  |
| category        | TEXT    | 'decision' | 'action_item' | 'information' | 'discussion' | 'status_update' |
| title           | TEXT    | Short summary                                                            |
| content         | TEXT    | Full detail                                                              |
| assignee        | TEXT    | For action items (nullable)                                              |
| deadline        | TEXT    | For action items (nullable)                                              |
| source_start_ms | INTEGER | Links back to transcript range                                           |
| source_end_ms   | INTEGER | Links back to transcript range                                           |

### calendar_events

| Column          | Type    | Description                     |
|-----------------|---------|---------------------------------|
| id              | TEXT PK | UUID                            |
| google_event_id | TEXT    | Unique Google Calendar event ID |
| title           | TEXT    | Event title                     |
| start_time      | INTEGER | Unix timestamp                  |
| end_time        | INTEGER | Unix timestamp                  |
| attendees       | TEXT    | JSON array                      |
| meeting_url     | TEXT    | Zoom/Meet/Teams link (nullable) |
| auto_record     | INTEGER | 0 or 1                          |
| synced_at       | INTEGER | Unix timestamp                  |

### search_index

FTS5 virtual table over `transcripts.text` and `segments.content` for full-text search across all meetings.

### File Storage

Recordings stored in `~/AutoDoc/recordings/{meeting_id}/` with `screen.webm` and `audio.wav`. SQLite database at `~/AutoDoc/autodoc.db`.

## Service Layer

### RecordingService

- Uses Electron `desktopCapturer` to enumerate windows
- Matches windows against known meeting apps (Zoom, Google Meet in Chrome/Edge/Firefox, Teams, Webex) by process name and window title patterns
- Captures matched window video via `getUserMedia` with `chromeMediaSourceId`
- Captures system audio via desktopCapturer audio flag + mic via separate `getUserMedia` call
- Writes streams using MediaRecorder API (WebM for video, WAV for audio)
- API: `start()`, `stop()`, `getStatus()`, `getDetectedWindows()`

### DetectionService

- Polls system for active mic/camera usage (platform-specific: `ioreg` on macOS, WMI on Windows, `/proc` on Linux)
- When mic/camera activation detected and no recording active, emits event to renderer
- When mic/camera stops, automatically ends the recording

### TranscriptionService

- After recording stops, sends audio to local Whisper (whisper.cpp via Node bindings)
- Produces timestamped transcript segments with basic speaker diarization
- Stores results in `transcripts` table

### LLMService

- Implements `LLMProvider` interface via Ollama HTTP API
- `summarize()`: sends full transcript, returns structured JSON matching 5 HOM categories
- `askQuestion()`: retrieves relevant transcript chunks via FTS5, sends as context with the question
- Default model: `llama3` or `mistral` (configurable in settings)

### CalendarService

- OAuth2 flow via googleapis package (opens browser for auth)
- Syncs events on polling interval (every 5 minutes)
- Extracts meeting URLs from event descriptions/locations for window detection
- Stores in `calendar_events` table

### StorageService

- Wrapper around `better-sqlite3`
- Manages schema migrations
- Typed query methods for each table
- Manages FTS5 search index

## UI Design

### Visual Style: Warm Parchment

- Off-white warm backgrounds (#fafaf8 content, #f7f7f5 sidebar, #f0f0ee accents)
- Ink-black text and accents (#1a1a1a)
- Warm gray secondary text (#6b6966, #9b9894)
- White cards with warm borders (#e8e6e1)
- Geist font family, tight letter-spacing on headings (-0.03em)
- Generous spacing, 10-12px border radius on cards
- Dark flat buttons (ink-black background, white text)
- Pill badges for status indicators (Auto-record, etc.)

### Layout: Wide Sidebar + Content

Labeled sidebar (200px) with navigation items and status indicators. Main content area to the right.

### Pages

1. **Upcoming** — synced Google Calendar events. Each event shows title, time, attendees, meeting link, and auto-record toggle. Connect prompt if Google Calendar not linked.

2. **Recordings** — chronological list of past meetings. Each shows title, date, duration, and preview of key decisions. Click to open meeting detail view.

3. **Search** — full-text search across all transcripts and notes. Results show matching snippets with meeting context. Date range filter.

4. **Ask AI** — chat interface for questions across meeting history. LLM retrieves relevant chunks via FTS5 and answers with citations linking to specific meetings.

5. **Settings** (gear icon, bottom of sidebar):
   - Google Calendar connection (OAuth)
   - Default auto-record on/off
   - Ollama model selection
   - Recording storage path
   - Known meeting apps list

### Meeting Detail View

Tabbed layout with two tabs:

- **Notes** — all HOM categories as stacked sections within one scrollable view:
  - Decisions (what was decided, by whom)
  - Action Items (who owns what, deadlines)
  - Information Shared (key facts/updates)
  - Discussion/Debate (disagreements, open questions)
  - Status Updates (progress reports)
- **Transcript** — full timestamped transcript with speaker labels

### Sidebar Status

- Ollama connection indicator (green dot "connected" / red dot "disconnected")
- Active recording indicator (red dot + timer when recording)

## Recording Flow

1. **Detection:** App polls for mic/camera activation
2. **Prompt:** If near a scheduled calendar event, native OS notification: "Sprint Planning starts now. Start recording?" with Record/Dismiss. If auto-record enabled, starts silently. If no calendar match: "Microphone active — are you in a meeting?"
3. **Window detection:** App identifies the meeting window by matching process names/window titles against known meeting apps (Zoom, Meet, Teams, Webex)
4. **Capture:** Records matched window video + system audio + mic audio
5. **End:** When mic/camera stops, recording ends automatically
6. **Processing:** Whisper transcribes audio, LLM segments into HOM categories
7. **Complete:** Meeting appears in Recordings with "New" badge

## Error Handling

- **Ollama not running:** Sidebar shows disconnected state. Recording still works — processing queues until Ollama is available. Settings shows setup instructions if not installed.
- **Google Calendar not connected:** Upcoming shows connect prompt. App fully functional for ad-hoc recordings.
- **Disk space low:** Warn before starting recording.
- **Partial recordings:** Always preserved. Whatever was captured gets processed.
- **Processing failures:** Meeting shows "Processing failed" with retry button. Raw recordings always kept.

## Sub-Projects (Build Order)

1. **Core shell & UI foundation** — Electron app, React UI, design system, navigation, page routing
2. **Calendar integration** — Google Calendar OAuth, event sync, upcoming meetings view
3. **Recording engine** — screen capture, audio capture (system + mic), meeting window detection
4. **Transcription pipeline** — local Whisper integration, post-meeting processing
5. **Note-taking & LLM segmentation** — Ollama integration, HOM categorization, Notes tab UI
6. **Meeting library & search** — recordings list, full-text search, Ask AI chat interface
7. **Auto-detection & smart triggers** — mic/camera detection, auto-record, recording prompts

Each sub-project gets its own spec, plan, and implementation cycle.
