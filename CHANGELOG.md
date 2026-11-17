# Changelog

All notable changes to AutoDoc are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.3.4] — 2026-11-17

### Added

- **Ask about this meeting** on a recording opens Ask AI limited to that
  meeting. Clear the filter to ask across all your meetings again.
- Ask AI prepares its search index in the background and shows its progress,
  so the first answer doesn't wait for it.
- Ask AI is marked Beta, with a one-time notice explaining what to expect.

### Changed

- Ask AI answers faster and more accurately. It searches passages from your
  notes and transcripts, and each answer links to the moments it came from;
  click a link to open the recording at that time.
- Ask AI follows up on the same meeting, and replies in the language of your
  question.
- Ask AI only appears on computers that can run it well: those using the
  `qwen3:4b-instruct` model with GPU acceleration. Other computers don't show
  it, and skip its downloads and indexing. Recording, transcription and notes
  are unchanged.

### Fixed

- Ask AI source links no longer pile up across follow-up questions, and no two
  links point to the same moment.
- "Do I have recordings?" answers with your recording count, without source
  links.
- Short English questions, such as "can monkeys eat bananas?" or "is it done?",
  get an English reply.
- Speech models still download on a Mac when Hugging Face can't be reached,
  including in mainland China, using ModelScope or hf-mirror with every file
  checked against a pinned hash. The English Mac model and the Ollama runtime are
  now hash-checked too, and the Ollama download resumes after an interruption.
- AutoDoc restarts its local AI server within seconds if it stops unexpectedly,
  instead of waiting for the next health check.
- A Google calendar that can no longer sync now asks you to reconnect, instead of
  silently stopping.
- AutoDoc no longer gets stuck refusing new recordings when a quit or update
  install doesn't finish. It recovers on its own, or exits if it was already
  shutting down.
- Crash reports no longer include window or meeting titles, which were sent with
  button clicks in the recording picker and with some reports of very short
  recordings.
- A failed recording start no longer stops a recording that is already running.
- A recording can't be deleted while it is still recording, saving or being
  transcribed. If AutoDoc can't save a recording, for example on a full disk, it
  stops recording and tells you instead of continuing without saving.
- On Windows, a recording's audio is now encrypted as soon as transcription
  finishes, even if you opened the recording while it was processing. Before, it
  could stay unencrypted until AutoDoc restarted.

## [1.3.3] — 2026-10-30

### Added

- AutoDoc's interface is available in 27 languages. New installs choose the app
  language at the start of onboarding, and it can be changed anytime in Settings.
- Light and Dark appearance, with a switch in the sidebar and in Settings.
- When you update, a one-time card lets you choose the app language and
  appearance, and your meeting language if you haven't chosen one yet.
- If video capture stops and a recording continues with audio only, AutoDoc
  reminds you after five minutes and lets you stop the recording.
- A one-time prompt invites you to star AutoDoc on GitHub.

### Fixed

- If the disk fills up while a recording is being processed, AutoDoc keeps the
  recording and shows an alert with **Retry** instead of failing. Update and
  onboarding downloads show the same alert.
- On Windows PCs whose graphics card doesn't have enough free memory,
  transcription uses the CPU for that recording instead of failing, and AutoDoc
  explains why.
- Recordings larger than 2 GB are encrypted reliably.
- Meeting language names start with a capital letter in every app language, and
  unavailable languages explain why they can't be chosen.
- Banners, popovers and dialogs fit in every language and window size, with
  clearer keyboard focus and better contrast.

### Security

- Updated Electron to 44.10.0, which includes Node.js security fixes.

## [1.3.2] — 2026-10-27

This release updates AutoDoc’s underlying runtime and networking components with security fixes for macOS and Windows. We recommend updating to the latest version.

## [1.3.1] — 2026-10-20

### Fixed

