# Changelog

All notable changes to AutoDoc are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.3.0] — TBD

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

[Unreleased]: https://github.com/DuetDisplay/AutoDoc/compare/v1.3.0...HEAD
[1.3.0]: https://github.com/DuetDisplay/AutoDoc/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/DuetDisplay/AutoDoc/compare/v1.1.3...v1.2.0
[1.1.3]: https://github.com/DuetDisplay/AutoDoc/compare/v1.1.2...v1.1.3
[1.1.1]: https://github.com/DuetDisplay/AutoDoc/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/DuetDisplay/AutoDoc/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/DuetDisplay/AutoDoc/releases/tag/v1.0.0
