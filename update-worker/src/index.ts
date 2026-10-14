import { rangeFor } from './http-range'

type AssetKind = 'package' | 'manifest'
type RequestKind = 'full' | 'range' | 'head'

interface Asset {
  key: string
  version: string
  platform: string
  architecture: string
  kind: AssetKind
  publishedAt: string
}

const VERSION = /^\d+\.\d+\.\d+$/
const MAX_EXPORT_ROWS = 10_000

function response(text: string, status: number, headers: HeadersInit = {}): Response {
  return new Response(text, { status, headers: { 'Cache-Control': 'no-store', ...headers } })
}

function objectKey(path: string): string | null {
  // Fixed routes and release filenames only. Queries and arbitrary paths are never stored.
  if (path === '/stable/latest.yml' || path === '/stable/latest-mac.yml') return path.slice(1)
  if (/^\/releases\/v\d+\.\d+\.\d+\/(?:AutoDoc|autodoc)-[A-Za-z0-9._-]+\.(?:zip|exe)$/.test(path)) {
    return path.slice(1)
  }
  return null
}

function assetFromMetadata(
  key: string,
  metadata: Record<string, string> | undefined
): Asset | null {
  if (!metadata || !VERSION.test(metadata.app_version ?? '')) return null
  if (key.startsWith('releases/') && !key.startsWith(`releases/v${metadata.app_version}/`))
    return null
  if (key === 'stable/latest.yml' && metadata.platform !== 'windows') return null
  if (key === 'stable/latest-mac.yml' && metadata.platform !== 'macos') return null
  if (!['macos', 'windows'].includes(metadata.platform)) return null
  if (!['arm64', 'x64', 'universal', 'unknown'].includes(metadata.architecture)) return null
  const published = new Date(metadata.release_published_at)
  if (!Number.isFinite(published.getTime())) return null
  return {
    key,
    version: metadata.app_version,
    platform: metadata.platform,
    architecture: metadata.architecture,
    publishedAt: published.toISOString(),
    kind: key.startsWith('stable/') ? 'manifest' : 'package'
  }
}

function cacheMetadata(asset: Asset, headers: Headers): void {
  headers.set('X-AutoDoc-Version', asset.version)
  headers.set('X-AutoDoc-Platform', asset.platform)
  headers.set('X-AutoDoc-Architecture', asset.architecture)
  headers.set('X-AutoDoc-Published', asset.publishedAt)
}

function assetFromCache(key: string, headers: Headers): Asset | null {
  return assetFromMetadata(key, {
    app_version: headers.get('X-AutoDoc-Version') ?? '',
    platform: headers.get('X-AutoDoc-Platform') ?? '',
    architecture: headers.get('X-AutoDoc-Architecture') ?? '',
    release_published_at: headers.get('X-AutoDoc-Published') ?? ''
  })
}

async function count(env: Env, asset: Asset, kind: RequestKind, status: number): Promise<void> {
  const now = new Date().toISOString()
  try {
    await env.COUNTS.prepare(
      `
      INSERT INTO request_counts
        (day, asset_key, app_version, platform, architecture, asset_kind,
         request_kind, response_status, release_published_at, request_count, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT (day, asset_key, app_version, request_kind, response_status)
      DO UPDATE SET request_count = request_count + 1, last_seen_at = excluded.last_seen_at
    `
    )
      .bind(
        now.slice(0, 10),
        asset.key,
        asset.version,
        asset.platform,
        asset.architecture,
        asset.kind,
        kind,
        status,
        asset.publishedAt,
        now
      )
      .run()
  } catch {
    // Never log requests, headers, URLs, IPs, or exception text that could contain them.
    console.error(JSON.stringify({ event: 'aggregate_count_failed', timestamp: now }))
  }
}

async function authorized(request: Request, secret: string | undefined): Promise<boolean> {
  if (!secret || secret.length < 32) return false
  const supplied = request.headers.get('Authorization') ?? ''
  if (!supplied.startsWith('Bearer ') || supplied.length > 1024) return false
  const encoder = new TextEncoder()
  const expected = await crypto.subtle.digest('SHA-256', encoder.encode(secret))
  const actual = await crypto.subtle.digest('SHA-256', encoder.encode(supplied.slice(7)))
  return crypto.subtle.timingSafeEqual(expected, actual)
}

