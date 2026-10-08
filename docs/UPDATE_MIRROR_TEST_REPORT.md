# AD-158 implementation verification

Date: 2026-10-07. Branch: `codex/ad-158-update-mirror`.
Base: `origin/1.3.0`, commit `0878672e047b19a6dc0b74fa107aa04b5e2acaa0`.
Implementation is in its own managed worktree; the original dirty checkout is
unchanged.

## Passed

- 19 mirror tests, including real Workers runtime with isolated R2, D1 and cache;
  full/range/suffix/open-ended responses, invalid/multiple ranges, conditional
  responses, HEAD, fresh manifests, cached downloads, auth/date export checks,
  and continued delivery during a counting failure.
- Publication checks: both platform manifests resolve through the real
  electron-updater GenericProvider; package integrity/version/path checks;
  verified packages precede manifests; retries preserve immutable packages;
  old versions cannot advance stable; injected publication failure restores
  the already-advanced platform.
- Fixture upload guards for both event families, profile/GeoIP suppression,
  aggregate field allowlisting, snapshot insertion IDs, and retention protections.
- 20 auto-updater tests, including official public stable configuration,
  internal/prerelease/QA/unofficial/Linux behavior, HTTPS validation and the
  existing download/install trigger behavior.
- TypeScript checks for main/preload, renderer, and the new update Worker.
- ESLint on changed application, Worker and script code.
- Actionlint on all changed workflows.
- Production Electron/Vite compilation using an isolated example feed setting;
  the feed URL is present in the compiled main bundle. The app was not launched
  and no analytics were emitted. Existing bundle-splitting warnings remain.
- October 8 dashboard revision: eight saved insights execute successfully
  against real data, with no warnings. All-time totals remain the same under
  a seven-day dashboard override. No snapshot sums or baseline subtraction. Latest route cards reconcile as 108 GitHub + 0 observed mirror = 108 total.
  Every displayed version total matches the GitHub API: 108, 230, 100, 7, 89,
  and 46; total 580. The version table's platform sums match its totals.
- Four opted-in 1.1.3 → 1.2.0 update reporters and two error reports from 1.1.3
  are verified against real records. Errors with unknown targets stay Unknown.
  Internal builds and unpublished/prerelease version reports are excluded.
- GitHub milestone comparison verified for 1 day / 1 week / 2 weeks: 1.2.0 = 10 / 45 / 75 and 1.1.3 = 5 / 33 / 50. Snapshot timestamps are before the exact cutoffs; lag is recorded in the runbook. Version 1.1.0 has no first-day history and returns null, not zero. This does not claim exact hourly counts or fleet installations.
- Existing GitHub snapshot workflow was run to refresh real public source
  counters: run 37789629179 succeeded. This is legitimate production data,
  not synthetic testing. No test events were uploaded or production counts reset.
- Read-only inline calculation fixtures verified that a same-day Windows refresh retains an unchanged Mac count (22 + 86 = 108) and excludes a retired asset from an older day. Mirror fixtures verified latest-counter deduplication across repeated exports, platforms, and days; ranges, HEADs, and HTTP failures are excluded (expected total 15). No fixture events were captured.
- Platform table revision: the saved Downloads by platform query returns six versions with separate macOS/Windows GitHub/updater columns. Each row's four counts sum to Total (null for the absent Windows 1.0.0 installer contributes zero); totals remain 108, 230, 100, 7, 89, and 46. Updater platform is read from package metadata and exported by the existing importer. Verification only read production data; no test events were captured.
- Mirror query event/property names match the production importer contract. Taxonomy warnings from exploratory SQL are expected because hosted reporting has not launched; all eight saved dashboard queries return without query warnings. The first production mirror import still needs a D1 reconciliation.
- Verbose notes and HTTP diagnostics were removed from this dashboard only.
  Underlying saved insights and source events remain available.

## October 8 staging preparation

- Storage budget includes incoming packages/manifests, current bucket objects,
  and outstanding multipart parts. Insufficient budget blocks before package
  writes or feed advancement. CI emits an error annotation and summary.
- Retention now uses a 24-hour replacement grace, keeps active/previous/manual
  versions, and retains unknown history. Successful cutover timestamps are
  recorded once; retries do not extend the grace. Expired multipart cleanup is
  covered. Publication and daily cleanup share a concurrency group per bucket.
- Signed staging CI uses artifacts only: no public tag or release, a staging
  feed baked into the app, and empty production analytics keys. Mac and DuetXPS
  must still complete the real install/relaunch and hosted statistics checks.
- Windows preflight is running in the separate AD-158 Windows update
  verification chat on DuetXPS. The Mac and Windows signed CI builds passed. Device installation/update checks are still pending; DuetXPS is currently disconnected.

## Cleanup and reporting integrity

Local test packages, D1 rows, R2 objects and caches are created in fresh temporary
directories and deleted in `finally`, including failures. Final inspection found
no remaining fixture/state directories. No synthetic events were uploaded to
the live PostHog project, and no production download endpoint was exercised.
Dashboard validation only reads existing events; its saved insights/notes are
configuration, not test analytics data.

