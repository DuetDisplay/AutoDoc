# Windows notes model readiness: implementation and verification

Verified on September 16, 2026. Baseline: `aed1047` on `notes-v2-qwen`.

## Internal release 1.2.0-internal.12 verification

Before release, the fix was integrated onto `7bcddb5`, the source of `internal-v1.2.0.11`. The four upstream commits include independent corrections to the two baseline test expectations and the startup mock described below. The release adds only this Windows notes fix to the current `.11` source.

- [Release service checks](../artifacts/notes-model-verification/release-service-tests.json): **385 passed, zero failed, one skipped**, including startup recovery and the macOS compatibility tests.
- [Release-candidate Playwright checks](../artifacts/notes-model-verification/real-app-release-12.json): **all three passed** in 2.7 minutes. Fresh profiles are `after-normal-release-12`, `after-victor-release-12`, and `after-legacy-release-12`. The normal hardware case again asserts exact equality of transcript, writer notes, and complete V2 notes against the original pre-fix baseline.
- Internal export and build-boundary checks: **25 passed, four skipped**. Main, renderer, and worker TypeScript checks pass, as do the rebuilt application and production/internal build-flavor verification.

The earlier runs below retain the original diagnosis and verification history. Their known test failures are resolved by the upstream corrections in this release candidate. Platform scope and reproduction limits remain as documented below.

## Result

The actual Electron application reproduced Victor's missing-Qwen failure before the change. With the fix, the same controlled scenario finishes notes without sending a generation request for a missing model.

On Chris's actual hardware, the same audio passed through real Parakeet transcription and real Qwen inference before and after the change. The transcript, all six writer notes, and the complete displayed V2 notes match exactly, including text, timestamps, source references, and revisions. This is a regression check for the tested recording, not a guarantee for every recording or machine.

| Application check | Before | After |
| --- | --- | --- |
| Victor: delayed Windows backend resolution, installed 3B, missing Qwen | UI shows **Notes failed**; Qwen requests return the same model-not-found 404 seen in Victor's log | Qwen is prepared before generation; UI shows **Notes ready**; no missing-model generation requests |
| Chris: actual hardware and local models, same speech recording | Transcription and six writer notes complete | Transcript, writer notes, and displayed notes are exactly equal to the baseline |
| Legacy fallback while Qwen finishes downloading | Covered by lifecycle regression tests | First job keeps `llama3.1` for writer, scan, and unload; deletion follows unload; the next job uses Qwen; installed 3B is retained on the simulated hardware |

## Changes

**The new runtime behavior is Windows-only.** Shared service files contain platform guards; macOS and Linux retain the previous cached startup readiness, shared provider, model migration and cleanup timing, chunk retries, scan fallback, and recovery-scan behavior. The new setup-error label remains a shared definition, but the new code paths that produce it run only on Windows. No new macOS policy or model-selection changes are included.

The following changes apply on Windows:

- Windows profile consumers join the initial backend resolution and any pending refresh. A late resolution cannot overwrite a session GPU-to-CPU downgrade. Hardware probe subprocesses have real timeouts rather than a promise timeout that permits a late write.
- Ollama readiness is checked for the preferred model at each job. Preparation returns the active installed model, preserving the existing `llama3.1` migration fallback. Concurrent preparations and downloads for the same model share work. Completed downloads are checked against fresh inventory, and lifecycle cancellation prevents stale approval or cleanup.
- Inventory failures are distinguished from an empty model store during preparation. A temporary server failure must not hide an installed legacy fallback.
- Notes use their own provider. Its model remains fixed throughout a job, including scan requests and unload. Background upgrades can update the interactive provider without changing the active notes job.
- Cleanup waits until the serial notes job finishes. A new job also waits for an already submitted cleanup operation before approving its model. Cleanup rechecks the current preference and retains installed 3B when the existing Windows CPU policy could select it.
- A model-not-found 404 exits chunk retries immediately. The whole job gets one fresh preparation attempt; persistent failure becomes `ollama-model-setup`, with notes-engine guidance and an explicit retry available. Automatic recovery scans do not repeatedly retry that setup failure. Optional scan passes cannot silently swallow this error.
- Existing application logs record preparation decisions, installed model names, active/preferred models, and pull outcomes. No prompt/response capture or extra attempt-history store was added.

Memory thresholds, transcription memory gates, and model-selection policy are unchanged. **This fixes model readiness and lifetime failures; it does not claim to fix insufficient physical RAM.** The separate diagnostic redaction issue is outside this change.

## Verification evidence

The real-app harness is [notes-model-real-app.spec.ts](../e2e/notes-model-real-app.spec.ts). It drives the application with Playwright's Electron support, uses isolated user-data directories, and checks visible notes status and actual request ordering. Runtime files are copied; immutable model weights use hard links; mutable model manifests are copied. Existing user recordings and preferences are not used as test inputs.

Local evidence is in [artifacts/notes-model-verification](../artifacts/notes-model-verification):

