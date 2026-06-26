# Changelog

All notable changes to AutoDoc are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Public repository documentation: README, privacy policy, security policy,
  contributing guide, self-hosting guide, and community templates.

## [1.0.0] — TBD

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

[Unreleased]: https://github.com/DuetDisplay/AutoDoc/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/DuetDisplay/AutoDoc/releases/tag/v1.0.0
