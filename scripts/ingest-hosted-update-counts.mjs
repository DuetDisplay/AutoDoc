import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFile } from 'node:fs/promises'

const FIELDS = [
  'day',
  'asset_key',
  'app_version',
  'platform',
  'architecture',
  'asset_kind',
  'request_kind',
  'response_status',
  'release_published_at',
  'request_count',
  'last_seen_at'
]
export function buildHostedEvents(payload) {
  if (payload.environment !== 'production')
    throw new Error('Only production counters may be uploaded to PostHog')
  if (!Array.isArray(payload.rows) || !Number.isFinite(Date.parse(payload.observed_at)))
    throw new Error('Invalid export')
  return payload.rows.map((row) => {
    if (
      FIELDS.some((field) => row[field] == null) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(row.day) ||
      !/^\d+\.\d+\.\d+$/.test(row.app_version) ||
      !['macos', 'windows'].includes(row.platform) ||
      !['arm64', 'x64', 'universal', 'unknown'].includes(row.architecture) ||
      !['package', 'manifest'].includes(row.asset_kind) ||
      !['full', 'range', 'head'].includes(row.request_kind) ||
      !Number.isSafeInteger(row.request_count) ||
      row.request_count < 0 ||
      !Number.isInteger(row.response_status) ||
      row.response_status < 200 ||
      row.response_status > 599 ||
      !/^(stable\/latest(?:-mac)?\.yml|releases\/v\d+\.\d+\.\d+\/(?:AutoDoc|autodoc)-[A-Za-z0-9._-]+\.(zip|exe))$/.test(
        row.asset_key
      ) ||
      !Number.isFinite(Date.parse(row.release_published_at)) ||
      !Number.isFinite(Date.parse(row.last_seen_at))
    ) {
      throw new Error('Invalid aggregate row')
    }
    const identity = [
      row.day,
      row.asset_key,
      row.app_version,
      row.request_kind,
      row.response_status
    ].join(':')
    return {
      event: 'hosted_update_request_count',
      timestamp: payload.observed_at,
      distinct_id: `update-aggregate:${identity}`,
      properties: {
        ...Object.fromEntries(FIELDS.map((f) => [f, row[f]])),
        source: 'r2_update_mirror',
        environment: 'production',
        ingested_at: payload.observed_at,
        $process_person_profile: false,
        $geoip_disable: true,
        $insert_id: createHash('sha256').update(`${identity}:${row.request_count}`).digest('hex')
      }
    }
  })
}

export async function main(args = process.argv.slice(2)) {
  if (args.some((arg) => arg !== '--dry-run')) throw new Error('Only --dry-run is supported')
  const dryRun = args.includes('--dry-run')
  if (process.env.HOSTED_COUNTS_JSON_FILE && !dryRun)
    throw new Error('Fixture input requires --dry-run; no test upload allowed')
  let payload
  if (process.env.HOSTED_COUNTS_JSON_FILE)
    payload = JSON.parse(await readFile(process.env.HOSTED_COUNTS_JSON_FILE))
  else {
    const origin = new URL(process.env.UPDATE_MIRROR_ORIGIN)
    if (
      origin.protocol !== 'https:' ||
      origin.pathname !== '/' ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash
    ) {
      throw new Error('Invalid update mirror origin')
    }
    const end = new Date(),
      start = new Date(end.getTime() - 30 * 86400000)
    const url = new URL('/admin/counts', origin)
    url.searchParams.set('from', start.toISOString().slice(0, 10))
    url.searchParams.set('to', end.toISOString().slice(0, 10))
    const secret = process.env.COUNTS_EXPORT_TOKEN
    if (!secret || secret.length < 32) throw new Error('Missing COUNTS_EXPORT_TOKEN')
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(60000),
      redirect: 'error'
    })
    if (!response.ok) throw new Error(`Counter export failed (${response.status})`)
    payload = await response.json()
  }
  if (payload.environment !== 'production' && dryRun)
    return console.log(`Staging export: ${payload.rows?.length ?? 0} rows; upload disabled`)
  const events = buildHostedEvents(payload)
  console.log(
    `Prepared ${events.length} daily aggregate snapshots${dryRun ? '; upload disabled' : ''}`
  )
  if (dryRun || !events.length) return
  const key = process.env.POSTHOG_PROJECT_API_KEY || process.env.VITE_POSTHOG_KEY
  if (!key) throw new Error('Missing PostHog project API key')
  const host = new URL(
    process.env.POSTHOG_HOST || process.env.VITE_POSTHOG_HOST || 'https://us.i.posthog.com'
  )
  if (host.protocol !== 'https:' || host.username || host.password)
    throw new Error('PostHog host must use HTTPS')
  for (let i = 0; i < events.length; i += 50) {
    const response = await fetch(new URL('/batch/', host), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: key, batch: events.slice(i, i + 50) }),
      signal: AbortSignal.timeout(60000),
      redirect: 'error'
    })
    if (!response.ok) throw new Error(`PostHog upload failed (${response.status})`)
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