- [Before: Victor failure](../artifacts/notes-model-verification/before-victor-list.png), [after: Victor notes](../artifacts/notes-model-verification/after-victor-detail.png).
- [Before: Chris's notes](../artifacts/notes-model-verification/before-normal-detail.png), [after: Chris's notes](../artifacts/notes-model-verification/after-normal-detail.png), and [exact comparison results](../artifacts/notes-model-verification/normal-comparison.json).
- [Final Playwright report after Windows isolation](../artifacts/notes-model-verification/real-app-windows-only.json): **all three scenarios passed in one run**, with no skipped or flaky cases (2.9 minutes). The normal scenario asserts exact equality for transcript, writer notes, and displayed V2 notes.
- Before Victor's authoritative request log: `before-victor-gpu/model-requests.jsonl`; after: `after-victor-windows-only/model-requests.jsonl`.
- Normal-run profiles: `before-normal` and `after-normal-windows-only`. Results are `before-normal-result.json` and `after-normal-result.json`; the latter includes the full V2 notes, compared with `before-normal-notes-v2.json`.
- Legacy lifecycle evidence: `after-legacy-windows-only/model-requests.jsonl`. The recorded order is legacy writer → Qwen pull completes → legacy scan → legacy unload → legacy deletion → next Qwen writer/scan/unload.
- [Focused regressions](../artifacts/notes-model-verification/regression-tests.json): **22 passed**. The first ten tests were run before implementation: nine failed and one passed, exposing both missing readiness behavior and the incorrect profile decisions.
- [Expanded service checks after Windows isolation](../artifacts/notes-model-verification/windows-only-service-tests.json): **376 passed, two failed, one skipped**. Both failures also occur in the [untouched baseline snapshot](../artifacts/notes-model-verification/baseline-existing-tests.json): `persists the real Mac lossless path with full evidence and no scan model calls` and `persists the default Windows lossless path with full evidence and no scan model calls`. Their expected decision/next-step arrays differ from the baseline output; they were not changed to hide the failures.
- All eight [macOS compatibility tests](../src/main/services/__tests__/notes-model-macos-compatibility.test.ts) pass, covering startup caching, standard and low-spec migration, cleanup timing, profile application, job retry behavior, setup-error propagation, scan fallback, and recovery scans. An additional LLM check confirms macOS retains three chunk attempts for a missing-model response while Windows exits after one. These tests exercise the macOS branches through a simulated platform on Windows; a physical Mac was not tested.
- An exploratory startup-scan run also exposed an existing incomplete mock: `getTranscriptionBackend is not a function`. The untouched baseline reproduces it. It is separate from the 379-test expanded run above.
- Main, renderer, and worker TypeScript checks pass. Functional ESLint rules pass on the changed production files and new harness; existing formatting warnings were excluded from that lint invocation. `git diff --check` passes.
- The normal Electron build and production build-flavor verification pass; internal features remain enabled through the normal build.

## Reproduction limits

Chris's normal check used the real 32 GB / 20-logical-processor machine and RTX 4060 Laptop GPU. Approximately 43 seconds of synthesized speech were placed into an isolated recording and processed by the actual transcription and notes pipeline. Microphone capture itself was not tested. The seeded audio produces a playback format error in the UI in both baseline and fixed builds; transcription and notes complete successfully in both. Playback is not claimed as verified.

Victor's profile, initial inventory, detection delay, missing-model response, and download completion are controlled by [the Electron bootstrap](../e2e/helpers/notes-model-bootstrap.cjs). Successful inference goes to the real installed Qwen runtime. The simulation reports 15.3 GiB total memory, 16 logical processors, and an RTX 4050. It does **not** create Victor's actual low-memory pressure: reported free memory is 6 GiB. The legacy lifecycle check routes its simulated `llama3.1` identity to Qwen weights, so it verifies binding and deletion order, not Llama output quality.

These checks run the compiled application in Electron, not a newly packaged installer on Victor's physical machine. Failed harness-development attempts are retained in separate artifact directories; use the authoritative paths above for conclusions.

## Running the app checks again

Close other AutoDoc instances first: the managed runtime uses port 11435. The installed user-data directory must contain Ollama with Qwen, Parakeet, its Python runtime, and FFmpeg. The harness defaults to `%APPDATA%/AutoDoc`; `AUTODOC_NOTES_VERIFY_INSTALLED` can select a different installation. A speech fixture is generated with Windows speech synthesis when absent and reused across before/after runs.

Preserve a baseline compiled `out` directory before changing source. For the baseline pass, point `AUTODOC_NOTES_VERIFY_ENTRY` at its `main/index.js`, set phase `before`, and run the normal and Victor scenarios. In this workspace the saved build is `artifacts/notes-model-verification/before-build`.

After building the fixed source with the normal build command, run from the repository root:

```powershell
$env:AUTODOC_NOTES_VERIFY = '1'
$env:AUTODOC_NOTES_VERIFY_PHASE = 'after'
$env:AUTODOC_NOTES_VERIFY_RUN_SUFFIX = '-review-' + (Get-Date -Format 'yyyyMMddHHmmss')
Remove-Item Env:AUTODOC_NOTES_VERIFY_ENTRY -ErrorAction SilentlyContinue
node node_modules/@playwright/test/cli.js test e2e/notes-model-real-app.spec.ts --workers=1
```

Use a fresh run suffix. The harness rejects existing recording directories so saved outputs cannot make a new test pass. The normal post-fix test requires `before-normal-result.json` and compares the transcript, writer notes, and full displayed notes against the baseline. For the original baseline captured before the V2 assertion was added, it reads `before-normal-notes-v2.json` as well. The comparison from this verification is separately saved in `normal-comparison.json`.
