# AutoDoc — Product Documentation

AutoDoc is a local-first desktop application that records meetings, transcribes them with whisper.cpp, identifies speakers, and generates structured AI-powered notes using Ollama. Everything runs on-device — no cloud processing, no data leaving your machine.

---

## Table of Contents

1. [Recording](#recording)
2. [Transcription](#transcription)
3. [Speaker Identification](#speaker-identification)
4. [AI Note-Taking](#ai-note-taking)
5. [Google Calendar Integration](#google-calendar-integration)
6. [Meeting Detection & Auto-Record](#meeting-detection--auto-record)
7. [Search](#search)
8. [Encryption](#encryption)
9. [Ollama Management](#ollama-management)
10. [Auto-Updater](#auto-updater)
11. [Permissions](#permissions)
12. [System Tray](#system-tray)
13. [UI Overview](#ui-overview)
14. [Data Storage & Migration](#data-storage--migration)
15. [Analytics & Crash Reporting](#analytics--crash-reporting)
16. [Build & Distribution](#build--distribution)

---

## Recording

### Multi-Track Capture

AutoDoc captures three simultaneous audio/video streams during a recording:

| Track | File | Contents |
|-------|------|----------|
| Screen | `screen.webm` | VP9 video of the selected window or entire screen |
| Microphone | `mic.webm` | Opus audio from the local microphone (your voice) |
| System Audio | `system.webm` | Opus audio from system output (remote participants) |

All streams use the WebM container format via the browser's native MediaRecorder API. Audio chunks are written every 100ms to minimize data loss if the app crashes.

### Source Selection

Before recording, the user selects a capture source from the available windows and screens (provided by Electron's `desktopCapturer`). The selected source name (e.g., "Zoom Meeting" or "Google Chrome") is saved as metadata and used as the recording title when no calendar event matches.

### Recording Lifecycle

1. **Start**: User clicks record or auto-record triggers. A UUID-based `meetingId` is generated, and a directory is created under `recordings/{meetingId}/`.
2. **Chunk Saving**: The renderer sends binary chunks to the main process via `recording:save-chunk`. Each chunk is appended to the appropriate file (`screen.webm`, `mic.webm`, or `system.webm`).
3. **Stop**: Recording ends (manually or via auto-stop). Metadata is saved to `metadata.json` containing source name, start time, stop time, and duration. The meeting is immediately enqueued for transcription.
4. **Encryption**: All files are encrypted at rest shortly after recording stops.

### Media Playback

Recordings are served to the UI via a custom `autodoc-media://` protocol. This protocol handler decrypts files on-the-fly — encrypted files are decrypted to a temp file before serving, and unencrypted files are served directly. The UI uses standard `<video>` and `<audio>` elements with seek support.

---

## Transcription

### Pipeline Overview

The transcription pipeline converts recorded audio into timestamped, speaker-labeled text using whisper.cpp (the C++ port of OpenAI's Whisper model).

### Audio Preparation

Before transcription, audio files are converted and merged:

1. **Format conversion**: WebM files are converted to 16kHz mono WAV using ffmpeg (required by whisper.cpp).
2. **Track merging**: If both `mic.webm` and `system.webm` exist, they are merged using ffmpeg's `amix` filter with `duration=longest` to preserve the full meeting length.
3. **Legacy support**: Older recordings that have a single `audio.webm` file are handled transparently.

### Whisper Execution

- **Binary**: Uses the system-installed `whisper-cli` from Homebrew (symlinked into the app's models directory). This avoids bundling a large binary in the app.
- **Model**: `ggml-large-v3.bin` (~3GB), downloaded from Hugging Face on first use with progress tracking.
- **Output**: JSON format with segments containing millisecond-precision timestamps and transcribed text.
- **Timeout**: 30-minute hard timeout per transcription job.
- **Concurrency**: One transcription job at a time; additional recordings are queued.

### Status Tracking

Transcription status is broadcast to the renderer in real-time:

| Status | Description |
|--------|-------------|
| `pending` | No audio available or not yet started |
| `queued` | Waiting behind another transcription |
| `downloading` | Downloading the Whisper model |
| `transcribing` | Active transcription (progress percentage shown) |
| `diarizing` | Speaker identification in progress |
| `complete` | Transcript saved and encrypted |
| `failed` | Error occurred (retry available) |

### Auto-Retry

Failed transcriptions are automatically retried on app startup. The retry count is tracked in a `transcript.error` file containing JSON:

```json
{ "error": "whisper process exited with code 1", "retries": 1 }
```

A maximum of 3 automatic retries are attempted. After that, the transcription stays in `failed` state and the user can manually retry from the meeting's Settings tab.

---

## Speaker Identification

### Two-Stream Diarization

AutoDoc uses a dual-track approach to identify who is speaking at any given moment:

- **System audio activity** → Remote participant(s) speaking
- **Silence on system track** → Local user speaking ("me")

This works by running ffmpeg's `silencedetect` filter (-30dB threshold, 0.5s minimum duration) on the system audio track to find active speech regions. Each transcript segment is then checked for overlap with these regions.

### Speaker Labels

- **Two-person meetings**: Speakers are labeled "me" and "them" for clarity.
- **Multi-person meetings**: Speakers are labeled "Speaker 1", "Speaker 2", etc.
- **Calendar-based suggestions**: If the recording matches a Google Calendar event, attendee emails are offered as rename suggestions in a dropdown.
- **Manual rename**: Users can rename any speaker label from the meeting detail page. Renames are persisted in `speakers.json`.

### Color Coding

Each speaker is assigned a distinct color from the palette (sage, amber, slate blue, dusty rose, teal, plum, ochre) for visual distinction in the transcript view.

---

## AI Note-Taking

### How It Works

After transcription completes, the transcript is sent to a locally-running Ollama instance (llama3.1) to extract structured meeting notes. This happens automatically — no user action required.

### Chunked Processing

Long transcripts are split into chunks of approximately 6,000 characters (~1,500 tokens) at line boundaries. Each chunk is processed independently with a "Part X of Y" indicator in the prompt. Results are merged with unique IDs across chunks. This strategy ensures thorough extraction even for hour-long meetings — a single-shot approach causes the model to over-summarize.

### Note Categories

The LLM extracts items in five categories:

| Category | What It Captures |
|----------|-----------------|
| **Decisions** | What was decided, by whom, and the reasoning |
| **Action Items** | Tasks assigned, with owner and deadline if mentioned |
| **Information** | Facts, numbers, data points, URLs, dates shared |
| **Discussion** | Debates, open questions, pros/cons explored |
| **Status Updates** | Progress reports, blockers, what's next |

### Accuracy Controls

To maximize note accuracy:

- **Temperature 0**: Ollama runs with `temperature: 0` for deterministic, consistent output.
- **Strict prompt instructions**: The system prompt explicitly forbids paraphrasing numbers, dates, or proper nouns. The model is instructed to quote exact words from the transcript.
- **32K context window**: Ollama is configured with `num_ctx: 32768` tokens. The llama3.1 model supports up to 128K context, ensuring the full chunk plus system prompt fits comfortably.

### Segment Structure

Each extracted note contains:

```typescript
{
  id: string              // Unique ID (offset for merged chunks)
  category: string        // decisions | action_items | information | discussion | status_updates
  title: string           // LLM-generated one-line summary
  content: string         // Full context from the transcript
  assignee: string | null // Person responsible (for action items)
  deadline: string | null // Due date if mentioned
}
```

### Editable Notes

Users can edit the generated segments directly in the meeting detail page. Edits are saved back to `segments.json` via the `segmentation:save-segments` IPC channel.

### Auto-Retry

Same retry logic as transcription — up to 3 automatic retries on startup, tracked in `segments.error`.

---

## Google Calendar Integration

### OAuth Flow

1. User clicks "Connect" in Settings.
2. App opens Google OAuth consent screen in the default browser.
3. Auth is handled by a Cloudflare Worker (`autodoc-auth.duetdisplay.workers.dev`) that exchanges the authorization code for tokens.
4. Tokens are returned to a localhost callback on port 42813.
5. Tokens are encrypted using Electron's safeStorage (macOS Keychain) and stored locally.

### Event Sync

Once connected, AutoDoc polls Google Calendar every 5 minutes for upcoming events. Synced data includes:

- Event title, start/end times
- Attendee email addresses
- Meeting URLs (extracted from hangoutLink, conferenceData, location, or description body)
- Recurring event IDs

Supported meeting URL patterns: Zoom, Google Meet, Microsoft Teams, Webex, and Slack huddles.

### Calendar-Recording Matching

When a recording completes, AutoDoc matches it to a calendar event by checking if the recording's start time falls within ±10 minutes of any event's time range. If matched:

- The event title becomes the recording title
- Attendee emails are offered as speaker rename suggestions
- The event's meeting URL is available for reference

### Auto-Record per Event

Each calendar event has an auto-record toggle with three modes:

| Mode | Behavior |
|------|----------|
| **Off** | Shows detection prompt when meeting starts |
| **Once** | Auto-records this specific event instance |
| **Series** | Auto-records all instances of a recurring event |

---

## Meeting Detection & Auto-Record

### Detection Logic

A background service polls every 3 seconds to detect active meetings:

1. **Microphone activity check**: Queries macOS `pmset -g assertions` to detect microphone usage by other apps.
2. **Meeting app detection**: Scans running processes for known meeting apps (Zoom, Google Meet, Teams, Webex, Slack).
3. **Transition detection**: Triggers when microphone transitions from inactive to active.

### Detection Notification

When a meeting is detected, a floating overlay notification appears at the top-center of the screen (below the menu bar). It shows:

- A pulsing green dot
- The calendar event title (if matched) or "Meeting detected"
- "Would you like to start AI notes?"
- A "Start AI Notes" button to begin recording
- Auto-dismisses after 30 seconds

The notification is positioned using `screen.getPrimaryDisplay().workArea` to avoid being hidden behind the macOS menu bar.

### Auto-Stop

When recording is active, AutoDoc watches for meeting end signals:

- Meeting window closes
- Microphone goes silent for 30 seconds (grace period handles brief mutes)
- When auto-stop triggers, the recording ends and processing begins immediately

---

## Search

### Full-Text Search

Search scans all recordings' transcripts and AI-generated notes in real-time (no pre-built index). The query is split into terms and matched case-insensitively — all terms must appear in a result for it to match.

### Result Sources

- **Transcripts**: Matches against the raw transcribed text
- **Segments**: Matches against note titles and content, tagged with their category

Results are capped at 5 matches per meeting and sorted by date (newest first).

### Deep Linking

Each individual match in the search results is clickable. Clicking navigates to the meeting detail page with query parameters that:

- Switch to the appropriate tab (`?tab=transcript` or `?tab=notes`)
- Scroll to and highlight the matching text (`?highlight=query`)
- The highlight effect uses a brief yellow background animation

### State Persistence

Search state (query text, results, and whether a search has been performed) is stored in a Zustand store that persists across tab switches. Navigating away from Search and back preserves the last search.

---

## Encryption

### At-Rest Encryption

All recording data is encrypted at rest using AES-256-GCM. The encryption key is stored in the macOS Keychain via Electron's safeStorage API.

### JSON Files (transcripts, segments, speakers, metadata)

- Algorithm: AES-256-GCM
- 12-byte random IV per file
- 16-byte authentication tag
- Additional Authenticated Data (AAD): the filename, preventing file renaming attacks
- File format: `[4-byte magic][12-byte IV][16-byte tag][ciphertext]`

### Media Files (audio, video)

Large media files use chunked encryption for streaming support:

- 65KB blocks with per-block nonces (XOR of block index into base nonce)
- Per-block AAD prevents block reordering attacks
- File format: `[magic][version][12-byte base nonce][...blocks...]`
- Each block: `[16-byte tag][ciphertext]`

### Migration

On startup, AutoDoc scans for unencrypted files and encrypts them in place. Stale `.enc` temp files from interrupted encryptions are cleaned up.

---

## Ollama Management

### Automatic Setup

AutoDoc manages its own isolated Ollama instance — completely separate from any user-installed Ollama:

1. **Binary download**: Downloaded from `github.com/ollama/ollama/releases` to the app's models directory.
2. **Server launch**: Spawned as a subprocess on port 11435 (not the default 11434) with isolated data directory.
3. **Model pull**: Automatically pulls `llama3.1` with streaming progress updates.

### Progress Tracking

The setup process broadcasts progress to the UI:

| Phase | Description |
|-------|-------------|
| `downloading` | Downloading Ollama binary (with %) |
| `pulling` | Pulling the llama3.1 model (with %) |
| `ready` | Server running, model available |
| `error` | Setup failed (with error message) |

Progress is shown in the SegmentationBadge component and during onboarding.

### Lifecycle

- Ollama starts in the background during app launch (doesn't block the window).
- On app quit (`before-quit` event), Ollama is gracefully stopped.
- If Ollama crashes, segmentation jobs fail and are retried on next startup.

---

## Auto-Updater

### Update Delivery

AutoDoc uses `electron-updater` with GitHub Releases as the update source.

### Check Schedule

- First check: 5 seconds after app launch
- Recurring checks: Every 4 hours
- Manual check: "Check for updates" button in Settings

### Update Flow

| Status | UI Display |
|--------|-----------|
| `idle` | "Check for updates" link |
| `checking` | "Checking..." (pulsing) |
| `available` | "v{version} downloading..." |
| `downloading` | "Downloading update... {percent}%" |
| `downloaded` | "Restart to update to v{version}" button |
| `error` | "Update check failed" (resets to idle after 30s) |

### Release Process

1. Developer pushes a git tag matching `v*` (e.g., `v0.1.0`)
2. GitHub Actions builds, code-signs, and notarizes the macOS app
3. The build is published as a **draft** GitHub Release
4. Developer tests the draft manually
5. When ready for early adopters → mark as **pre-release** (new installs see it, existing users don't auto-update)
6. When confident → mark as **full release** (auto-updater picks it up for all users)

---

## Permissions

### macOS Requirements

AutoDoc requires two system permissions on macOS:

| Permission | Required For | Detection Method |
|------------|-------------|-----------------|
| **Screen Recording** | Capturing window/screen video | `desktopCapturer.getSources()` — if thumbnails are empty, permission is denied |
| **Microphone** | Capturing local audio | `systemPreferences.getMediaAccessStatus('microphone')` |

### Permission Prompting

- Permissions are checked before recording starts.
- If missing, the app can open the relevant System Preferences pane directly.
- During onboarding, permissions are presented with clear explanations of why each is needed.

---

## System Tray

AutoDoc lives in the macOS menu bar with a template icon. The tray menu shows:

- **Upcoming meetings**: The next 5 calendar events for today, with times (e.g., "2:30 PM") or "Now" for in-progress events. Clicking an event with a meeting URL opens it in the browser.
- **Open AutoDoc**: Shows and focuses the main window.
- **Quit**: Fully exits the app.

The menu refreshes on every click to show current data. Calendar events are passed from the main process calendar cache.

### Window Behavior

Closing the main window hides it to the tray rather than quitting the app. This keeps meeting detection running in the background. The app only fully quits when "Quit" is selected from the tray menu or via Cmd+Q.

---

## UI Overview

### Pages

| Page | Route | Purpose |
|------|-------|---------|
| **Upcoming** | `/` | Calendar events for today with recording controls |
| **Recordings** | `/recordings` | List of all meetings with status badges |
| **Meeting Detail** | `/recordings/{id}` | Transcript, AI notes, media player, settings |
| **Search** | `/search` | Full-text search across all recordings |
| **Settings** | `/settings` | Calendar connection, auto-updater, app info |

### Meeting Detail Tabs

The meeting detail page has three tabs:

- **Notes**: AI-generated segments grouped by category, editable inline
- **Transcript**: Timestamped, speaker-colored transcript with click-to-seek
- **Settings**: Reprocess transcript/notes, delete recording (with confirmation)

### Design Language

- **Theme**: Warm light palette — cream backgrounds (#FAFAF7), sage green accents, warm whites
- **Typography**: 12-13px system font, monospace for technical values
- **Status colors**: Green for connected/complete, amber for in-progress, red/clay for errors
- **Speaker colors**: Sage, amber, slate blue, dusty rose, teal, plum, ochre
- **Animations**: Subtle transitions, pulsing indicators for active states

---

## Data Storage & Migration

### Storage Location

All data lives under `~/Library/Application Support/AutoDoc/`:

```
AutoDoc/
├── recordings/
│   └── {uuid}/
│       ├── screen.webm      (encrypted)
│       ├── mic.webm          (encrypted)
│       ├── system.webm       (encrypted)
│       ├── metadata.json     (encrypted)
│       ├── transcript.json   (encrypted)
│       ├── segments.json     (encrypted)
│       ├── speakers.json     (encrypted)
│       ├── transcript.error  (plaintext, retry tracking)
│       └── segments.error    (plaintext, retry tracking)
├── models/
│   ├── whisper-cli           (symlink)
│   ├── ffmpeg                (symlink)
│   ├── ggml-large-v3.bin     (Whisper model, ~3GB)
│   └── ollama                (Ollama binary)
└── ollama-data/
    └── {model cache}/
```

### Legacy Migration

Earlier versions stored data in `~/AutoDoc/`. On startup, AutoDoc checks for this legacy directory and migrates `recordings/`, `models/`, and `ollama-data/` subdirectories to the proper `Application Support` location. Individual entries are moved without overwriting existing files. Empty legacy directories are cleaned up.

---

## Analytics & Crash Reporting

### Consent Model

Analytics are fully opt-in. During onboarding and in Settings, the user can enable anonymous product health and usage metrics. The consent state is stored as:

- `null` — Not yet asked
- `true` — Opted in
- `false` — Opted out

No analytics event is sent before consent, and declined consent sends nothing. The main process maintains a separate local analytics state with a random `install_id`, first launch date, daily-active/session state, and coarse funnel flags/counters. If the user opts in later, AutoDoc sends `analytics_consent` followed by one `analytics_state_at_consent` event with coarse booleans and buckets; it does not replay pre-consent history.

### What's Tracked

- **Product-health events**: App opens, daily active use, session start/end, onboarding/setup progress, recording/transcription/notes success or failure, calendar connection/sync health, search result count buckets, chat completion health, update health, settings changes, and support/diagnostic workflow outcomes.
- **Anonymous DAU**: `daily_active` is emitted once per local day after opt-in and is keyed by the random `install_id`. The identifier is generated by AutoDoc and is not a hardware fingerprint.
- **Release downloads**: A scheduled GitHub Action snapshots aggregate GitHub release asset `download_count` values into PostHog as `github_release_download_count`. These events contain release/asset metadata and aggregate counts only; they do not contain user or device identifiers.
- **Crash reports** (Sentry): Stack traces with machine name stripped for privacy. Only enabled in production unless `AUTODOC_SENTRY_DEV` env var is set.

All PostHog autocapture, pageview, pageleave, and session recording features remain disabled. Renderer events pass through an allowlist/sanitizer so only approved keys are sent. Meeting content, transcripts, notes, prompts, titles, filenames, paths, raw logs, raw device names, participant/calendar details, audio, and video are never analytics properties.

### Sentry Configuration

- DSN is provided via `AUTODOC_SENTRY_DSN` environment variable — no DSN means no tracking at all.
- Release tag: `autodoc@{version}`
- Environment: `development` or `production`
- Privacy: `server_name` is deleted from all events before sending.

---

## Build & Distribution

### Build System

- **Framework**: Electron + electron-vite
- **Builder**: electron-builder
- **Targets**: macOS DMG (code-signed and notarized)
- **Publish**: GitHub Releases (`DuetDisplay/AutoDoc-Local`)

### CI/CD Pipeline

A GitHub Actions workflow (`.github/workflows/build.yml`) triggers on `v*` tag pushes:

1. Checks out code on `macos-latest`
2. Installs Node.js 20 and npm dependencies
3. Runs typecheck and electron-vite build
4. Signs with Apple Developer certificate (org secret: `DD_BUILD_CERTIFICATE_BASE64`)
5. Notarizes with Apple (org secrets: `DD_APPLE_ID`, `DD_APPLE_PASSWORD`, `DD_APPLE_TEAM`)
6. Publishes DMG to GitHub Releases via `--publish always`

### Release Flow

```
git tag v0.2.0 → push → CI builds → Draft Release
                                         ↓
                                    Manual testing
                                         ↓
                                    Pre-release (new installs only)
                                         ↓
                                    Full release (auto-update for everyone)
```

### Required Secrets

| Secret | Purpose |
|--------|---------|
| `DD_BUILD_CERTIFICATE_BASE64` | Base64-encoded .p12 signing certificate |
| `DD_P12_PASSWORD` | Password for the .p12 certificate |
| `DD_APPLE_ID` | Apple ID for notarization |
| `DD_APPLE_PASSWORD` | App-specific password for notarization |
| `DD_APPLE_TEAM` | Apple Developer Team ID |
