# AutoDoc roadmap

This page separates what is already shipped from ideas that are not commitments.
Nothing here has an owner or a date.

## Shipped

Verified in [v1.2.0](https://github.com/DuetDisplay/AutoDoc/releases/tag/v1.2.0):

- Local meeting notes for Apple Silicon Macs (macOS 14+) and Windows 10+ x64
- Screen, microphone, and system-audio recording, with no meeting bot
- On-device transcription and local Ollama notes and Ask AI
- Topic-based notes with a summary, editable details, and timestamp playback
- Copy as plain text, and export to PDF, Word, or Markdown
- Optional Google and Microsoft calendars
- Encrypted local storage

See [`PRODUCT.md`](PRODUCT.md) for behavior and limits, including audio source labels
(Me / Them) and the network uses that remain after setup.

## Under consideration

These are proposals, not planned releases.

- Publish a reproducible comparison of local processing on 8 GB and 16 GB
  machines, using a shareable synthetic meeting, named hardware, and separate
  transcription and notes timings. Results would be observations, not a speed
  promise.

## Ways to help

- Report a bug with the app version, operating system and architecture, CPU,
  GPU, and RAM, the model or processing profile, and a redacted error. Do not
  attach a real meeting recording.
- Correct documentation when it disagrees with the released app.
- Test with synthetic meetings and describe what the notes got wrong.

Security issues stay private. Follow [`SECURITY.md`](SECURITY.md).
Other contribution steps are in [`CONTRIBUTING.md`](CONTRIBUTING.md).