Cloudflare's connector briefly worked and created these **empty** remote test
resources in the Duet account (`845df9423020aef6c50697467a04e353`):

- R2: `autodoc-updates-ad158-test`
- D1: `autodoc-update-counts-ad158-test`, ID
  `4328a07b-e672-4f57-8106-31cc38d49048`

Wrangler authentication was restored on October 8. Both empty scratch resources
were deleted successfully; neither contained test downloads or counter rows.
Permanent staging R2/D1 resources were provisioned separately and migrations
applied. The staging Worker health check and authenticated empty export passed.
Production R2/D1 resources are provisioned and empty; the production Worker
and custom domain remain undeployed pending the device tests.

Both GitHub environments now contain the two bucket-scoped R2 upload secrets.
The count export credential is stored separately in `update-counts-production`.
Signed staging CI run `37806999215` built and verified both platforms; the Mac
build passed signing/notarization and Windows signing verification. The initial
upload failed before credentials were saved; only that upload job was rerun.
No public GitHub release or tag was created.

The upload retry succeeded through the permanent staging environment credentials.
CI verified both remote package hashes before advancing either manifest. Initial
storage was zero; incoming/reserved bytes were 541,140,369 under the 2 GB limit.
The Mac package downloaded from the Worker is 414,112,381 bytes, matching SHA-512
`3eKE/XoYyFdPr1p/QDeowaSJWtokcVjm9oMOl7sGVsanrUNFNzDjvzxjPldhpIQFp0w1tRR27nCj0HyGVqagPQ==`.
`codesign --verify --deep --strict` passed; Gatekeeper accepted the extracted app
as Notarized Developer ID. The exact signed bundle launched from a disposable
path/profile, rendered onboarding, and checked the baked-in staging feed.
It correctly found no update when running 1.3.0 against the 1.3.0 manifest.

Live staging counters reconciled after two full Mac downloads, one HEAD and one
32-byte range request: package full/200 = 2, head/200 = 1, range/206 = 1.
The repeated full response matched the original package checksum, and range
bytes matched the package prefix. Manifest polls appeared separately. The real
hosted importer fetched four staging rows and refused production upload in
`--dry-run` mode. None of these requests changed the production dashboard. The hosted Windows
1.3.0 EXE also matched its 127,023,976-byte manifest size and SHA-512, and the
exporter recorded it under platform Windows. That fetch ran on this Mac; it is
not a substitute for Windows installation/launch on DuetXPS. The extracted Mac
app contains the staging feed and no baked PostHog project key or Sentry DSN.

Second signed build `37810508326` built and verified 1.3.1 from the same app
commit `9bf589d69c3205aca2dbd22f375cd22193572d4d`. Both signing paths passed.
The one-byte staging budget caused the upload to fail before package writes:
current 541,138,321 bytes; incoming/reserved 541,139,949 bytes; projected
1,082,278,270 bytes; limit 1 byte. CI reported these values in an error annotation.
Both stable manifest bodies remained byte-for-byte unchanged, and the new
Windows package was absent (HEAD 404). The staging budget was restored to
2,000,000,000 bytes and only the failed upload was rerun. Normal-limit recovery
passed using the same signed artifacts. CI advanced both staging manifests only
after remote checksum verification. The temporary feature-branch signing
allowance was removed after both signed builds finished. Two local CLI checks
verified retention skips a not-yet-published feed and refuses cleanup when only
one stable manifest exists. These used a temporary AWS stub, no live writes.

The Mac native update from 1.3.0 to 1.3.1 passed through `quitAndInstall` and
Squirrel.Mac. The updater fetched the staging ZIP (414,111,945 bytes), and its
SHA-512 matched the manifest. The bundle changed to 1.3.1 and relaunched as PID
62104 from the disposable install path; its About dialog visibly showed 1.3.1.
A disposable profile marker survived the update. Post-update strict/deep signature
verification and Gatekeeper assessment passed (Notarized Developer ID). The
exporter recorded exactly one Mac 1.3.1 full/200 package request. Test launch
variables were restored, only the test app processes stopped, the original Mac
ShipIt cache restored, and the test app/profile/home/cache removed. Screenshots
and safe logs remain as evidence. Windows native install/update remains pending.

These names are isolated from production and staging rollout configuration.
Do not reset production counters or delete legitimate PostHog events to clean
up a test.

## Not yet verified or enabled

- Windows native installation/update on DuetXPS and final staging cleanup. XPS downloaded 1.3.0 from staging and verified its checksum and valid Duet Authenticode signature; moving/restoring its registered install is in progress.
- Windows signed installer launch and native upgrade. CI signing and notarization are verified, but they do not establish native installation success.
- Production Worker/custom-domain deployment and feed cutover. Resources and permanent CI credentials are prepared.
- Publishing the privacy clarification to the separate website repository.

See [rollout/runbook](UPDATE_MIRROR.md) and the
[private dashboard](https://us.posthog.com/project/218998/dashboard/2183745).
