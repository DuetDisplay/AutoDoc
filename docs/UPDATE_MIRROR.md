# Public update mirror and aggregate release reporting (AD-158)

Implementation branch starts at `origin/1.3.0` (`0878672`). Rollout is disabled
until the hosting and release settings below are configured. Internal builds,
prereleases, QA, and self-hosted builds retain their existing feeds. No client
identifier or installation ping is added. Existing app analytics remains opt-in.

## Hosting

Use the Duet Cloudflare account `845df9423020aef6c50697467a04e353`:

| Resource            | Production              | Staging                         |
| ------------------- | ----------------------- | ------------------------------- |
| Worker              | `autodoc-updates`       | `autodoc-updates-staging`       |
| R2 bucket (private) | `autodoc-updates`       | `autodoc-updates-staging`       |
| D1 database         | `autodoc-update-counts` | `autodoc-update-counts-staging` |

The Worker serves only `stable/latest.yml`, `stable/latest-mac.yml`, and allowed
EXE/ZIP release paths. Packages stream from R2; full GETs may use Cloudflare's
Cache API. Counters run on every served request, including cache hits. Manifests
are never cached. Full, partial, HEAD, 304 and invalid-range responses have
separate buckets. Health checks, unknown paths and administrative exports do
not increment download counts. Counting failures do not stop delivery; totals
can therefore undercount. Requests are not deduplicated into people or installs.

Request invocation logs, traces, preview URLs, and Logpush are disabled for this
Worker. Application logs contain fixed error categories only. Cloudflare still
processes connection information for serving/security; these counters do not
store it. Do not enable request logging, analytics client IDs, or person profiles
for this service. The R2 bucket must remain private so traffic uses the Worker.

## Deploy and enable

1. `npm ci --ignore-scripts --prefix update-worker`; log into the Duet account
   with Wrangler or provide a scoped Cloudflare API token.
2. Create the bucket and D1 database separately for each environment. Record
   their database IDs in `update-worker/wrangler.jsonc`. Wrangler can also
   provision missing resource IDs interactively. Use Standard R2 storage.
3. In `update-worker/`, apply migrations with
   `npx wrangler d1 migrations apply COUNTS --remote` (staging) or add
   `--env production` for production.
4. Set a random secret of at least 32 characters with
   `npx wrangler secret put COUNTS_EXPORT_TOKEN`, separately in each environment.
5. Deploy staging with `npm run deploy:staging`. Test fixture packages only in
   staging. Export can be checked with `--dry-run`; the importer rejects staging
   uploads. Remove fixture packages and counters after testing.
6. Configure a production custom domain, for example `updates.getautodoc.com`,
   as a custom-domain route in the production config. Verify ownership before
   adding it. Production `workers.dev` is disabled; deploy only after the custom
   route and real resource IDs are present. `npm run deploy:production`.
7. Create bucket-scoped R2 S3 write credentials for release CI and a GitHub
   environment named `update-mirror-production`. Use approval protection if
   desired. Never put secrets in repository files.
8. Set GitHub repository variables `CLOUDFLARE_ACCOUNT_ID`,
   `UPDATE_MIRROR_ORIGIN` (HTTPS origin, no path), and `UPDATE_MIRROR_ENABLED=true`.
   In environment `update-mirror-production`, set
   `UPDATE_MIRROR_R2_ACCESS_KEY_ID` and `UPDATE_MIRROR_R2_SECRET_ACCESS_KEY`.
   Store the production `COUNTS_EXPORT_TOKEN` separately in environment
   `update-counts-production`, restricted to the `main` branch. The hosted
   counts job uses that environment and does not receive upload credentials.
   Existing PostHog ingestion key/host secrets are reused.
9. Run **Publish stable update mirror** for an existing published stable release
   with `apply=false` first, then `apply=true`. CI downloads signed GitHub assets,
   checks both manifests' version/SHA-512/size, streams multipart uploads using
   AWS CLI, verifies the complete remote bytes, and publishes manifests last.
   Existing package keys are immutable. Newer feeds cannot be downgraded.
