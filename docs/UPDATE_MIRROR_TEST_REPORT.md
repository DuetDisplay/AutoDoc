# AD-158 implementation verification

Date: 2026-10-07. Branch: `codex/ad-158-update-mirror`.
Base: `origin/1.3.0`, commit `0878672e047b19a6dc0b74fa107aa04b5e2acaa0`.
Implementation is in its own managed worktree; the original dirty checkout is
unchanged.

## Passed

- 14 mirror tests, including real Workers runtime with isolated R2, D1 and cache;
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
- October 8 dashboard revision: seven saved insights execute successfully
  against real data, with no warnings. All-time totals remain the same under
  a seven-day dashboard override. No snapshot sums or baseline subtraction.
  Every displayed version total matches the GitHub API: 108, 230, 100, 7, 89,
  and 46; total 580. The version table's platform sums match its totals.
- Four opted-in 1.1.3 → 1.2.0 update reporters and two error reports from 1.1.3
  are verified against real records. Errors with unknown targets stay Unknown.
  Internal builds and unpublished/prerelease version reports are excluded.
- Daily release-age comparison verified at UTC release day 17: 1.2.0 = 108,
  1.1.3 = 53. This does not claim exact hourly counts or fleet installations.
- Existing GitHub snapshot workflow was run to refresh real public source
  counters: run 37789629179 succeeded. This is legitimate production data,
  not synthetic testing. No test events were uploaded or production counts reset.
- Verbose notes and HTTP diagnostics were removed from this dashboard only.
  Underlying saved insights and source events remain available.

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

The connector tools then disappeared; Wrangler 4.148.0 also reports an expired
CLI token. No remote test Worker was deployed and no fixture packages, tables,
or counter rows were written. Hosted smoke verification and removal of these
empty resources remain pending restored access. After login, from `update-worker/`:

```sh
npx wrangler r2 bucket delete autodoc-updates-ad158-test
npx wrangler d1 delete autodoc-update-counts-ad158-test --skip-confirmation
```

These names are isolated from production and staging rollout configuration.
Do not reset production counters or delete legitimate PostHog events to clean
up a test.

## Not yet verified or enabled

- Live hosted package delivery and real S3 multipart upload against R2.
- Signed/notarized Mac installation and signed Windows installation. Local
  manifest/provider tests do not establish installation success. The new CI
  matrix runs automated tests on both operating systems after push; it has not
  run during this local task.
- Production custom domain, resources, CI credentials and feed cutover.
- Publishing the privacy clarification to the separate website repository.

See [rollout/runbook](UPDATE_MIRROR.md) and the
[private dashboard](https://us.posthog.com/project/218998/dashboard/2183745).
