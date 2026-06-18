#!/usr/bin/env node

/* eslint-disable @typescript-eslint/explicit-function-return-type */

const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com'
const DEFAULT_REPO = 'DuetDisplay/AutoDoc-Local'
const EVENT_NAME = 'github_release_download_count'
const BATCH_SIZE = 50

function parseArgs(argv) {
  const options = {
    dryRun: false,
    includeDrafts: false,
    releaseTag: process.env.RELEASE_TAG || '',
    repo: process.env.GITHUB_REPOSITORY || DEFAULT_REPO
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--dry-run') {
      options.dryRun = true
      continue
    }
    if (arg === '--include-drafts') {
      options.includeDrafts = true
      continue
    }
    if (arg === '--release-tag') {
      options.releaseTag = requireValue(argv, index, arg)
      index += 1
      continue
    }
    if (arg === '--repo') {
      options.repo = requireValue(argv, index, arg)
      index += 1
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }

  options.repo = normalizeRepo(options.repo)
  options.releaseTag = options.releaseTag.trim()
  return options
}

function requireValue(argv, index, arg) {
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) {
    throw new Error(`${arg} requires a value`)
  }
  return value
}

function normalizeRepo(repo) {
  const normalized = repo
    .trim()
    .replace(/^https:\/\/github\.com\//, '')
    .replace(/\.git$/, '')
  if (!/^[^/\s]+\/[^/\s]+$/.test(normalized)) {
    throw new Error(`Invalid repository "${repo}". Expected owner/name.`)
  }
  return normalized
}

function getPostHogConfig() {
  return {
    apiKey: process.env.POSTHOG_PROJECT_API_KEY || process.env.VITE_POSTHOG_KEY || '',
    host: normalizePostHogHost(
      process.env.POSTHOG_HOST || process.env.VITE_POSTHOG_HOST || DEFAULT_POSTHOG_HOST
    )
  }
}

function normalizePostHogHost(host) {
  return host.trim().replace(/\/+$/, '') || DEFAULT_POSTHOG_HOST
}

async function fetchJson(url, token) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'AutoDoc-download-count-ingest',
    'X-GitHub-Api-Version': '2022-11-28'
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }

  const response = await fetch(url, { headers })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`GitHub request failed (${response.status}) for ${url}: ${body}`)
  }
  return response.json()
}

function getFixtureReleases() {
  const rawFixture = process.env.GITHUB_RELEASES_JSON
  if (!rawFixture) return null

  const parsed = JSON.parse(rawFixture)
  return Array.isArray(parsed) ? parsed : [parsed]
}

async function fetchReleases(repo, releaseTag) {
  const fixtureReleases = getFixtureReleases()
  if (fixtureReleases) {
    return releaseTag
      ? fixtureReleases.filter((release) => release.tag_name === releaseTag)
      : fixtureReleases
  }

  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''
  if (releaseTag) {
    const url = `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(releaseTag)}`
    return [await fetchJson(url, token)]
  }

  const releases = []
  for (let page = 1; page <= 10; page += 1) {
    const url = `https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`
    const pageReleases = await fetchJson(url, token)
    releases.push(...pageReleases)
    if (pageReleases.length < 100) break
  }
  return releases
}

function classifyAsset(assetName) {
  const name = assetName.toLowerCase()
  if (name.endsWith('.yml') || name.endsWith('.yaml') || name.endsWith('.blockmap'))
    return 'metadata'
  if (name.endsWith('.sha256') || name.endsWith('.sha512') || name.endsWith('.sig'))
    return 'metadata'
  if (name.endsWith('.dmg') || name.endsWith('.pkg')) return 'installer'
  if (name.endsWith('.exe') || name.endsWith('.msi')) return 'installer'
  if (name.endsWith('.appimage') || name.endsWith('.deb') || name.endsWith('.rpm'))
    return 'installer'
  if (name.endsWith('-mac.zip') || name.includes('update') || name.endsWith('.nupkg'))
    return 'updater'
  if (name.endsWith('.zip')) return 'archive'
  return 'other'
}

