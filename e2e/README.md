# E2E Notes

## Running Electron E2E

These Playwright specs launch the Electron app directly. In Codex/Desktop or any similarly sandboxed environment, Electron launch may fail with `Process failed to launch!` or `SIGABRT` unless the command is allowed to run outside the sandbox.

Recommended commands:

```bash
npm run test:e2e -- e2e/qa-repro.spec.ts -g "AD-65 keeps onboarding moving through speech engine setup failures"
npm run test:e2e -- e2e/onboarding-journey.spec.ts -g "Whisper"
```

If Electron launch fails before assertions:

1. Re-run the same command with outside-sandbox / GUI approval enabled.
2. Verify a minimal Electron app can launch before treating the failure as an AutoDoc regression.

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