- Auto-record prefers the timed meeting over all-day calendar events. The selected
  event stays attached to the recording. ([#55](https://github.com/DuetDisplay/AutoDoc/issues/55))
- Slack auto-record waits until a huddle is joined and selects its call window
  instead of Slack's main or pre-join window. Ambiguous windows produce a visible
  **Select window** prompt, including when AutoDoc is minimized on Windows.
- Auto-record shows an **AI notes started** notice with the meeting name and a
  **Stop** button. Notification text wraps, and only windows chosen by the user
  are remembered for later recordings.
- Video capture recovery keeps healthy microphone and system audio running.
  Recording continues with audio if video cannot recover, and exported video
  preserves the meeting timeline across recovery gaps.
- Updates wait until recordings, meeting processing, and speech model downloads
  finish. Quitting saves the current recording before closing.
  ([#66](https://github.com/DuetDisplay/AutoDoc/issues/66))
- Interrupted recordings recover from retained capture files on the next launch.
  Windows also keeps recordings readable after an unexpected shutdown during the
  app's first launch. Recovery preserves surviving audio; it cannot recreate
  audio that was never captured. ([#57](https://github.com/DuetDisplay/AutoDoc/issues/57))
- Transcription waits for missing speech models to download and resumes after
  setup, including meetings that exhausted automatic retries. Repeated Retry
  clicks no longer cause bursts of immediate failures.
  ([#67](https://github.com/DuetDisplay/AutoDoc/issues/67))
- Windows notes generation pulls a missing notes model and makes one recovery
  attempt after an Ollama exit. After Windows wakes, background restarts wait for
  GPU drivers and pause after repeated failures. Notes jobs can start a stopped
  engine without replacing one that is still starting.
  ([#46](https://github.com/DuetDisplay/AutoDoc/issues/46))
- Windows notes models can load when the user profile path contains non-ASCII
  characters. Existing models move to a compatible path without downloading
  again. If the model file still cannot be opened, AutoDoc shows **Notes model
  unavailable** until the user retries instead of repeatedly restarting.
  ([#68](https://github.com/DuetDisplay/AutoDoc/issues/68))
- Google Calendar asks users to reconnect when required permission is missing or
  expired, instead of continuing to poll a broken connection.
  ([#49](https://github.com/DuetDisplay/AutoDoc/issues/49))
- Meetings with no accepted note content show **No notes were generated** rather
  than a notes failure. The meeting-language introduction no longer names a
  specific version.
- Diagnostic logs remain valid JSON when titles contain brackets or quotes.
  Auto-record diagnostics omit window and meeting titles, and Windows errors
  redact the full user name.

### Known limitations

- The transcription and notes limitations listed under 1.3.0 still apply.
- Recovery of interrupted recordings does not establish that every cause of a
  stalled Stop or lost meeting detection has been fixed.
- The non-ASCII Windows profile fix has unit coverage; verification with a real
  Windows account whose name contains non-ASCII characters is still pending.

## [1.3.0] — 2026-10-14

### Added

- Support for 27 meeting languages on Apple Silicon Macs and Windows PCs,
  including Japanese, Simplified Chinese, and Korean. Transcripts and notes
  use the selected meeting language, with a speech model matched to that language.
- A meeting-language step during onboarding. Onboarding and Settings show
  language availability and first-use download sizes, with progress while the
  required speech models download.
- An **Open-source licenses** view in Settings → About with model attributions
  and notices for the bundled and downloaded speech runtimes.

### Changed

- On 8 GB Macs and low-spec PCs, meetings stay in English: other languages need
  larger AI models than these devices can run. Settings explains unavailable
  languages and flags slower CPU transcription.
- Overview sentences are checked against the meeting notes to remove unsupported
  claims. Smarter **Key Takeaways** selection chooses from the notes shown in the
  meeting. Devices using the small notes model, including 8 GB devices, skip the
  overview check and keep ranked Key Takeaways.

### Known issues

- Long Japanese meetings on AMD/Intel Windows PCs can occasionally lose passages
  from the transcript.
- European-language transcripts on PCs using CPU transcription can be less
  accurate than on supported NVIDIA GPUs, especially in Latvian, Ukrainian,
  Estonian, and French.
- While **Next Steps** is hidden, action items are omitted from notes on both
  platforms and in every language, including English. Information mistakenly
  classified as an action item can also be lost.
- Notes for very short Mandarin meetings (about 90 seconds) may not be generated.
  Longer Mandarin meetings are not affected.
- Notes for Greek meetings take longer to generate than for other languages.

## [1.2.0] — 2026-09-21

### Added

- A new notes format: the meeting title and a Summary, topics from the conversation, nested supporting details, and playable timestamps.
- Copy notes as plain text, and export the same notes as PDF, Word, or Markdown.
- Optional feedback on whether a finished note was useful. The meeting itself stays on the computer.
- Qwen 3 for notes and Ask AI on machines with enough memory. 8 GB Macs and Windows PCs use a smaller notes model and a lighter processing path.

### Changed

- Windows transcription profiles are chosen automatically. If the GPU fails on one recording, that recording finishes on CPU and the next recording tries the GPU again.
- Notes recover when the local model stalls or returns a bad response.
- On Windows, notes can use a capable discrete GPU.
- Low-memory transcription and notes failures explain what happened and how to retry.
- Older meetings keep their current notes until they are reprocessed.

### Fixed

- Dismissing a meeting-detected prompt no longer brings the AutoDoc window forward.
- Auto-record for a recurring series stays set after the calendar syncs.
- Pasting copied notes into Notion no longer drops in a second copy.
- A failed reprocess keeps the transcript and notes that were already saved.

## [1.1.3] — 2026-08-17

### Changed

- Documented the 8 GB Windows notes experience: notes still run locally, but
  they use more RAM, take longer, and the machine will feel pinned until they
  finish. 8 GB remains the minimum; 16 GB is the comfortable default.

### Fixed

- Clicking **Email Us** opens the default mail client without leaving leftover
  “Draft opened in your email app.” text in the sidebar or onboarding.

## [1.1.1] — TBD

### Added

- A persistent **Email Us** action that safely opens the user's default mail
  client and offers a copy-address fallback when a draft cannot be opened.
- A non-blocking feedback prompt on Upcoming and AI Notes after meaningful
  foreground use, with one optional reminder and permanent dismissal.

### Changed

- Windows capture recovery now preserves available microphone and system audio
  when screen video cannot be recovered, and saved meetings clearly indicate
  when video ended early.
- Opted-in analytics can distinguish confirmed app-version transitions from
  fresh installs. No version event is sent before consent.

### Fixed

- Dismissing the meeting-detected prompt no longer shows, restores, or brings
  the main AutoDoc window to the front.
- Slack Huddles are preferred over Slack overlay windows in the Windows capture
  picker, preventing the screen-share title-bar/overlay issue.

### Security

- Updated Electron, the automatic updater, PostHog/DOMPurify, React Router,
  Sentry, and affected transitive runtime packages to supported patched
  versions.

## [1.1.0] — 2026-07-27

### Added

- Windows 10+ support for x64 Intel and AMD PCs, including meeting detection,
  screen/microphone/system-audio capture, system-tray integration, and a signed
  installer.
- On-device Windows transcription with NVIDIA NeMo Parakeet TDT 0.6B v3.
  Compatible DirectML GPUs use hardware acceleration; CPU transcription remains
  available when acceleration is unavailable.
- Public repository documentation: README, privacy policy, security policy,
  contributing guide, self-hosting guide, and community templates.

### Changed

- Windows processing now adapts concurrency and model execution to available
  processors, memory, and GPU capabilities.
- Release automation now requires and publishes both the macOS DMG and Windows
  installer, including their updater metadata.
- Product, privacy, installation, self-hosting, and support documentation now
  cover both macOS and Windows.

### Security

- Windows encryption keys are protected by DPAPI through Electron `safeStorage`
  when available. If `safeStorage` is unavailable, the key is stored locally
  without operating-system protection; meeting data remains encrypted at rest
  with AES-256-GCM.

## [1.0.0] — 2026-06-29

First public release of AutoDoc.

### Added

- Local-first meeting recording with multi-track capture (screen, microphone,
  system audio).
- On-device transcription with whisper.cpp and Apple MLX acceleration.
- Two-stream speaker diarization with calendar-aware name suggestions.
- AI meeting notes (Decisions, Action Items, Information, Discussion, Status
  Updates) via local Ollama.
- Ask AI — chat with your meetings, entirely on-device.
- Google and Microsoft calendar integration with per-event auto-record.
- Automatic meeting detection for Zoom, Google Meet, Teams, Webex, and Slack.
- Full-text search across transcripts and notes with deep linking.
- AES-256-GCM encryption at rest, keyed via macOS Keychain.
- Opt-in analytics and crash reporting.

[Unreleased]: https://github.com/DuetDisplay/AutoDoc/compare/v1.3.3...HEAD
[1.3.3]: https://github.com/DuetDisplay/AutoDoc/compare/v1.3.2...v1.3.3
[1.3.2]: https://github.com/DuetDisplay/AutoDoc/compare/v1.3.1...v1.3.2
[1.3.1]: https://github.com/DuetDisplay/AutoDoc/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/DuetDisplay/AutoDoc/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/DuetDisplay/AutoDoc/compare/v1.1.3...v1.2.0
[1.1.3]: https://github.com/DuetDisplay/AutoDoc/compare/v1.1.2...v1.1.3
[1.1.1]: https://github.com/DuetDisplay/AutoDoc/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/DuetDisplay/AutoDoc/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/DuetDisplay/AutoDoc/releases/tag/v1.0.0
