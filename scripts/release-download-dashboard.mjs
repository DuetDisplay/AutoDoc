// Reproducible PostHog definitions. No events or person records are created by this file.
// Query controls are native SQL variables; dashboard dates use UTC daily buckets.
export const dashboardUrl = 'https://us.posthog.com/project/218998/dashboard/2183745'
export const variables = {
  '01a11890-2ff1-0000-87c1-4c9ed866f173': {
    code_name: 'autodoc_download_version',
    variableId: '01a11890-2ff1-0000-87c1-4c9ed866f173',
    value: 'all'
  },
  '01a11890-381e-0000-a5bd-e45c413fb43a': {
    code_name: 'autodoc_download_platform',
    variableId: '01a11890-381e-0000-a5bd-e45c413fb43a',
    value: 'all'
  }
}
const github = `github_daily AS (
  SELECT toDate(timestamp) AS day, toString(properties.asset_id) AS asset,
    toString(properties.app_version) AS version, toString(properties.asset_platform) AS platform,
    toString(properties.asset_kind) AS asset_kind,
    argMax(toInt(properties.download_count), timestamp) AS total,
    max(timestamp) AS observed_at, min(toString(properties.release_published_at)) AS published_at
  FROM events
  WHERE event = 'github_release_download_count' AND timestamp >= toDateTime('2026-01-01')
    AND timestamp <= {filters.dateRange.to}
    AND properties.repository = 'DuetDisplay/AutoDoc'
    AND properties.asset_kind IN ('installer', 'updater')
    AND properties.release_draft = false AND properties.release_prerelease = false
    AND ({variables.autodoc_download_version} = 'all' OR properties.app_version = {variables.autodoc_download_version})
    AND ({variables.autodoc_download_platform} = 'all' OR properties.asset_platform = {variables.autodoc_download_platform})
  GROUP BY day, asset, version, platform, asset_kind
), github_lag AS (
  SELECT *, row_number() OVER (PARTITION BY asset ORDER BY day) AS observation,
    lagInFrame(total, 1, 0) OVER (PARTITION BY asset ORDER BY day ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS previous,
    lagInFrame(day, 1, day) OVER (PARTITION BY asset ORDER BY day ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS previous_day
  FROM github_daily
), github_deltas AS (
  SELECT *, if(observation = 1, NULL, greatest(total - previous, 0)) AS downloads,
    if(observation > 1 AND total < previous, 1, 0) AS reset,
    if(observation > 1 AND dateDiff('day', previous_day, day) > 1, 1, 0) AS gap
  FROM github_lag
), hosted_daily AS (
  SELECT toDate(properties.day) AS day, toString(properties.asset_key) AS asset,
    toString(properties.app_version) AS version, toString(properties.platform) AS platform,
    toString(properties.asset_kind) AS asset_kind, toString(properties.request_kind) AS request_kind,
    toInt(properties.response_status) AS status,
    argMax(toInt(properties.request_count), timestamp) AS requests,
    max(timestamp) AS observed_at, min(toString(properties.release_published_at)) AS published_at
  FROM events
  WHERE event = 'hosted_update_request_count' AND timestamp >= toDateTime('2026-01-01') AND timestamp <= now()
    AND properties.environment = 'production' AND properties.source = 'r2_update_mirror'
    AND ({variables.autodoc_download_version} = 'all' OR properties.app_version = {variables.autodoc_download_version})
    AND ({variables.autodoc_download_platform} = 'all' OR properties.platform = {variables.autodoc_download_platform})
  GROUP BY day, asset, version, platform, asset_kind, request_kind, status
)`
const range = 'day >= toDate({filters.dateRange.from}) AND day <= toDate({filters.dateRange.to})'
const packages = "asset_kind = 'package' AND request_kind = 'full' AND status = 200"
const githubLifetime = github.replace('timestamp <= {filters.dateRange.to}', 'timestamp <= now()')
const context =
  'Derived operational report. GitHub uses latest daily asset snapshots then nonnegative observed deltas; first observation is a baseline and resets/gaps are flagged. Hosted uses latest daily counter snapshot per asset/version/request/status. Counts represent requests/downloads, never unique users or installed versions. Data Catalog read scope was unavailable; no canonical metric claim.'