10. Verify a real signed Mac and Windows client against staging, including a
    complete download, signature checks and installation. These installation
    checks require the respective OS and signed release packages; parsing a
    manifest alone does not verify installation.
11. Publish this repository's privacy clarification to the website privacy
    page before cutover. This branch changes `PRIVACY.md`, not the website repo.
12. Set `AUTODOC_PUBLIC_UPDATE_FEED_URL=<origin>/stable/` in release CI for the
    transition release. Older installed versions obtain it from GitHub once,
    then use the mirror for later updates. Direct website/repository installers
    keep GitHub links. Verify the production report with real traffic after
    release. Do not generate synthetic downloads on production.

The shared publishing workflow handles tag builds (GITHUB_TOKEN release creation
does not trigger another workflow), manually published drafts, and recovery
runs. A single concurrency group serializes all stable publications. AWS CLI v2
must be available on the publishing runner. Normal tag builds reuse CI artifacts
to avoid adding replication downloads to GitHub's counters. Manually published
drafts and recovery runs fetch GitHub assets; those replication downloads also
appear in GitHub's aggregate counts and cannot be removed from GitHub afterward.
Never run independent publication or
retention operations concurrently with CI. The feed is configurable, rather than
hard-coded, to allow staged rollout and self-hosted distribution.

## Retention and rollback

`node scripts/prune-update-mirror.mjs` previews deletion and reclaimable bytes;
add `--apply` to delete. It keeps both manifests' active versions, the previous
published version, manifest-referenced packages, and explicit `--keep=VERSION`
versions. Other known releases become eligible **24 hours after replacement**,
not 24 hours after upload. Successful publication saves replacement timestamps
under `retention/superseded/`; unknown history and newer versions are retained.
A failed manifest advancement never starts the old release's grace period.
Incomplete multipart uploads older than 24 hours are aborted during cleanup.
Publication cleans eligible files before its storage check and after success.
The **Clean old update packages** workflow also runs daily, sharing the production
publication concurrency group. Its manual mode defaults to preview.

Before any package upload, CI checks all bucket objects, outstanding multipart
parts, and incoming packages/manifests against `UPDATE_MIRROR_MAX_STORAGE_BYTES`
(default **8,000,000,000 bytes** for production). Staging uses its separate
`UPDATE_MIRROR_STAGING_MAX_STORAGE_BYTES` (default **2,000,000,000 bytes**).
A retry reuses existing immutable packages. Exceeding the limit fails CI with
current, incoming, projected, and limit bytes in an error annotation and the run
summary; no new package is uploaded and the active feed remains unchanged.
The check reserves room for temporary manifest/retention writes as well.
Concurrent external writes are unsupported; keep publication and maintenance
serialized. These are per-bucket limits, not Cloudflare billing caps or an
account-wide free-tier guarantee. Counters are retained independently of files;
Worker, D1, and request usage can still incur charges.

For rollback, pause mirror publication and restore **both** archived manifests
(`releases/vVERSION/latest*.yml`) to `stable/`, with the corresponding package
metadata. Verify their referenced packages first. This explicit rollback bypasses
the publisher's downgrade guard. Do not replace package bytes under an immutable
URL. To abandon the mirror for clients already released, serve manifests pointing
to the original GitHub assets; changing CI settings only affects future builds.

If advancement fails after one platform changes, the publisher attempts to restore
the prior manifest/metadata. A process killed between the two platform writes
cannot make them atomic: alert on CI failures, check both stable manifests, and
retry or restore both. Every manifest is advanced only after **both platforms'
packages** are verified, so a split-version feed still refers to verified bytes.

## Reporting