async function exportCounts(request: Request, env: Env): Promise<Response> {
  if (!(await authorized(request, env.COUNTS_EXPORT_TOKEN))) return response('Unauthorized', 401)
  const url = new URL(request.url)
  const from = url.searchParams.get('from') ?? ''
  const to = url.searchParams.get('to') ?? ''
  const validDay = (value: string): boolean =>
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(new Date(value).getTime()) &&
    new Date(value).toISOString().slice(0, 10) === value
  if (
    !validDay(from) ||
    !validDay(to) ||
    from > to ||
    new Date(to).getTime() - new Date(from).getTime() > 30 * 86_400_000
  ) {
    return response('Provide a valid date window of at most 31 days', 400)
  }
  const { results } = await env.COUNTS.prepare(
    `
    SELECT * FROM request_counts WHERE day >= ? AND day <= ?
    ORDER BY day, asset_key, request_kind, response_status LIMIT ?
  `
  )
    .bind(from, to, MAX_EXPORT_ROWS + 1)
    .all()
  if (results.length > MAX_EXPORT_ROWS) return response('Window too large; export fewer days', 413)
  return response(
    JSON.stringify({
      environment: env.ENVIRONMENT,
      observed_at: new Date().toISOString(),
      rows: results
    }),
    200,
    { 'Content-Type': 'application/json' }
  )
}

async function serve(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  key: string
): Promise<Response> {
  const isPackage = key.startsWith('releases/')
  const rangeHeader = request.headers.get('Range')
  const kind: RequestKind = request.method === 'HEAD' ? 'head' : rangeHeader ? 'range' : 'full'
  const cache = caches.default
  const cacheKey = new Request(`${new URL(request.url).origin}/${key}`, { method: 'GET' })
  // Count after lookup, including cache hits. Do not cache manifests or partial responses.
  if (
    isPackage &&
    request.method === 'GET' &&
    !rangeHeader &&
    !request.headers.has('If-None-Match')
  ) {
    const cached = await cache.match(cacheKey).catch(() => undefined)
    const asset = cached && assetFromCache(key, cached.headers)
    if (cached && asset) {
      ctx.waitUntil(count(env, asset, kind, cached.status))
      return cached
    }
  }

  const metadata = await env.PACKAGES.head(key)
  if (!metadata) return response('Not found', 404)
  const asset = assetFromMetadata(key, metadata.customMetadata)
  if (!asset) return response('Asset metadata is incomplete', 503)
  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    'Cache-Control': isPackage ? 'public, max-age=31536000, immutable' : 'no-store',
    ETag: metadata.httpEtag,
    'X-Content-Type-Options': 'nosniff'
  })
  metadata.writeHttpMetadata(headers)
  cacheMetadata(asset, headers)
  let status = 200
  let body: ReadableStream | null = null

  const etags = request.headers
    .get('If-None-Match')
    ?.split(',')
    .map((value) => value.trim())
  if (etags?.includes(metadata.httpEtag) || etags?.includes('*')) {
    status = 304
  } else if (request.method === 'HEAD') {
    headers.set('Content-Length', String(metadata.size))
  } else {
    const ifRange = request.headers.get('If-Range')
    const useRange =
      rangeHeader &&
      (!ifRange ||
        ifRange === metadata.httpEtag ||
        (Number.isFinite(Date.parse(ifRange)) &&
          metadata.uploaded.getTime() <= Date.parse(ifRange)))
    const range = useRange ? rangeFor(rangeHeader, metadata.size) : undefined
    if (useRange && !range) {
      status = 416
      headers.set('Content-Range', `bytes */${metadata.size}`)
    } else {
      // Avoid serving bytes under the wrong ETag if publication/cleanup races this request.
      const object = await env.PACKAGES.get(key, {
        onlyIf: { etagMatches: metadata.etag },
        ...(range ? { range } : {})
      })
      if (!object) return response('Not found', 404)
      if (!('body' in object)) return response('Asset temporarily unavailable', 503)
      body = object.body
      if (range) {
        status = 206
        headers.set(
          'Content-Range',
          `bytes ${range.offset}-${range.offset + range.length - 1}/${metadata.size}`
        )
      }
      headers.set('Content-Length', String(range ? range.length : metadata.size))
    }
  }
  const result = new Response(body, { status, headers })
  if (isPackage && status === 200 && request.method === 'GET' && !rangeHeader) {
    ctx.waitUntil(
      cache.put(cacheKey, result.clone()).catch(() => {
        console.error(JSON.stringify({ event: 'package_cache_failed' }))
      })
    )
  }
  ctx.waitUntil(count(env, asset, kind, status))
  return result
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return response('Method not allowed', 405, { Allow: 'GET, HEAD' })
    const path = new URL(request.url).pathname
    if (path === '/health') return response('ok', 200)
    try {
      if (path === '/admin/counts') return await exportCounts(request, env)
      const key = objectKey(path)
      if (!key) return response('Not found', 404)
      return await serve(request, env, ctx, key)
    } catch {
      console.error(JSON.stringify({ event: 'update_delivery_failed' }))
      return response('Update service temporarily unavailable', 503)
    }
  }
} satisfies ExportedHandler<Env>
