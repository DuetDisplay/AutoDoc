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
   Set secrets `UPDATE_MIRROR_R2_ACCESS_KEY_ID`,
   `UPDATE_MIRROR_R2_SECRET_ACCESS_KEY`, and `COUNTS_EXPORT_TOKEN` (the production
   export secret; scheduled counts workflow reads the repository secret).
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
add `--apply` to delete. It keeps current manifests' versions, the preceding
version, any manifest-referenced package, explicit `--keep=VERSION` versions,
newer prefixes, and all packages uploaded within 30 days. This grace period
protects pending downloads. Keep any additional supported rollback/pinned paths
explicitly. There is no automatic deletion schedule. Old counters are small and
remain independent of package retention. Account-wide allowances and Worker,
D1 and R2 operations determine cost; pruning storage alone cannot promise $0.

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
It contains seven panels: all-time downloads, latest-version downloads,
reported updates to latest, update error reports, downloads by version, a
release-age comparison, and update results showing previous/target versions.
Panel descriptions and explanatory text cards are intentionally empty. The
short dashboard description labels the measurement limits. Definitions and
layout IDs are saved in `scripts/release-download-dashboard.mjs` and
`docs/UPDATE_MIRROR_DASHBOARD.json`. No public sharing link is enabled.

Download totals are lifetime GitHub Mac/Windows installer counters. The latest
full snapshot batch for each published stable release supplies current asset
membership; each asset is counted once, including its initial counter value.
Daily cumulative snapshots must never be summed or have their first count
subtracted from a lifetime total. The latest release is selected by numeric
version order. Dashboard date overrides do not turn lifetime totals into a
recent-period count. Version 1.2.0 was reconciled with GitHub on October 8:
22 DMG + 86 EXE = 108 downloads; all six stable releases sum to 580.

GitHub installers include repeat downloads, manual upgrades, and legacy Windows
auto-updates. Mac updater ZIPs, metadata, models, transcription runtimes, drafts,
and prereleases are excluded from these installer totals. Downloads are not
confirmed installs. Do not add app update reports to downloads to infer installs.

Update successes come from consented `app_updated` reports, deduplicated by
person and previous/current version pair. Errors come from consented
`update_download_failed` reports; that event also includes check errors and can
be reported again after a Settings remount, so the metric is error **reports**,
not unique failed attempts. Both queries require official production builds and
published stable release versions. Unknown error targets remain Unknown and
are never attributed to the latest version. These metrics do not measure
everyone who declined analytics. There is no fleet install count.

Release comparisons match UTC day since publication to the latest release's
latest observation. They use cumulative snapshots including the first count,
not daily changes. Only actual observations appear; missing history is not
invented. Daily snapshots cannot reconstruct exact hourly adoption. On day 17,
1.2.0 had 108 observed installer downloads versus 53 for 1.1.3.

Hosted `hosted_update_request_count` snapshots remain available for operational
diagnostics after rollout. They count HTTP requests, including retries and
partial transfers, and are not installation or successful-update reports.
They are intentionally absent from this business dashboard. The importer
re-exports the last 30 days with deterministic IDs, no person profiles, and no
GeoIP enrichment. It uses request day rather than ingestion time.

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

Temporary remote test resources use the suffix `ad158-test` and must be emptied
and removed after hosted verification. They are never production resources and
must never be configured in release CI. Record cleanup evidence in the test
report. Production dashboard validation reads existing events only.
