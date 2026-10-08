import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
const require = createRequire(import.meta.url)
const {
  Miniflare,
  convertV4MiniflareOptions
} = require('../../update-worker/node_modules/miniflare')

test('real Worker runtime, R2 ranges/cache, D1 counts and protected export; wipe all test state', async () => {
  const state = await mkdtemp(join(tmpdir(), 'autodoc-update-worker-test-'))
  let mf
  try {
    const result = await build({
      entryPoints: ['update-worker/src/index.ts'],
      bundle: true,
      write: false,
      format: 'esm',
      target: 'es2022'
    })
    mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: result.outputFiles[0].text,
        compatibilityDate: '2026-10-06',
        compatibilityFlags: ['nodejs_compat'],
        r2Buckets: ['PACKAGES'],
        d1Databases: ['COUNTS'],
        bindings: {
          ENVIRONMENT: 'staging',
          COUNTS_EXPORT_TOKEN: 'test-only-token-with-at-least-32-characters'
        },
        r2Persist: join(state, 'r2'),
        d1Persist: join(state, 'd1'),
        cachePersist: join(state, 'cache')
      })
    )
    const db = await mf.getD1Database('COUNTS'),
      bucket = await mf.getR2Bucket('PACKAGES')
    await db.exec(
      (await readFile('update-worker/migrations/0001_aggregate_counts.sql', 'utf8'))
        .replace(/^--.*$/gm, '')
        .replace(/\n/g, ' ')
    )
    const key = 'releases/v1.3.1/autodoc-1.3.1-setup.exe'
    const metadata = {
      app_version: '1.3.1',
      platform: 'windows',
      architecture: 'x64',
      release_published_at: '2026-10-01T00:00:00Z'
    }
    await bucket.put(key, '0123456789', { customMetadata: metadata })
    await bucket.put('stable/latest.yml', 'version: 1.3.1', { customMetadata: metadata })
    const request = async (path, options = {}) => {
      const res = await mf.dispatchFetch(`https://updates.example.com/${path}`, options)
      const body = await res.text()
      // D1 writes run in waitUntil. Wait using bounded state polling, never send to PostHog.
      await new Promise((resolve) => setTimeout(resolve, 25))
      return { res, body }
    }
    let r = await request(key)
    assert.equal(r.res.status, 200)
    assert.equal(r.body, '0123456789')
    const etag = r.res.headers.get('etag')
    r = await request(`${key}?client=ignored`, { headers: { 'X-Device-ID': 'ignored' } })
    assert.equal(r.res.status, 200)
    assert.equal(r.body, '0123456789')
    r = await request(key, { headers: { Range: 'bytes=2-5' } })
    assert.equal(r.res.status, 206)
    assert.equal(r.body, '2345')
    assert.equal(r.res.headers.get('content-range'), 'bytes 2-5/10')
    r = await request(key, { headers: { Range: 'bytes=-3' } })
    assert.equal(r.body, '789')
    r = await request(key, { headers: { Range: 'bytes=7-' } })
    assert.equal(r.body, '789')
    r = await request(key, { headers: { Range: 'bytes=0-1,4-5' } })
    assert.equal(r.res.status, 416)
    r = await request(key, { headers: { Range: 'bytes=99-' } })
    assert.equal(r.res.status, 416)
    r = await request(key, { headers: { Range: 'bytes=0-1', 'If-Range': '"old"' } })
    assert.equal(r.res.status, 200)
    assert.equal(r.body, '0123456789')
    r = await request(key, { headers: { 'If-None-Match': etag } })
    assert.equal(r.res.status, 304)
    assert.equal(r.body, '')
    r = await request(key, { method: 'HEAD' })
    assert.equal(r.res.headers.get('content-length'), '10')
    assert.equal(r.body, '')
    r = await request('stable/latest.yml?noCache=123')
    assert.equal(r.res.headers.get('cache-control'), 'no-store')
    await bucket.put('stable/latest.yml', 'version: 1.3.2', {
      customMetadata: { ...metadata, app_version: '1.3.2' }
    })
    r = await request('stable/latest.yml')
    assert.equal(r.body, 'version: 1.3.2')
    assert.equal((await request('anything?ip=ignored')).res.status, 404)
    assert.equal((await request(key, { method: 'POST' })).res.status, 405)
    assert.equal((await request('health')).res.status, 200)
    assert.equal((await request('admin/counts?from=2026-10-01&to=2026-10-31')).res.status, 401)
    const auth = { Authorization: 'Bearer test-only-token-with-at-least-32-characters' }
    assert.equal(
      (await request('admin/counts?from=2026-99-99&to=2026-10-31', { headers: auth })).res.status,
      400
    )
    const day = new Date().toISOString().slice(0, 10)
    const payload = JSON.parse(
      (await request(`admin/counts?from=${day}&to=${day}`, { headers: auth })).body
    )
    assert.equal(payload.environment, 'staging')
    assert.equal(
      payload.rows.reduce((n, row) => n + row.request_count, 0),
      12
    )
    assert.equal(payload.rows.filter((row) => row.asset_kind === 'manifest').length, 2)
    assert.equal(
      payload.rows.find(
        (row) =>
          row.request_kind === 'full' && row.asset_kind === 'package' && row.response_status === 200
      ).request_count,
      2
    )
    assert.equal(JSON.stringify(payload).includes('ignored'), false)
    // Counting outage must not prevent package delivery.
    // Deleting the origin object also proves this request is served from cache.
    await bucket.delete(key)
    await db.exec('DROP TABLE request_counts')
    r = await request(key)
    assert.equal(r.res.status, 200)
    assert.equal(r.body, '0123456789')
  } finally {
    try {
      await mf?.dispose()
    } finally {
      await rm(state, { recursive: true, force: true })
    }
  }
})
