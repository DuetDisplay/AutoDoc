# Native macOS validation of Jamal recovery changes

Validated 2026-09-17. **The outstanding native downloads and real MLX transcription/notes checks pass on this Apple M2 Mac. No application regression was found. Native section 2d is complete for the tested Apple Silicon source builds.**

## Source and host

- Checkout: AutoDoc-Internal, not AutoDoc-Landing.
- Fixed application source: `be7356ec66dc9f16531859847fda692280a50a58`.
- Original source: `e6cb99ff999d4bec9f6bcf068592adea48f2acf0`, built separately under `/private/tmp/autodoc-macos-validation-20260917/before`.
- Host: Apple M2, arm64, 24 GiB RAM, macOS 26.6.2 (25G83), Node 24.5.0.
- Both used the same installed dependencies and normal production build, including all three TypeScript checks and internal-feature verification. Later commits change tests/documentation only; application code is unchanged.
- The development app was already closed when the user authorized closing it. No AutoDoc/Ollama process or port-11435 listener remained. All real app runs executed serially with separate isolated profiles.

## Automated and native checks

| Check                                                                        | Result                                                                            |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Production build, all three TypeScript checks, both revisions                | Pass                                                                              |
| Full main-process suite on macOS                                             | 1,754 passed, 26 skipped; 128 files passed, 5 skipped                             |
| Full renderer suite on macOS                                                 | 358 passed; 44 files passed                                                       |
| Targeted shared download/onboarding/guard/transcription/deletion/notes tests | 219 passed, 13 skipped                                                            |
| Targeted banner and recordings renderer tests                                | 10 passed                                                                         |
| Native Electron progress tests, Mac and Windows UI fixtures                  | Both pass; zero list scans for 5,000 setup events on fixed build                  |
| Native Electron memory guidance, both UI fixtures                            | Both pass                                                                         |
| Native recording/finalize/video detail/relaunch, abort, device change        | All three pass on original and fixed builds                                       |
| Real clean MLX/Ollama setup and downloads                                    | Pass, approximately 2.6 minutes                                                   |
| Real clean whisper.cpp/Ollama setup and downloads                            | Pass, approximately 3.0 minutes                                                   |
| Real MLX/Qwen single-source, dual-source, retry, subsequent meeting          | All four pass on both revisions; exact transcript, segment, and Notes V2 equality |
| Additional single/dual comparison                                            | Both pass on both revisions; exact equality again                                 |
| Changed-test ESLint, Prettier, git diff --check                              | Pass                                                                              |

Skipped unit cases are not claimed as native runtime coverage. Windows platform fixtures validate guards/UI, not Windows GPU execution on a Mac. The synthetic-event Mac before/after control measured 5,000 recording-list calls on the original build and zero on the fixed build. Banner checks include dismissal through reload and deletion of the final recording.

## Actual download with a populated recordings page

Both runs used a fresh speech-model directory, a valid completed sample meeting, the real Electron renderer/IPC and real network transfer. Each downloaded and validated `ggml-large-v3.bin`, 3,095,033,483 bytes, and reached ready. Existing notes-model/runtime files were copied into these measurement profiles to isolate speech-download activity; the separate clean onboarding tests above downloaded notes assets from scratch.

| Measurement                                                               | Original          | Fixed    |
| ------------------------------------------------------------------------- | ----------------- | -------- |
| Recording-list handler calls started/completed                            | 106,581 / 106,581 | 49 / 49  |
| All setup events                                                          | 106,536           | 108      |
| Model-progress events, including initial phase event                      | 106,530           | 102      |
| Distinct model percentages                                                | 101               | 101      |
| First-to-last model-progress event                                        | 83.238 s          | 82.657 s |
| Total observed measurement window including validation/results collection | 92.392 s          | 98.467 s |
| Ready reached; earlier application log history retained                   | Yes               | Yes      |

The fixed call count is consistent with ordinary two-second recordings-page polling. Transfer time was similar; the change removes repeated work, not network time. Counts were measured at the real `recording:list` handler because the corresponding verbose resolved-log entry is Windows-only. Both Mac runs retained early logs; no Mac log-loss claim is inferred from the Windows report.

