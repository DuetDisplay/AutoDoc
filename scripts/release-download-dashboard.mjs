// Saved reporting definitions. This file never captures events or changes consent.
export const dashboardUrl = 'https://us.posthog.com/project/218998/dashboard/2183745'
export const dashboardName = 'AutoDoc Releases'
export const dashboardDescription =
  'Lifetime downloads. Update reports are opt-in. Installs are not measured.'

// Asset counters are cumulative. Use one latest release batch and one row per
// asset, including the initial count. Never sum daily counter snapshots.
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
    ON g.version = b.version AND g.observed_at = b.batch_time
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

// Match UTC release-day age using actual cumulative observations. This is a
// daily comparison, not reconstructed counts at an exact elapsed second.
const age = `release_age AS (
  SELECT dateDiff('day', toDate(published_at),
    toDate(toString((SELECT max(observed_at) FROM github_snapshots
      WHERE version = (SELECT version FROM latest))))) AS days
  FROM latest
), same_age_assets AS (
  SELECT version, asset, argMax(downloads, observed_at) AS downloads
  FROM github_snapshots
  WHERE dateDiff('day', toDate(published_at), toDate(toString(observed_at)))
    <= (SELECT days FROM release_age)
  GROUP BY version, asset
)`

const context =
  'Derived operational reporting. Data Catalog read scope is unavailable. Lifetime totals use the latest full release batch, de-duplicated per asset. Downloads are GitHub DMG/EXE files, including legacy Windows updates and repeat downloads. Update success is distinct consenting identities per previous/current version pair; errors are reports, not deduplicated attempts. Only published stable release versions are included. Same-age comparison uses UTC release days and actual snapshots, not exact-time reconstruction. Installs are not measured. Hosted HTTP request counts are not added to installs or updates.'

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
    'All-time downloads',
    `WITH ${snapshots} SELECT sum(downloads) AS downloads FROM current_assets`,
    'BoldNumber',
    { x: 0, y: 0, w: 3, h: 2 }
  ),
  sql(
    12634215,
    'ZLaMCgBq',
    13264846,
    'Latest version downloads',
    `WITH ${snapshots} SELECT sum(downloads) AS downloads FROM current_assets WHERE version = (SELECT version FROM latest)`,
    'BoldNumber',
    { x: 3, y: 0, w: 3, h: 2 }
  ),
  sql(
    12634261,
    'tYGZfi7B',
    13264950,
    'Updates to latest (opt-in)',
    `WITH ${snapshots}, ${updates} SELECT sum(updates) AS updates FROM reported_updates WHERE current_version = (SELECT version FROM latest)`,
    'BoldNumber',
    { x: 6, y: 0, w: 3, h: 2 }
  ),
  sql(
    12634259,
    'wzHaKj94',
    13264948,
    'Update errors (opt-in)',
    `WITH ${snapshots}, ${errors} SELECT sum(errors) AS errors FROM reported_errors`,
    'BoldNumber',
    { x: 9, y: 0, w: 3, h: 2 }
  ),
  sql(
    12634227,
    'xaspEpUk',
    13264866,
    'Downloads by version',
    `WITH ${snapshots}, ${updates}, version_totals AS (
      SELECT version, sumIf(downloads, platform = 'macos') AS macos,
        sumIf(downloads, platform = 'windows') AS windows, sum(downloads) AS downloads
      FROM current_assets GROUP BY version
    ), version_updates AS (
      SELECT current_version, sum(updates) AS updates FROM reported_updates GROUP BY current_version
    ) SELECT concat(v.version, if(v.version = (SELECT version FROM latest), ' (latest)', '')) AS Version,
      v.macos AS macOS, v.windows AS Windows, v.downloads AS Downloads,
      coalesce(u.updates, 0) AS \`Updates (opt-in)\`
    FROM version_totals v LEFT JOIN version_updates u ON v.version = u.current_version
    ORDER BY toInt(splitByChar('.', v.version)[1]) DESC,
      toInt(splitByChar('.', v.version)[2]) DESC, toInt(splitByChar('.', v.version)[3]) DESC`,
    'ActionsTable',
    { x: 0, y: 2, w: 12, h: 4 }
  ),
  sql(
    12634249,
    'Q9CTgSFd',
    13264930,
    'Compare releases',
    `WITH ${snapshots}, ${age}
    SELECT concat(version, if(version = (SELECT version FROM latest), ' (latest)', '')) AS Version,
      (SELECT days FROM release_age) AS \`Day after release\`, sum(downloads) AS Downloads
    FROM same_age_assets GROUP BY version
    ORDER BY toInt(splitByChar('.', version)[1]) DESC,
      toInt(splitByChar('.', version)[2]) DESC, toInt(splitByChar('.', version)[3]) DESC`,
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