[Private release dashboard](https://us.posthog.com/project/218998/dashboard/2183745)
is accessible in a browser on desktop, tablet, and phone with project access.
It contains eight panels: all-time downloads, latest-version downloads,
GitHub downloads to latest, updater downloads to latest, update error reports,
downloads by platform, GitHub release milestones, and opted-in update results.
Descriptions and explanatory text cards are intentionally empty. Definitions
and layout IDs are saved in `scripts/release-download-dashboard.mjs` and
`docs/UPDATE_MIRROR_DASHBOARD.json`. No public sharing link is enabled.

The latest version is selected by numeric version order from published stable
GitHub releases. No release tag is hardcoded. The existing download-counts
workflow refreshes the source daily (scheduled at 04:30 UTC, subject to GitHub
Actions scheduling delay); the next snapshot picks up newly published versions.
The mirrored route starts reporting once production hosting and its importer
are enabled. All three latest-version cards then switch to the same release.

**Latest downloads = GitHub installer downloads + mirrored updater downloads.**
The all-time card uses the same two routes across versions. The Downloads by
platform table keeps one row per version and shows macOS via GitHub, Windows via GitHub, macOS via updater, Windows via updater, and Total.
Updater platform comes from validated package metadata. Consented update
reports overlap with downloads and are never added to these totals.

GitHub counters are cumulative. Use each release's latest observed UTC day,
then the latest value per asset, including initial counter values. Same-day
imports deduplicate unchanged assets, so using only the newest timestamp would
incorrectly drop an unchanged Mac or Windows count. Only assets observed on
that latest release day participate; stale assets from older days are excluded.
Do not sum daily cumulative snapshots or subtract the first count. Lifetime
totals remain lifetime totals under dashboard date overrides. On October 8,
1.2.0 reconciled with GitHub: 22 DMG + 86 EXE = 108 downloads. All six stable
releases sum to 580 before production mirror reporting begins.

GitHub installer downloads are a discovery proxy, not a count of new users.
They include repeat downloads, manual upgrades, and legacy Windows updates.
Legacy Mac updater ZIPs, metadata, models, runtimes, drafts, and prereleases
are excluded from this installer metric. The mirror metric counts full-package
HTTP 200 responses for published stable releases. Requests may include retries
or interrupted transfers; range responses, HEADs, manifest polls, and error
responses are excluded. The app disables differential updater downloads, so
its ordinary updater path requests full packages. A manually fetched mirrored
package still counts on the updater route. Neither route confirms installs.
There is no exact new-user or fleet-adoption count.

Mirrored counters use the latest snapshot per UTC request day, asset, version,
and platform before summing. The importer re-exports the last 30 days with
deterministic IDs, no person profiles, and no GeoIP enrichment. Repeated exports
must not multiply counts. At this revision the repository has no mirror-enabled
variable and no hosted production events. The requested card shows zero
observed mirror downloads and is preconfigured to populate after rollout; this
is not a retrospective zero for legacy updater traffic. The missing taxonomy
fields are expected before the first production import, and match the validated
`buildHostedEvents` contract. Reconcile that first real import against D1 before
relying on the mirror portion of the combined totals.

GitHub release comparisons have cumulative **1 day, 1 week, and 2 weeks**
columns. Cutoffs are 24 hours, 7 days, and 14 days after publication. Use the
last actual snapshot before each cutoff, with at most 24 hours of snapshot lag.
These are observed daily counts, not exact hourly totals; for 1.2.0 the snapshots
are about 18–19 hours before the cutoffs. Missing history and milestones that
have not elapsed show a dash rather than zero. On October 8 the observed
1.2.0 milestone counts were 10, 45, and 75, compared with 5, 33, and 50 for
1.1.3. The comparison intentionally measures the GitHub installer route, rather
than mixing future mirror updates into the discovery comparison.

Update successes come from consented `app_updated` reports, deduplicated by
person and previous/current version pair. Errors come from consented
`update_download_failed` reports; that event also includes check errors and can
be reported again after a Settings remount, so the metric is error **reports**,
not unique failed attempts. Queries require official production builds and
published stable destination versions (or running versions for error reports).
Unknown error targets remain Unknown and are never assigned to the latest
version. Opted-in update results remain in their own table and do not measure
people who declined analytics.

Existing `app_updated` and `daily_active` events provide consented context only.
They exclude internal/prerelease builds and cannot represent fleet adoption.
Canonical Data Catalog access was unavailable during implementation; these
reports are explicitly derived operational metrics.

## Testing and cleanup

`npm run test:update-mirror` exercises the actual Workers runtime, local R2/D1,
byte ranges, cache hits, conditional responses, manifest version changes,
protected exports, counter failures, checksum tampering, both electron-updater
platform providers, publication order/retries/rollback, fixture upload guards,
and retention. State lives in fresh OS temporary directories and is removed in
`finally`. Fixtures never go to live PostHog. Run the updater tests and type checks
as well; the verification workflow runs on Mac and Windows.

The permanent staging bucket, database, Worker, and CI credentials remain
available for future tests. Remove staging test packages, counter rows, and
local test profiles after verification. Earlier scratch resources with the
suffix `ad158-test` have been removed. Never delete production counters for
test cleanup. Record cleanup evidence in the test report. Production dashboard
validation reads existing events only.


## Staging end-to-end verification (no public release)

The existing **Build & Release** workflow now accepts `staging_test_version`.
Use manual dispatch with `release_platform=all`, no `release_tag`, and the exact
test branch/ref. It builds the requested version from that commit, signs both
platforms through the existing signing paths, disables Sentry/PostHog keys,
and publishes CI artifacts to the staging bucket through the same mirror
publisher. No GitHub release or public tag is created. The stable production
mirror job is excluded. Existing release-account restrictions still apply.

Configure `UPDATE_MIRROR_STAGING_ORIGIN` as a repository variable and provision
staging R2/D1/Worker first. In GitHub environment `update-mirror-staging`, use
bucket-scoped staging credentials under `UPDATE_MIRROR_R2_ACCESS_KEY_ID` and
`UPDATE_MIRROR_R2_SECRET_ACCESS_KEY`; never reuse production bucket credentials.
Set `CLOUDFLARE_ACCOUNT_ID` as the repository variable. Export access uses a
separate staging `COUNTS_EXPORT_TOKEN` Worker secret. Production stays disabled.

For example, dispatch version `1.3.0`, download both packages from staging,
verify signatures/checksums, and launch using separate install locations and
profiles on this Mac and DuetXPS. Then dispatch `1.3.1` and prove the running
older clients discover, download, install, and relaunch into it. Preserve existing
user installations and profiles. Check version and UI after relaunch, not just
manifest parsing or a successful download. Record exact commits, CI run IDs,
signed artifact hashes, staging URLs, startup/update logs, and screenshots.

Reconcile both clients' requests with staging D1 and the authenticated export.
Full package downloads must show the correct destination version and platform;
polls/ranges/HEADs remain separate. Exercise the importer with `--dry-run` only
(staging uploads to production PostHog are rejected). This establishes hosting
and exporter counts; production dashboard ingestion still requires a real
production import after rollout. Do not relabel staging exports as production.

The mirror workflow's manual `staging_version` and `build_run_id` inputs can
reuse artifacts from an already completed signed test build. Use the matching
`release_tag=staging-vVERSION`. An optional `staging_storage_limit_bytes=1`
with `apply=true` verifies the CI failure annotation and summary without
advancing the working staging feed or uploading packages. The override applies
only to staging. Afterwards rerun with the normal limit and verify recovery.

Test retention with multiple small staging fixtures as well as the signed
packages. Verify active/previous/recent replacements stay and eligible older
files are removed. Once both platform checks and count reconciliation pass,
remove all disposable staging packages, counters, caches/resources, and test
profiles; retain the evidence report. No synthetic events enter the live
PostHog project. Avoid fetching public GitHub release assets for this test so
its replication downloads do not add to GitHub's production asset counts.
