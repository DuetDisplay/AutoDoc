# AutoDoc — Product Documentation

AutoDoc is a local-first desktop application for macOS and Windows that records meetings, transcribes them on-device, and generates structured AI-powered notes with Ollama. Windows uses NVIDIA NeMo Parakeet as its primary transcription engine; Apple Silicon Macs use MLX Whisper. Meeting content is not sent to a cloud AI service.

---

## Table of Contents

1. [System Requirements](#system-requirements)
2. [Recording](#recording)
3. [Transcription](#transcription)
4. [Audio Source Labels](#audio-source-labels)
5. [AI Note-Taking](#ai-note-taking)
6. [Google Calendar Integration](#google-calendar-integration)
7. [Meeting Detection & Auto-Record](#meeting-detection--auto-record)
8. [Search](#search)
9. [Encryption](#encryption)
10. [Ollama Management](#ollama-management)
11. [Auto-Updater](#auto-updater)
12. [Permissions](#permissions)
13. [System Tray](#system-tray)
14. [UI Overview](#ui-overview)
15. [Data Storage & Migration](#data-storage--migration)
16. [Analytics & Crash Reporting](#analytics--crash-reporting)
17. [Build & Distribution](#build--distribution)

---

## System Requirements

The published minimum is the lowest supported configuration, not the target experience. AutoDoc adapts its local processing profile to available memory and hardware.

| Platform | Minimum (supported) | Recommended (best experience) |
|----------|---------------------|-------------------------------|
| **macOS** | macOS 14+ on Apple Silicon (M1 or later), 8 GB RAM, and ~10 GB free for first-run models | 16 GB+ RAM on Apple Silicon |
| **Windows** | Windows 10+ on 64-bit x64 Intel or AMD hardware, 8 GB RAM, and ~10 GB free for first-run models | 16 GB+ RAM; 8+ logical processors for CPU-only processing; a DirectML GPU with 4 GB+ VRAM is optional |

8 GB remains supported on both platforms. On 8 GB machines and other low-spec profiles, AutoDoc uses the smaller `llama3.2:3b` notes model and a lower-impact path: audio sources may be processed sequentially and notes wait until transcription finishes. **16 GB+ is recommended for the best experience.** Windows CPU systems below 8 logical processors or 16 GiB RAM use the low-spec profile; memory pressure can temporarily apply the same safeguards to otherwise capable hardware.

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

Recordings are served to the UI by a local HTTP media server on `127.0.0.1`. The Transcript tab displays the recording in a standard video or audio player. Clicking a timestamp in Notes opens the Transcript tab, seeks to that time, and starts playback; transcript timestamps also seek within the player.

---

## Transcription

### Pipeline Overview

The transcription pipeline converts each recorded audio source into timestamped text, then merges the source results into a speaker-labeled transcript. AutoDoc selects an engine and processing profile for the current platform and hardware.

### Audio Preparation

Before transcription, audio files are prepared independently:

1. **Format conversion**: WebM sources are converted to 16kHz mono WAV with ffmpeg.
2. **Source transcription**: Microphone and system-audio WAVs are transcribed separately so their source identity can contribute to speaker labels.
3. **Result merge**: Timestamped segments are normalized, deduplicated, and merged chronologically.
4. **Legacy support**: Older recordings that contain a single `audio.webm` file are handled transparently.

### Platform engines

| Platform/profile | Primary engine | Model/device behavior |
|------------------|----------------|-----------------------|
| **Windows GPU** | Parakeet | TDT 0.6B v3, FP32 through ONNX Runtime and DirectML |
| **Windows CPU** | Parakeet | TDT 0.6B v3, INT8 CPU execution |
| **Apple Silicon** | MLX Whisper | `distil-large-v3` through the bundled Python worker |

On Windows, AutoDoc chooses DirectML acceleration for compatible GPUs with at least 4 GB VRAM. When the GPU is unavailable or setup fails, it switches to the CPU profile. Existing faster-whisper assets and whisper.cpp provide additional compatibility fallbacks; they are not the normal Windows path.

The Windows processing profile also considers logical processor count, installed memory, and available memory. Lower-spec systems transcribe the two sources sequentially and defer notes generation to reduce peak memory use.

On macOS, the MLX worker exchanges newline-delimited JSON messages with the Electron main process. whisper.cpp remains a compatibility fallback.

Transcription output contains timestamped segments for each source. One recording is processed at a time; additional recordings remain queued.

### Status Tracking

Transcription status is broadcast to the renderer in real-time:

| Status | Description |
|--------|-------------|
| `pending` | No audio available or not yet started |
| `queued` | Waiting behind another transcription |
| `downloading` | Downloading the selected transcription model/runtime |
| `transcribing` | Active transcription (progress percentage shown) |
| `diarizing` | Reserved for experimental diarization; disabled in current releases |
| `complete` | Transcript saved and encrypted |
| `failed` | Error occurred (retry available) |

### Auto-Retry

Failed transcriptions are automatically retried on app startup. The retry count is tracked in a `transcript.error` file containing JSON:

```json
{ "error": "whisper process exited with code 1", "retries": 1 }
```

A maximum of 3 automatic retries are attempted. After that, the transcription stays in `failed` state and the user can manually retry from the meeting's Settings tab.

---

## Audio Source Labels

**Speaker diarization is currently unsupported.** The application explicitly disables the experimental diarization pipeline. It does not separate individual remote participants into “Speaker 1,” “Speaker 2,” or identify their voices.

Microphone and system audio are transcribed separately. Microphone segments use the **Me** label; system-audio segments use **Them**, including all remote participants on that track. A legacy mixed recording may have no source labels.

Calendar attendees can provide manual rename suggestions, and users can rename source labels from the meeting detail page. A manual name does not identify separate people within the system-audio track. Transcript colors distinguish the available source labels.

---

## AI Note-Taking

### What the Notes tab shows

After transcription, AutoDoc asks the local Ollama instance (`qwen3:4b-instruct`, or `llama3.2:3b` on 8 GB or low-spec profiles) for meeting notes. The Notes tab shows a V2 document when one exists:

- **Summary** (`overview`) when the model produced one
- **Key takeaways** when present
- **Topic sections**, each with a title, an optional summary, key points, and supporting details
- **Decisions** and **next steps** when the meeting produced them

A meeting does not always contain every section. Notes are generated from the transcript. The screen recording is replayable context; AutoDoc does not analyze video pixels or slides with a vision model. Review generated notes before relying on them. Available source timestamps refer to transcript time ranges and can seek the recording. Editing the text does not prove the new wording still matches those ranges.

### Persisted V2 document

The authoritative file is encrypted `notes.json`. `NotesRepository` treats an existing V2 document as authoritative: a damaged `notes.json` is not replaced by older `segments.json` content. Current content fields are `overview`, `keyTakeaways`, `sections`, `decisions`, and `nextSteps`. The document also stores `schemaVersion: 2`, `meetingId`, transcript and attribution revisions, and a notes revision.

```typescript
interface NoteTextBlock {
  text: string
  sources: { startMs: number; endMs: number }[]
  provenance: 'generated' | 'user-created' | 'user-edited'
}

interface NoteItem extends NoteTextBlock {
  id: string
  title: string | null
  topic: string | null
  owner: string | null
  deadline: string | null
  completed?: boolean
}

interface NoteSection {
  id: string
  title: string
  summary: NoteTextBlock | null
  keyPoints: NoteItem[]
  supportingDetails: NoteItem[]
}
```

`legacy` provenance appears only on notes adapted from the older format. Optional attribution fields on items are not a promise that every note names an owner.

### How generation is organized

The production path is `SegmentationService`, which writes through `NotesRepository`. `notes-scan-pipeline.ts` organizes extracted notes into the topic document the Notes tab shows. `notes-v2-pipeline.ts` is not the whole production path.

Long transcripts are processed in pieces and merged. Context size depends on the hardware profile: some passes request a 32K Ollama context, and lower-memory or constrained profiles use a smaller window. Temperature 0 is used on some generation calls. That setting does not make output deterministic, repeatable, or correct. Prompts ask the model to preserve names, numbers, and dates; users should still check timestamps against the recording.

### Legacy category notes

`segments.json` is the older notes file. Its extraction buckets are decisions, action items, information, discussion, and status updates. Those buckets are internal or legacy data, not the primary Notes tab once `notes.json` exists. Search uses V2 notes when `notes.json` is present and falls back to segments otherwise.

Updating the app does not regenerate existing meetings. Reprocessing can create a new document. If the topic pass fails after category segments were already written, AutoDoc can keep those segments. On the default path that outcome is stored as complete with a v1 layout marker. It is not a guarantee that every failed generation produces usable category notes: earlier failures are marked failed, and the optional Windows topic-writer experiment (`AUTODOC_TEST_WINDOWS_TOPIC_WRITER`) records this scan failure as failed rather than complete. Promoting legacy notes into V2 does not rewrite `segments.json`.

### Edits, copy, and export

Notes-tab edits, added or deleted blocks, and next-step checkboxes persist through `notes:write-v2` and `notes:set-next-step-completed` into `notes.json`. The older `segmentation:save-segments` channel still applies to legacy segment documents.

Users can copy notes as plain text or export PDF, Word (`.docx`), or Markdown. Export reads the normalized notes, including a legacy document when no V2 file exists. Exported files are ordinary documents the user saves; they are not covered by AutoDoc's encrypted storage.

### Auto-Retry

Failed note generation can retry on startup, up to 3 attempts, tracked in `segments.error`. A retry does not discard an authoritative `notes.json`.

---

## Google Calendar Integration

### OAuth Flow

1. User clicks "Connect" in Settings.
2. App opens Google OAuth consent screen in the default browser.
3. Auth is handled by a Cloudflare Worker (`autodoc-auth.duetdisplay.workers.dev`) that exchanges the authorization code for tokens.
4. Tokens are returned to a localhost callback on port 42813.
5. Tokens are stored locally and encrypted using Electron's `safeStorage`
   (macOS Keychain or Windows DPAPI) when available. If `safeStorage` is
   unavailable, they are stored locally without operating-system protection.

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

1. **Microphone activity check**: Uses the platform-specific microphone activity detector.
2. **Meeting app detection**: Scans running processes and visible windows for known meeting apps (Zoom, Google Meet, Teams, Webex, Slack, and Discord).
3. **Transition detection**: Triggers when microphone transitions from inactive to active.

### Detection Notification

When a meeting is detected, a floating overlay notification appears at the top-center of the screen (below the menu bar). It shows:

- A pulsing green dot
- The calendar event title (if matched) or "Meeting detected"
- "Would you like to start AI notes?"
- A "Start AI Notes" button to begin recording
- Auto-dismisses after 30 seconds

The notification is positioned within Electron's display work area so it avoids the macOS menu bar and Windows taskbar.

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

- **Transcripts**: Matches against the transcribed text
- **Notes**: When `notes.json` exists, matches summary, topic, and note text from that document. Otherwise matches legacy segment titles and content

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

All recording data is encrypted at rest using AES-256-GCM. When Electron's
`safeStorage` is available, it protects the encryption key with macOS Keychain
on macOS and DPAPI on Windows. If `safeStorage` is unavailable, AutoDoc stores
the key locally without operating-system protection; the recording data itself
remains AES-256-GCM encrypted.

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
3. **Model pull**: Automatically pulls `qwen3:4b-instruct` (or `llama3.2:3b` on 8 GB or low-spec profiles) with streaming progress updates. After an app update, leftover `llama3.1` stays usable until the new model is on disk.

### Progress Tracking

The setup process broadcasts progress to the UI:

| Phase | Description |
|-------|-------------|
| `downloading` | Downloading Ollama binary (with %) |
| `pulling` | Pulling the notes model (with %) |
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
2. GitHub Actions builds the macOS and Windows packages in platform-native jobs
3. The macOS app is code-signed and notarized; the Windows installer is signed
4. Both packages are assembled into a **draft** GitHub Release
5. Developer tests the draft manually
6. When ready for early adopters → mark as **pre-release** (new installs see it, existing users don't auto-update)
7. When confident → mark as **full release** (auto-updater picks it up for all users)

---

## Permissions

### Platform requirements

AutoDoc requests the operating-system permissions needed for the selected capture sources:

| Permission | Required for |
|------------|--------------|
| **Screen capture** | Capturing a selected window or display |
| **Microphone** | Capturing the local participant |
| **System audio** | Capturing remote participants from device output |

### Permission Prompting

- Permissions are checked before recording starts.
- If a permission is missing, the app provides platform-appropriate guidance or opens the relevant settings surface.
- During onboarding, permissions are presented with clear explanations of why each is needed.

---

## System Tray

AutoDoc lives in the macOS menu bar or Windows system tray. The tray menu shows:

- **Upcoming meetings**: The next 5 calendar events for today, with times (e.g., "2:30 PM") or "Now" for in-progress events. Clicking an event with a meeting URL opens it in the browser.
- **Open AutoDoc**: Shows and focuses the main window.
- **Quit**: Fully exits the app.

The menu refreshes on every click to show current data. Calendar events are passed from the main process calendar cache.

### Window Behavior

Closing the main window hides it to the tray rather than quitting the app. This keeps meeting detection running in the background. The app fully quits when "Quit" is selected from the tray menu or the platform quit command is used.

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

- **Notes**: Summary, topic sections, and any takeaways, decisions, or next steps, editable inline. Legacy meetings can still show category notes until reprocessed
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

All data lives in Electron's platform `userData` directory:

- **macOS:** `~/Library/Application Support/AutoDoc/`
- **Windows:** `%APPDATA%\AutoDoc\`

```
AutoDoc/
├── recordings/
│   └── {uuid}/
│       ├── screen.webm      (encrypted)
│       ├── mic.webm          (encrypted)
│       ├── system.webm       (encrypted)
│       ├── metadata.json     (encrypted)
│       ├── transcript.json   (encrypted)
│       ├── notes.json        (encrypted V2 notes, when generated)
│       ├── segments.json     (encrypted legacy or intermediate notes)
│       ├── speakers.json     (encrypted)
│       ├── transcript.error  (plaintext, retry tracking)
│       └── segments.error    (plaintext, retry tracking)
├── logs/
│   └── {application logs}
├── models/
│   ├── {transcription runtime and model assets}
│   ├── ffmpeg
│   └── ollama
├── ollama-data/
│   └── {model cache}/
└── python-env/
    └── {legacy experimental diarization environment, if present}
```

### Legacy Migration

Earlier macOS versions stored data in `~/AutoDoc/`. On startup, AutoDoc checks for this legacy directory and migrates `recordings/`, `models/`, and `ollama-data/` subdirectories to the proper Application Support location. Individual entries are moved without overwriting existing files. Empty legacy directories are cleaned up.

---

## Analytics & Crash Reporting

### Consent Model

Analytics are fully opt-in. During onboarding and in Settings, the user can enable anonymous product health and usage metrics. The consent state is stored as:

- `null` — Not yet asked
- `true` — Opted in
- `false` — Opted out

No analytics event is sent before consent, and declined consent sends nothing. The main process maintains a separate local analytics state with a random `install_id`, first launch date, daily-active/session state, coarse funnel flags/counters, and bounded first/last app versions. It retains at most one immediate pending version transition locally. If the user opts in later, AutoDoc sends `analytics_consent`, discloses that pending transition as `app_updated` when one exists, and then sends one `analytics_state_at_consent` event with coarse booleans and buckets. It does not replay pre-consent usage history. The pending transition is acknowledged only after the analytics client queues it.

### What's Tracked

- **Product-health events**: App opens, daily active use, session start/end, onboarding/setup progress, recording/transcription/notes success or failure, calendar connection/sync health, search result count buckets, chat completion health, update health, settings changes, and support/diagnostic workflow outcomes.
- **Anonymous DAU**: `daily_active` is emitted once per local day after opt-in and is keyed by the random `install_id`. The identifier is generated by AutoDoc and is not a hardware fingerprint.
- **Confirmed upgrades**: `app_updated` records a bounded immediate `previous_version` → `current_version` pair for opted-in installs. `transition_source` distinguishes upgrades observed while consent was already active from transitions disclosed when consent is later enabled. Fresh installs do not emit this event, and users who never consent remain intentionally unmeasured. This is separate from active-version mix and release-download counts.
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
- **Targets**: macOS DMG and Windows NSIS installer
- **Publish**: GitHub Releases (`DuetDisplay/AutoDoc`)

### CI/CD Pipeline

A GitHub Actions workflow (`.github/workflows/build.yml`) triggers on `v*` tag pushes:

1. Validates and prepares the tagged source
2. Builds macOS on `macos-latest`, including signing and notarization
3. Builds Windows on a Windows runner, including installer signing
4. Requires both platform packages before assembling the draft release
5. Publishes the DMG, Windows installer, and updater metadata to GitHub Releases

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
| `DD_SM_CLIENT_CERT_FILE_B64`, `DD_SM_API_KEY`, `DD_SM_CLIENT_CERT_PASSWORD`, `DD_SM_KEYPAIR_ALIAS` | DigiCert KeyLocker credentials used to sign Windows releases |
