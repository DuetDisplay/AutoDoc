# Privacy Policy

**Last updated: 2026-06-10**

AutoDoc is built so your meetings stay yours. This document explains exactly
what happens to your data — and, just as importantly, what does *not* happen.

## The short version

- **Your audio, video, transcripts, and notes never leave your computer.** All
  recording, transcription, speaker identification, and AI note generation run
  entirely on-device.
- **No AutoDoc account.** There is nothing to sign up for.
- **No paid AI keys.** AI features run on a local [Ollama](https://ollama.com)
  instance that AutoDoc manages for you.
- **Analytics and crash reporting are strictly opt-in** and contain no meeting
  content.

## On-device processing

Everything that touches your meeting content happens locally:

| Stage | Where it runs |
|-------|---------------|
| Screen / microphone / system-audio capture | Your computer |
| Transcription (whisper.cpp / MLX) | Your computer |
| Speaker diarization | Your computer |
| AI note generation (Ollama / llama3.1) | Your computer |
| Search | Your computer |

No meeting audio, video, transcript, or generated note is ever transmitted to
Duet or any third party.

## Data storage and encryption

All recordings and derived data are stored locally under
`~/Library/Application Support/AutoDoc/` and **encrypted at rest** using
AES-256-GCM. The encryption key is held in the macOS Keychain via Electron's
`safeStorage`. Media files use chunked, per-block authenticated encryption; JSON
files (transcripts, notes, speakers, metadata) are individually encrypted with
per-file authentication. See [`PRODUCT.md`](PRODUCT.md#encryption) for the
technical detail.

## Calendar integration (optional)

If you connect Google or Microsoft Calendar:

- Sign-in uses an OAuth worker operated by Duet **only to exchange the
  authorization code for access/refresh tokens**. The worker performs the token
  exchange and returns the tokens to the app — **it does not store your tokens,
  calendar data, or any personal information.**
- Your OAuth tokens are encrypted with the macOS Keychain and stored locally.
- AutoDoc reads upcoming events (title, times, attendees, meeting links) to
  match recordings and offer speaker suggestions. This calendar data stays on
  your computer.

Self-hosters can run their own OAuth worker so no Duet-operated service is
involved at all — see [`docs/SELF_HOSTING.md`](docs/SELF_HOSTING.md).

## Analytics (opt-in)

AutoDoc can collect lightweight, anonymous product-usage analytics via PostHog,
**only if you opt in** during onboarding. We never capture meeting content.

What we capture when enabled: minimal feature-usage events (for example, that a
search was performed and how many results it returned, or that a calendar was
connected) tied to an anonymous device-level identifier with no personal
information.

**Disclosure about the consent event:** when you make your analytics choice,
AutoDoc records a single `analytics_consent` event noting whether you consented.
If you **decline**, this one event is still sent and then capturing is turned
off — we use it solely to measure opt-in rate. No further events are collected
after you decline. If you'd prefer this not happen at all, leave analytics off;
no other data is ever sent.

You can change your choice at any time in Settings.

## Crash reporting (opt-in)

Crash reports are handled by Sentry and are **only enabled in production when you
have opted in**. Stack traces have the machine name (`server_name`) stripped
before sending. If no Sentry DSN is configured at build time, crash reporting is
fully disabled.

## Third-party components

AutoDoc downloads and runs open-source components locally (the Ollama binary and
AI model, Whisper models from Hugging Face). These downloads are standard asset
fetches and do not transmit your meeting data.

## Contact

Questions about privacy? Email **chris@duetdisplay.com**.