function inferPlatform(assetName) {
  const name = assetName.toLowerCase()
  if (name.includes('mac') || name.endsWith('.dmg') || name.endsWith('.pkg')) return 'macos'
  if (
    name.includes('win') ||
    name.endsWith('.exe') ||
    name.endsWith('.msi') ||
    name.endsWith('.nupkg')
  ) {
    return 'windows'
  }
  if (
    name.includes('linux') ||
    name.endsWith('.appimage') ||
    name.endsWith('.deb') ||
    name.endsWith('.rpm')
  ) {
    return 'linux'
  }
  return 'unknown'
}

function versionFromTag(tagName) {
  return String(tagName || '').replace(/^v/i, '') || 'unknown'
}

function buildEvents(releases, repo, includeDrafts) {
  const ingestedAt = new Date().toISOString()
  const events = []

  for (const release of releases) {
    if (!release || (!includeDrafts && release.draft)) continue

    const assets = Array.isArray(release.assets) ? release.assets : []
    for (const asset of assets) {
      if (!asset || typeof asset.name !== 'string') continue

      const assetKind = classifyAsset(asset.name)
      const releaseTag = release.tag_name || 'unknown'
      events.push({
        distinct_id: `github-release-asset:${repo}:${asset.id || asset.name}`,
        event: EVENT_NAME,
        timestamp: ingestedAt,
        properties: {
          source: 'github_releases',
          repository: repo,
          app_version: versionFromTag(releaseTag),
          release_tag: releaseTag,
          release_id: release.id,
          release_name: release.name || releaseTag,
          release_draft: Boolean(release.draft),
          release_prerelease: Boolean(release.prerelease),
          release_published_at: release.published_at || null,
          asset_id: asset.id,
          asset_name: asset.name,
          asset_kind: assetKind,
          asset_platform: inferPlatform(asset.name),
          asset_content_type: asset.content_type || null,
          asset_size: Number(asset.size || 0),
          asset_download_url: asset.browser_download_url || null,
          download_count: Number(asset.download_count || 0),
          ingested_at: ingestedAt
        }
      })
    }
  }

  return events
}

async function sendPostHogBatch(host, apiKey, events) {
  const url = `${host}/batch/`
  for (let index = 0; index < events.length; index += BATCH_SIZE) {
    const batch = events.slice(index, index + BATCH_SIZE)
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, batch })
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`PostHog batch failed (${response.status}): ${body}`)
    }
  }
}

function summarize(events) {
  const totals = new Map()
  for (const event of events) {
    const version = event.properties.release_tag
    const current = totals.get(version) || {
      assets: 0,
      downloads: 0,
      installerDownloads: 0,
      updaterDownloads: 0
    }
    current.assets += 1
    current.downloads += event.properties.download_count
    if (event.properties.asset_kind === 'installer') {
      current.installerDownloads += event.properties.download_count
    }
    if (event.properties.asset_kind === 'updater') {
      current.updaterDownloads += event.properties.download_count
    }
    totals.set(version, current)
  }

  return [...totals.entries()].sort(([left], [right]) => right.localeCompare(left))
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const posthog = getPostHogConfig()
  const releases = await fetchReleases(options.repo, options.releaseTag)
  const events = buildEvents(releases, options.repo, options.includeDrafts)
  const summary = summarize(events)

  if (!events.length) {
    console.log('[download-counts] No release assets found to ingest.')
    return
  }

  console.log(
    `[download-counts] Prepared ${events.length} asset snapshots from ${releases.length} release(s).`
  )
  for (const [version, totals] of summary) {
    console.log(
      `[download-counts] ${version}: ${totals.downloads} total downloads across ${totals.assets} assets ` +
        `(${totals.installerDownloads} installer, ${totals.updaterDownloads} updater).`
    )
  }

  if (options.dryRun) {
    console.log('[download-counts] Dry run enabled; skipping PostHog upload.')
    return
  }

  if (!posthog.apiKey) {
    throw new Error('Missing POSTHOG_PROJECT_API_KEY or VITE_POSTHOG_KEY.')
  }

  await sendPostHogBatch(posthog.host, posthog.apiKey, events)
  console.log(`[download-counts] Sent ${events.length} ${EVENT_NAME} event(s) to ${posthog.host}.`)
}

main().catch((error) => {
  console.error(`[download-counts] ${error.message}`)
  process.exit(1)
})
