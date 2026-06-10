# Self-Hosting AutoDoc

AutoDoc is local-first: recording, transcription, speaker diarization, and AI
note generation all run on your machine with no Duet-hosted infrastructure
involved. The only optional hosted component is a small **calendar OAuth
worker** that brokers the Google/Microsoft sign-in flow, plus a couple of
**runtime asset bundles** that the app downloads on first run.

The official AutoDoc builds point at Duet-operated services for these. **Those
services are not free infrastructure for forks or rebuilds.** If you build
AutoDoc yourself, you should stand up your own equivalents. This guide shows how.

> [!IMPORTANT]
> Only the official AutoDoc release pipeline sets `AUTODOC_OFFICIAL_BUILD=1`.
> Local and fork builds leave it unset, which makes the app default to
> self-hosted services. If you don't configure the variables below, the related
> features (calendar OAuth, downloadable runtimes) are simply disabled rather
> than silently using Duet's services.

---

## Configuration overview

All configuration is via environment variables, documented in
[`.env.example`](../.env.example). The distribution logic lives in
[`src/main/services/distribution-config.ts`](../src/main/services/distribution-config.ts).

| Variable | Purpose | Required for |
|----------|---------|--------------|
| `AUTODOC_AUTH_WORKER_URL` | URL of your calendar OAuth worker | Google/Microsoft calendar |
| `AUTODOC_MACOS_WHISPER_RUNTIME_ASSET_BASE_URL` | Base URL hosting the macOS Whisper runtime bundle | macOS transcription runtime download |
| `AUTODOC_WINDOWS_TRANSCRIPTION_ASSET_BASE_URL` | Base URL hosting the Windows transcription bundle | Windows transcription runtime download |
| `AUTODOC_OFFICIAL_BUILD` | Internal flag for the official pipeline only — leave unset | — |

Core features that need none of the above: recording, transcription (once the
runtime is present), diarization, AI notes (local Ollama), search, and
encryption.

---

## 1. Stand up your own calendar OAuth worker

Calendar integration uses a [Cloudflare Worker](../worker) to exchange OAuth
authorization codes for tokens, so client secrets never ship inside the desktop
binary. The token exchange happens server-side; the worker stores nothing.

### Prerequisites

- A Cloudflare account and [`wrangler`](https://developers.cloudflare.com/workers/wrangler/).
- A Google Cloud OAuth client (for Google Calendar).
- A Microsoft Entra (Azure AD) app registration (for Microsoft Calendar).

### OAuth app setup

Create OAuth apps with these settings. The desktop app listens on a localhost
callback (`http://127.0.0.1:42813`) and your worker handles the provider
redirect.

**Google** ([Google Cloud Console](https://console.cloud.google.com/apis/credentials)):
- Scopes: `https://www.googleapis.com/auth/calendar.events.readonly`, `email`
- Authorized redirect URI: `https://<your-worker-domain>/auth/callback`

**Microsoft** ([Entra app registrations](https://entra.microsoft.com/)):
- Scopes: `Calendars.Read`, `User.Read`, `offline_access`
- Redirect URI: `https://<your-worker-domain>/auth/microsoft/callback`

### Deploy the worker

Set the worker secrets, then deploy:

```bash
cd worker
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put MICROSOFT_CLIENT_ID
wrangler secret put MICROSOFT_CLIENT_SECRET
wrangler deploy
```

Then point your build at it:

```bash
AUTODOC_AUTH_WORKER_URL=https://<your-worker-domain>
```

---

## 2. Host the transcription runtime assets (optional)

On first run, AutoDoc downloads a platform-specific transcription runtime
bundle. To serve your own (e.g. from your own GitHub Releases, R2, or any
static host), point the app at your base URL:

```bash
# macOS
AUTODOC_MACOS_WHISPER_RUNTIME_ASSET_BASE_URL=https://<your-host>/<path>

# Windows
AUTODOC_WINDOWS_TRANSCRIPTION_ASSET_BASE_URL=https://<your-host>/<path>
```

The scripts under [`scripts/`](../scripts) (`prepare:macos-whisper-runtime`,
`prepare:windows-transcription-assets`) produce the bundles that these URLs
should serve.

If you leave these unset on a non-official build, the bundled runtime is used
where available and remote download is disabled.

---

## 3. Build

With your `.env` populated, build as normal:

```bash
npm ci
npm run build:mac
```

See the root [README](../README.md#build-from-source) for full build
prerequisites.

---

## Why this exists

AutoDoc is AGPL-3.0 and genuinely self-hostable, but the project's hosted
services (OAuth worker, release-asset bandwidth, OAuth app quotas) are paid for
by Duet for the official build. Requiring forks to bring their own services
keeps those costs bounded and keeps the open-source distribution honest: you get
the full product, on your own infrastructure, at your own cost.