The source checkout needed the fallback runtime prepared. The repository's normal `prepare:macos-whisper-runtime` script used isolated copies of the existing Mac runtime as its package prefixes, then verified links, signed the copied binaries, and ran the executable's help check. These tests used that bundled runtime and fresh network-downloaded speech models; they do not claim a runtime-archive download. Prepared test binaries are preserved under the ignored evidence directory, not committed as application changes.

## Real processing comparison

Both revisions used the exact same synthetic speech WebM, `mlx-community/distil-whisper-large-v3`, and `qwen3:4b-instruct` on Metal. Settings and audio were unchanged. Each meeting was started through normal transcription retry IPC, processed by the actual app services, then opened in the UI after a renderer reload. Retry and the subsequent meeting used the same uninterrupted app session. No worker failures or model responses were mocked.

The dual-source case places the same speech on both inputs and exercises echo deduplication. It is not a long multi-speaker benchmark. The fixture SHA-256 is `546be12609373c23396a71c0a3dd035e9cf15f45d35213cb574481eaca4a16e4`.

Elapsed time is measured from processing request to completed notes, not from the fixture's synthetic recording timestamp.

| Case       | Original | Fixed    | Transcript / segments / Notes V2 |
| ---------- | -------- | -------- | -------------------------------- |
| single     | 37.833 s | 38.276 s | Exact match                      |
| dual       | 33.883 s | 32.341 s | Exact match                      |
| retry      | 36.850 s | 28.701 s | Exact match                      |
| subsequent | 29.439 s | 29.335 s | Exact match                      |

Each transcript has ten entries. Single/retry/subsequent cases produce four note items; dual-source produces five. Full structured results, including IDs, timestamps, source references and revisions, compare exactly.

Additional repeat:

| Case   | Original | Fixed    | Transcript / segments / Notes V2 |
| ------ | -------- | -------- | -------------------------------- |
| single | 28.794 s | 38.273 s | Exact match                      |
| dual   | 31.791 s | 32.388 s | Exact match                      |

Runtime memory pressure changed naturally during testing: original first-run cases used `mac-low-spec` under yellow pressure; the fixed build moved from that policy to `mac-normal` as pressure became green. In the repeat, both single-source cases used `mac-normal`; the original dual notes phase saw yellow pressure while the fixed phase remained green. No hardware/profile override was used.

The repeat's approximately 9.5-second single-source difference is accounted for by measured Ollama-readiness wait: 0.336 s original versus 10.116 s fixed. Active transcription stayed essentially equal, 5.562 s versus 5.537 s. The original first run also waited 10.425 s for Ollama, versus 9.978 s fixed, so this wait is not new behavior introduced by the change. These observations do not establish statistical performance equivalence; they show no unexplained processing slowdown in these samples.

## Test corrections and scope

1. `e2e/recording-workflow-regression.spec.ts` hardcoded Windows `ffmpeg.exe` and a Windows UI fixture. It now uses the host platform; committed as `143f0ad0`. The missing Mac ffmpeg dependency was restored with its normal package installation script. All three tests pass on both application revisions.
2. `e2e/onboarding-real-download.spec.ts` expected a backend field that generic macOS whisper.cpp status intentionally omits. It now accepts that optional field while explicitly checking the native executable and GGML model. The initial custom download run reached ready but failed this harness assertion; it was retained as an exploratory run and repeated successfully with fresh assets. The corrected repository clean-download test also passed.

The existing test-mode detection-handler console warning appears on both revisions during real-app UI reloads. The seeded speech fixture is for processing/content comparison, not a media-playback claim; separate native recording tests cover real MediaRecorder output, video detail and relaunch. Intel macOS, signed installer behavior and Jamal's physical Windows GPU are outside this native M2 validation.

## Evidence and cleanup

Local results, screenshots, harnesses and logs are in `artifacts/jamal-macos-validation/`, including `real-comparison.json`, `download-comparison.json`, `before-download-results.json`, `after-download-results.json`, `policy-repeat/real-comparison.json`, and both clean-setup console logs. Model weights and normal-user recordings are not included in the report or commits. Completed isolated profiles were removed after their evidence was saved; normal user recordings/model stores were not edited. The scratch baseline source/build remains under `/private/tmp/autodoc-macos-validation-20260917/before`.

No PR, publication, release or push was performed.
