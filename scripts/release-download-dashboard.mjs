// Saved reporting definitions. This file never captures events or changes consent.
export const dashboardUrl = 'https://us.posthog.com/project/218998/dashboard/2183745'
export const dashboardName = 'AutoDoc Releases'
export const dashboardDescription =
  'Downloads by route. Update errors are opt-in. Installs are not measured.'

// Asset counters are cumulative. Keep one value per asset on the latest
// observed release day, including its initial count. Same-day refreshes can
// deduplicate unchanged assets; never retain only the newest timestamp.
const snapshots = `github_snapshots AS (
  SELECT toString(properties.app_version) AS version,
    toString(properties.asset_id) AS asset,
    toString(properties.asset_platform) AS platform,
    toString(properties.release_published_at) AS published_at,
    toInt(properties.download_count) AS downloads, timestamp AS observed_at
  FROM events
  WHERE event = 'github_release_download_count'
    AND timestamp >= toDateTime('2026-01-01')
    AND properties.repository = 'DuetDisplay/AutoDoc'
    AND properties.release_draft = false AND properties.release_prerelease = false
    AND properties.asset_kind = 'installer'
    AND properties.asset_platform IN ('macos', 'windows')
    AND match(toString(properties.app_version), '^[0-9]+\\\\.[0-9]+\\\\.[0-9]+$')
), latest_batches AS (
  SELECT version, max(observed_at) AS batch_time FROM github_snapshots GROUP BY version
), current_assets AS (
  SELECT g.version AS version, g.asset AS asset, g.platform AS platform,
    argMax(g.downloads, g.observed_at) AS downloads,
    max(g.published_at) AS published_at
  FROM github_snapshots g JOIN latest_batches b
    ON g.version = b.version AND toDate(g.observed_at) = toDate(b.batch_time)
  GROUP BY g.version, g.asset, g.platform
), releases AS (
  SELECT version, max(published_at) AS published_at FROM current_assets GROUP BY version
), latest AS (
  SELECT version, published_at FROM releases
  ORDER BY toInt(splitByChar('.', version)[1]) DESC,
    toInt(splitByChar('.', version)[2]) DESC,
    toInt(splitByChar('.', version)[3]) DESC LIMIT 1
)`

const updates = `reported_updates AS (
  SELECT toString(properties.previous_version) AS previous_version,
    toString(properties.current_version) AS current_version,
    count(DISTINCT person_id) AS updates
  FROM events
  WHERE event = 'app_updated' AND timestamp >= toDateTime('2026-01-01')
    AND properties.official_build = true AND properties.build_mode = 'production'
    AND toString(properties.current_version) IN (SELECT version FROM releases)
    AND match(toString(properties.previous_version), '^[0-9]+\\\\.[0-9]+\\\\.[0-9]+$')
    AND properties.previous_version != properties.current_version
  GROUP BY previous_version, current_version
)`

const errors = `reported_errors AS (
  SELECT toString(properties.app_version) AS previous_version,
    if(empty(toString(properties.available_version)) OR properties.available_version = 'unknown',
      'Unknown', toString(properties.available_version)) AS current_version,
    count() AS errors
  FROM events
  WHERE event = 'update_download_failed' AND timestamp >= toDateTime('2026-01-01')
    AND properties.official_build = true AND properties.build_mode = 'production'
    AND toString(properties.app_version) IN (SELECT version FROM releases)
  GROUP BY previous_version, current_version
)`

// The production importer emits daily counters, not one event per download.
// Keep only the latest value for a key so re-exports never multiply downloads.
const hosted = `hosted AS (
  SELECT toString(properties.app_version) AS version,
    toString(properties.platform) AS platform,
    toString(properties.asset_key) AS asset,
    toString(properties.day) AS day,
    argMax(toInt(properties.request_count), timestamp) AS downloads
  FROM events
  WHERE event = 'hosted_update_request_count'
    AND timestamp >= toDateTime('2026-01-01')
    AND properties.source = 'r2_update_mirror'
    AND properties.environment = 'production'
    AND properties.asset_kind = 'package' AND properties.request_kind = 'full'
    AND toInt(properties.response_status) = 200
    AND properties.platform IN ('macos', 'windows')
    AND toString(properties.app_version) IN (SELECT version FROM releases)
  GROUP BY version, platform, asset, day
), downloads_by_route AS (
  SELECT version, platform, downloads, 'github' AS route FROM current_assets
  UNION ALL
  SELECT version, platform, downloads, 'updater' AS route FROM hosted
)`

