# PR Regression Suite

The PR suite is the deterministic regression layer we expect to run on every pull request and locally before merging risky product changes.

## Commands

- `npm run test:pr:onboarding`
  Covers deterministic onboarding renderer tests, dependency-install manager tests, and the Electron onboarding E2E suite.
- `npm run test:pr:recording`
  Covers recording controls, upcoming meetings, recordings list refresh, and recording/detection service behavior.
- `npm run test:pr:processing`
  Covers transcription, segmentation, dependency progress/retry flows, startup recovery, and meeting-detail processing UI.
- `npm run test:pr:ai`
  Covers Ask AI, search, speaker rename, meeting-detail transcript interactions, and local AI service logic.
- `npm run test:pr:settings`
  Covers settings persistence, calendar lifecycle in settings/app shell, runtime info surfaces, and prefs/token behavior.
- `npm run test:pr`
  Runs the full PR regression suite in the same order as GitHub Actions.

## When To Run

- Run the scoped command for the area you are actively changing while you iterate.
- Run `npm run test:pr` before opening or updating a pull request that changes product behavior.
- GitHub Actions runs the same buckets on every `pull_request` via [pr-regression.yml](/Volumes/DuetDrive/Repos/AutoDocLocal/.github/workflows/pr-regression.yml:1).

## Notes

- The PR suite is intentionally deterministic. It does not depend on real OAuth, real OS permission prompts, or live dependency downloads.
- The onboarding bucket is the only PR job that currently needs a macOS runner because it launches the compiled Electron app through Playwright.
