# E2E Notes

## Running Electron E2E

These Playwright specs launch the Electron app directly. In Codex/Desktop or any similarly sandboxed environment, Electron launch may fail with `Process failed to launch!` or `SIGABRT` unless the command is allowed to run outside the sandbox.

Recommended commands:

```bash
npm run test:e2e -- e2e/qa-repro.spec.ts -g "AD-65 keeps onboarding moving through speech engine setup failures"
npm run test:e2e -- e2e/onboarding-journey.spec.ts -g "Whisper"
npm run test:smoke:mac:microphone
AUTODOC_RUN_PACKAGED_MACOS_WHISPER_RUNTIME_TEST=1 AUTODOC_PACKAGED_APP_PATH=/abs/path/to/AutoDoc.app npm run test:e2e -- e2e/macos-packaged-whisper-runtime.spec.ts
```

If Electron launch fails before assertions:

1. Re-run the same command with outside-sandbox / GUI approval enabled.
2. Verify a minimal Electron app can launch before treating the failure as an AutoDoc regression.

## AD-60 real macOS verification

`npm run test:smoke:mac:microphone` is the host-machine repro for the Tahoe microphone-list bug.

What it does:

- launches a packaged `AutoDoc.app`
- drives onboarding to `Enable Microphone` with macOS UI scripting
- clicks the microphone CTA
- reads the real per-user macOS TCC database for `com.kairos.autodoc`

Why this exists:

- the isolated Playwright/Electron QA spec can prove the app asked for permission
- only a real macOS host can prove whether TCC actually registered AutoDoc in the microphone privacy state

Useful environment variables:

- `AUTODOC_TCC_APP_BUNDLE=/abs/path/to/AutoDoc.app`
- `AUTODOC_TCC_RESET=1` to reset microphone permission first
- `AUTODOC_TCC_RESET_APP_DATA=1` to start with clean onboarding state
- `AUTODOC_TCC_OPEN_SETTINGS=1` to open `Privacy > Microphone` after the click

## AD-65 coverage

`e2e/qa-repro.spec.ts` contains the strongest ticket-focused repro harness for `AD-65`.

What it simulates:

- Whisper setup enters a persistent `error` state during onboarding.
- Retry attempts continue to fail.

What the current branch should do:

- Show the recovery copy (`Still finishing transcription setup`).
- Keep the background continue path available.
- Allow onboarding to advance while setup continues in the background.

Why this matters:

- On the pre-fix `v0.1.19` transcription step, an error removed the background continue affordance (`showSkip && !error`) and only exposed a manual retry path.
- On the current branch, the same injected failure condition is expected to remain recoverable.

## AD-70 legacy comparison

`e2e/ad-70-delete-repro.spec.ts` can compare the current branch against a prepared legacy app tree.

Useful environment variables:

- `AUTODOC_E2E_LEGACY_APP_ROOT=/abs/path/to/legacy/source-tree`

Notes:

- The legacy comparison is skipped unless `AUTODOC_E2E_LEGACY_APP_ROOT` is set.
- The path should point at a source tree with `out/main/index.js` already built, not a packaged `.app` bundle.