// Use actual observations before 24h / 7d / 14d since publication. Require a
// snapshot within the preceding day and a completed milestone. A missing first
// day is unknown, not zero. These daily observations are not exact-hour counts.
const milestones = `periods AS (
  SELECT 1 AS days UNION ALL SELECT 7 AS days UNION ALL SELECT 14 AS days
), milestone_batches AS (
  SELECT r.version AS version, p.days AS days,
    max(g.observed_at) AS batch_time
  FROM releases r CROSS JOIN periods p
  JOIN github_snapshots g ON r.version = g.version
  JOIN latest_batches b ON r.version = b.version
  WHERE b.batch_time >= addDays(parseDateTimeBestEffort(r.published_at), p.days)
    AND g.observed_at <= addDays(parseDateTimeBestEffort(r.published_at), p.days)
    AND g.observed_at > addDays(parseDateTimeBestEffort(r.published_at), p.days - 1)
  GROUP BY r.version, p.days
), milestone_assets AS (
  SELECT g.version AS version, m.days AS days, g.asset AS asset,
    argMax(g.downloads, g.observed_at) AS downloads
  FROM github_snapshots g JOIN milestone_batches m
    ON g.version = m.version AND toDate(g.observed_at) = toDate(m.batch_time)
      AND g.observed_at <= m.batch_time
  GROUP BY g.version, m.days, g.asset
), milestone_totals AS (
  SELECT version, days, sum(downloads) AS downloads FROM milestone_assets GROUP BY version, days
)`

const context =
  "Derived operational reporting. Data Catalog read scope is unavailable. Lifetime totals use each release's latest observed UTC day and latest value per asset, including unchanged assets deduplicated by same-day ingestion. Downloads are GitHub DMG/EXE files, including legacy Windows updates and repeat downloads. Update success is distinct consenting identities per previous/current version pair; errors are reports, not deduplicated attempts. Only published stable release versions are included. Milestones use the latest observed GitHub batch before 24 hours, 7 days, and 14 days, with at most one day of snapshot lag; missing history and unfinished milestones stay null. Installs are not measured. Route totals add GitHub installers and hosted full-package HTTP 200 responses. Hosted retries and interrupted transfers can count again; partial range responses, polls, and HEADs are excluded. The mirror has no production events before rollout; its observed count is zero. Neither route identifies new people. Opt-in update reports overlap with downloads and are never added to them."

function sql(id, shortId, tile, name, query, display, layout) {
  return {
    id,
    short_id: shortId,
    tile,
    name,
    description: '',
    context,
    query: {
      kind: 'DataVisualizationNode',
      display,
      source: {
        kind: 'HogQLQuery',
        query,
        filters: { dateRange: { date_from: 'all', date_to: null } }
      }
    },
    layouts: { sm: layout }
  }
}

