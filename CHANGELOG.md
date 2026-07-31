# Changelog

All notable changes to AutoDoc are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/DuetDisplay/AutoDoc/compare/v1.1.1...HEAD
[1.1.1]: https://github.com/DuetDisplay/AutoDoc/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/DuetDisplay/AutoDoc/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/DuetDisplay/AutoDoc/releases/tag/v1.0.0