function sql(name, description, query, display = 'ActionsTable', chartSettings) {
  return {
    name,
    description,
    query: {
      kind: 'DataVisualizationNode',
      display,
      source: {
        kind: 'HogQLQuery',
        query,
        filters: { dateRange: { date_from: '-30d', date_to: null } },
        variables
      },
      ...(chartSettings ? { chartSettings } : {})
    },
    context
  }
}
const line = {
  xAxis: { column: 'day' },
  yAxis: [{ column: 'count', settings: { formatting: { style: 'number', decimalPlaces: 0 } } }],
  showNullsAsZero: false
}
export const insights = [
  sql(
    'GitHub installer asset downloads',
    'Observed increase in GitHub DMG/EXE counts. Includes manual upgrades/reinstalls and legacy Windows updater traffic during migration. First snapshots establish baselines.',
    `WITH ${github} SELECT if(count(downloads) = 0, NULL, sum(downloads)) AS downloads FROM github_deltas WHERE ${range} AND asset_kind = 'installer' HAVING count() > 0`,
    'BoldNumber'
  ),
  sql(
    'Hosted full package requests',
    'Full GET responses (200) for updater packages. Requests may include retries and interrupted transfers; they do not confirm installation. Empty until production rollout.',
    `WITH ${github} SELECT sum(requests) AS requests FROM hosted_daily WHERE ${range} AND ${packages} HAVING count() > 0`,
    'BoldNumber'
  ),
  sql(
    'Hosted range requests',
    'Successful partial GET responses (206), shown separately because multiple ranges can fetch one package.',
    `WITH ${github} SELECT sum(requests) AS requests FROM hosted_daily WHERE ${range} AND asset_kind = 'package' AND request_kind = 'range' AND status = 206 HAVING count() > 0`,
    'BoldNumber'
  ),
  sql(
    'Update manifest polls',
    'Manifest GET/HEAD requests, separate from package downloads. These are not unique clients or installations.',
    `WITH ${github} SELECT sum(requests) AS polls FROM hosted_daily WHERE ${range} AND asset_kind = 'manifest' HAVING count() > 0`,
    'BoldNumber'
  ),
  sql(
    'GitHub installer downloads by day',
    'Increases are attributed to the snapshot observation day. Missing snapshot days can shift attribution; first observations are excluded.',
    `WITH ${github} SELECT day, if(count(downloads) = 0, NULL, sum(downloads)) AS count FROM github_deltas WHERE ${range} AND asset_kind = 'installer' GROUP BY day ORDER BY day`,
    'ActionsLineGraph',
    line
  ),
  sql(
    'Hosted full package requests by day',
    'Latest cumulative snapshot per UTC day and counter key; repeated imports are not summed.',
    `WITH ${github} SELECT day, sum(requests) AS count FROM hosted_daily WHERE ${range} AND ${packages} GROUP BY day ORDER BY day`,
    'ActionsLineGraph',
    line
  ),
  sql(
    'Delivery totals by version and platform',
    'GitHub installer assets and legacy updater ZIPs + hosted full requests form a delivery proxy, not unique users or confirmed installs. GitHub EXEs can include legacy Windows updater traffic. Hosted blanks mean no reporting yet.',
    `WITH ${github}, deliveries AS (
      SELECT version, platform, asset_kind, sum(downloads) AS github_downloads, NULL AS hosted_requests FROM github_deltas WHERE ${range} GROUP BY version, platform, asset_kind
      UNION ALL
      SELECT version, platform, 'package' AS asset_kind, NULL AS github_downloads, sum(requests) AS hosted_requests FROM hosted_daily WHERE ${range} AND ${packages} GROUP BY version, platform
    ) SELECT version, platform, sumIf(github_downloads, asset_kind = 'installer') AS github_installer_asset_downloads,
      sumIf(github_downloads, asset_kind = 'updater') AS github_legacy_updater_zip_downloads, if(count(hosted_requests) = 0, NULL, sum(hosted_requests)) AS hosted_full_requests,
      if(count(hosted_requests) = 0 OR count(github_downloads) = 0, NULL, sum(github_downloads) + sum(hosted_requests)) AS combined_delivery_proxy
    FROM deliveries GROUP BY version, platform ORDER BY version DESC, platform`
  ),
  sql(
    'First seven days after release',
    'Observed GitHub download increases and hosted full package requests during each release’s first seven UTC days. Uses release lifetime rather than the selected date window. Missing GitHub baselines undercount.',
    `WITH ${githubLifetime}, first_week AS (
      SELECT version, platform, asset_kind, sum(downloads) AS github_downloads, NULL AS hosted_requests FROM github_deltas
      WHERE day >= toDate(published_at) AND day < toDate(published_at) + INTERVAL 7 DAY GROUP BY version, platform, asset_kind
      UNION ALL
      SELECT version, platform, 'package' AS asset_kind, NULL AS github_downloads, sum(requests) AS hosted_requests FROM hosted_daily
      WHERE ${packages} AND day >= toDate(published_at) AND day < toDate(published_at) + INTERVAL 7 DAY GROUP BY version, platform
    ) SELECT version, platform, sumIf(github_downloads, asset_kind = 'installer') AS github_installer_asset_downloads,
      sumIf(github_downloads, asset_kind = 'updater') AS github_legacy_updater_zip_downloads, if(count(hosted_requests) = 0, NULL, sum(hosted_requests)) AS hosted_full_requests
      FROM first_week GROUP BY version, platform ORDER BY version DESC, platform`
  ),
  sql(
    'GitHub reporting coverage',
    'First-observation baselines, counter resets, and gaps between snapshots. Gaps make daily attribution approximate; values are observed increases, not reconstructed history.',
    `WITH ${github} SELECT version, platform, sum(if(observation = 1, 1, 0)) AS new_baselines,
      sum(reset) AS counter_resets, sum(gap) AS snapshot_gaps, max(observed_at) AS last_snapshot
      FROM github_deltas WHERE ${range} GROUP BY version, platform ORDER BY version DESC, platform`
  ),
  sql(
    'Hosted request outcomes',
    'Response status counts for known package/manifest objects, including invalid ranges. Delivery failures before asset lookup and lost counter writes are outside these counts.',
    `WITH ${github} SELECT asset_kind, request_kind, status, sum(requests) AS requests
      FROM hosted_daily WHERE ${range} GROUP BY asset_kind, request_kind, status ORDER BY asset_kind, request_kind, status`
  ),
  sql(
    'Reporting freshness',
    'Latest real ingestion timestamp for each source. Hosted rows appear after production reporting begins. Daily import schedule: 04:30 UTC.',
    `SELECT event AS source, max(timestamp) AS last_ingestion FROM events WHERE timestamp >= now() - INTERVAL 90 DAY
      AND ((event = 'github_release_download_count' AND properties.repository = 'DuetDisplay/AutoDoc')
      OR (event = 'hosted_update_request_count' AND properties.environment = 'production')) GROUP BY event`
  ),
  sql(
    'Confirmed updates — opted-in sample only',
    'Distinct consenting app identities reporting app_updated. This observes only the opt-in sample; it cannot measure total adoption.',
    `SELECT count(DISTINCT person_id) AS opted_in_update_reporters FROM events WHERE event = 'app_updated' AND {filters}
      AND properties.official_build = true AND properties.build_mode = 'production' AND NOT match(toString(properties.current_version), '-')
      AND ({variables.autodoc_download_version} = 'all' OR properties.current_version = {variables.autodoc_download_version})
      AND ({variables.autodoc_download_platform} = 'all' OR properties.app_platform = if({variables.autodoc_download_platform} = 'macos', 'darwin', 'win32'))`,
    'BoldNumber'
  ),
  sql(
    'Active versions — opted-in sample only',
    'Distinct consenting daily_active app identities by version. A person using multiple versions can appear in multiple rows; this is not fleet adoption.',
    `SELECT toString(properties.app_version) AS version, count(DISTINCT person_id) AS opted_in_active_reporters FROM events
      WHERE event = 'daily_active' AND {filters} AND properties.official_build = true AND properties.build_mode = 'production'
      AND NOT match(toString(properties.app_version), '-')
      AND ({variables.autodoc_download_version} = 'all' OR properties.app_version = {variables.autodoc_download_version})
      AND ({variables.autodoc_download_platform} = 'all' OR properties.app_platform = if({variables.autodoc_download_platform} = 'macos', 'darwin', 'win32'))
      GROUP BY version ORDER BY opted_in_active_reporters DESC`
  )
]