export const insights = [
  sql(
    12634214,
    'AlIqq7GA',
    13264845,
    'All-time',
    `WITH ${snapshots}, ${hosted} SELECT coalesce(sum(downloads), 0) AS downloads FROM downloads_by_route`,
    'BoldNumber',
    { x: 0, y: 0, w: 2, h: 2 }
  ),
  sql(
    12634215,
    'ZLaMCgBq',
    13264846,
    'Latest total',
    `WITH ${snapshots}, ${hosted} SELECT coalesce(sum(downloads), 0) AS downloads FROM downloads_by_route WHERE version = (SELECT version FROM latest)`,
    'BoldNumber',
    { x: 2, y: 0, w: 3, h: 2 }
  ),
  sql(
    12634261,
    'tYGZfi7B',
    13264950,
    'GitHub',
    `WITH ${snapshots} SELECT coalesce(sum(downloads), 0) AS downloads FROM current_assets WHERE version = (SELECT version FROM latest)`,
    'BoldNumber',
    { x: 5, y: 0, w: 3, h: 2 }
  ),
  sql(
    12657058,
    'QR7PZEic',
    13299028,
    'Updater',
    `WITH ${snapshots}, ${hosted} SELECT coalesce(sum(downloads), 0) AS downloads FROM hosted WHERE version = (SELECT version FROM latest)`,
    'BoldNumber',
    { x: 8, y: 0, w: 2, h: 2 }
  ),
  sql(
    12634259,
    'wzHaKj94',
    13264948,
    'Errors',
    `WITH ${snapshots}, ${errors} SELECT sum(errors) AS errors FROM reported_errors`,
    'BoldNumber',
    { x: 10, y: 0, w: 2, h: 2 }
  ),
  sql(
    12634227,
    'xaspEpUk',
    13264866,
    'Downloads by version',
    `WITH ${snapshots}, ${hosted}, version_totals AS (
      SELECT version, sumIf(downloads, platform = 'macos') AS macos,
        sumIf(downloads, platform = 'windows') AS windows,
        sumIf(downloads, route = 'github') AS github,
        sumIf(downloads, route = 'updater') AS updater,
        sum(downloads) AS downloads
      FROM downloads_by_route GROUP BY version
    ) SELECT concat(version, if(version = (SELECT version FROM latest), ' (latest)', '')) AS Version,
      macos AS macOS, windows AS Windows, github AS GitHub, coalesce(updater, 0) AS Updater, downloads AS Total
    FROM version_totals
    ORDER BY toInt(splitByChar('.', version)[1]) DESC,
      toInt(splitByChar('.', version)[2]) DESC, toInt(splitByChar('.', version)[3]) DESC`,
    'ActionsTable',
    { x: 0, y: 2, w: 12, h: 4 }
  ),
  sql(
    12634249,
    'Q9CTgSFd',
    13264930,
    'GitHub downloads after release',
    `WITH ${snapshots}, ${milestones}
    SELECT concat(r.version, if(r.version = (SELECT version FROM latest), ' (latest)', '')) AS Version,
      if(countIf(t.days = 1) > 0, maxIf(t.downloads, t.days = 1), NULL) AS \`1 day\`,
      if(countIf(t.days = 7) > 0, maxIf(t.downloads, t.days = 7), NULL) AS \`1 week\`,
      if(countIf(t.days = 14) > 0, maxIf(t.downloads, t.days = 14), NULL) AS \`2 weeks\`
    FROM releases r LEFT JOIN milestone_totals t ON r.version = t.version
    GROUP BY r.version
    ORDER BY toInt(splitByChar('.', r.version)[1]) DESC,
      toInt(splitByChar('.', r.version)[2]) DESC, toInt(splitByChar('.', r.version)[3]) DESC`,
    'ActionsTable',
    { x: 0, y: 6, w: 6, h: 4 }
  ),
  sql(
    12634262,
    'Ws7QXZn4',
    13264951,
    'Update results (opt-in)',
    `WITH ${snapshots}, ${updates}, ${errors}, results AS (
      SELECT previous_version, current_version, updates, 0 AS errors FROM reported_updates
      UNION ALL
      SELECT previous_version, current_version, 0 AS updates, errors FROM reported_errors
    ) SELECT previous_version AS From, current_version AS To,
      sum(updates) AS Updated, sum(errors) AS Errors
    FROM results GROUP BY previous_version, current_version
    ORDER BY current_version = 'Unknown', current_version DESC, previous_version DESC`,
    'ActionsTable',
    { x: 6, y: 6, w: 6, h: 4 }
  )
]

export const retiredTiles = [
  13265050, 13264863, 13264864, 13264779, 13264865, 13264947, 13264949, 13265051, 13265052
]
