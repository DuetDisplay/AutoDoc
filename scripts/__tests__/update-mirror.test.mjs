import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { planRelease, publishPlan, newer } from '../update-mirror.mjs'
import { buildHostedEvents, main as ingestHosted } from '../ingest-hosted-update-counts.mjs'
import { retentionPlan } from '../prune-update-mirror.mjs'
import yaml from 'js-yaml'
const require = createRequire(import.meta.url)
const github = require('../ingest-github-download-counts.js')
const { GenericProvider } = require('electron-updater/out/providers/GenericProvider.js')
const release = {
  tag_name: 'v1.3.1',
  published_at: '2026-10-01T00:00:00Z',
  draft: false,
  prerelease: false
}
async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'autodoc-mirror-fixture-'))
  try {
    for (const [name, file] of [
      ['latest-mac.yml', 'AutoDoc-1.3.1-arm64-mac.zip'],
      ['latest.yml', 'autodoc-1.3.1-setup.exe']
    ]) {
      const data = Buffer.from(`signed-package-fixture:${file}`),
        sha512 = createHash('sha512').update(data).digest('base64')
      await writeFile(join(root, file), data)
      await writeFile(
        join(root, name),
        yaml.dump({
          version: '1.3.1',
          files: [{ url: file, size: data.length, sha512 }],
          path: file,
          sha512
        })
      )
    }
    await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
test('rewrite both platform manifests with unchanged checksums; real electron-updater resolves them', async () =>
  fixture(async (root) => {
    const plan = await planRelease(release, root, 'https://updates.example.com')
    assert.equal(plan.packages.length, 2)
    for (const [index, platform] of ['darwin', 'win32'].entries()) {
      const info = yaml.load(plan.manifests[index].body)
      const provider = new GenericProvider(
        { provider: 'generic', url: 'https://updates.example.com/stable/' },
        { channel: null },
        { platform, executor: {}, isUseMultipleRangeRequest: false }
      )
      const files = provider.resolveFiles(info)
      assert.equal(files[0].url.href, `https://updates.example.com/${plan.packages[index].key}`)
      assert.equal(files[0].info.sha512, plan.packages[index].sha512)
      assert.equal(info.version, '1.3.1')
    }
  }))
test('corrupt signed bytes never produce a publication plan', async () =>
  fixture(async (root) => {
    await writeFile(join(root, 'autodoc-1.3.1-setup.exe'), 'corrupt')
    await assert.rejects(planRelease(release, root, 'https://updates.example.com'), /Checksum/)
  }))
test('drafts and prereleases cannot advance stable', async () => {
  assert.equal(
    await planRelease({ ...release, draft: true }, '/missing', 'https://updates.example.com'),
    null
  )
  assert.equal(
    await planRelease({ ...release, prerelease: true }, '/missing', 'https://updates.example.com'),
    null
  )
})
test('mismatched version and untrusted package paths are rejected', async () =>
  fixture(async (root) => {
    await assert.rejects(
      planRelease({ ...release, tag_name: 'v1.4.0' }, root, 'https://updates.example.com'),
      /version/
    )
    const manifest = yaml.load(
      await (await import('node:fs/promises')).readFile(join(root, 'latest-mac.yml'))
    )
    manifest.files[0].url = 'https://evil.example/package.zip'
    await writeFile(join(root, 'latest-mac.yml'), yaml.dump(manifest))
    await assert.rejects(
      planRelease(release, root, 'https://updates.example.com'),
      /Unexpected package/
    )
  }))
test('semantic ordering protects newer feeds', () => {
  assert.equal(newer('1.10.0', '1.9.99'), true)
  assert.equal(newer('1.3.0', '1.3.0'), false)
  assert.equal(newer('1.2.99', '1.3.0'), false)
})

function fakeR2(failOn) {
  const objects = new Map(),
    writes = []
  let failed = false
  const run = async (args, options = {}) => {
    const flag = (name) => args[args.indexOf(name) + 1]
    if (args[0] === 's3api') {
      const key = flag('--key'),
        object = objects.get(key)
      if (args[1] === 'delete-object') {
        objects.delete(key)
        return Buffer.from('{}')
      }
      if (!object && options.allowMissing) return null
      if (!object) throw new Error('Not found')
      return Buffer.from(
        JSON.stringify({ ContentLength: object.body.length, Metadata: object.metadata })
      )
    }
    const [source, target] = args.slice(2),
      key = (source.startsWith('s3:') ? source : target).split('/').slice(3).join('/')
    if (source.startsWith('s3:')) {
      const object = objects.get(key)
      if (!object && options.allowMissing) return null
      if (!object) throw new Error('Not found')
      return options.hash ? createHash('sha512').update(object.body).digest('base64') : object.body
    }
    writes.push(key)
    if (key === failOn && !failed) {
      failed = true
      throw new Error('Injected storage failure')
    }
    objects.set(key, { body: await readFile(source), metadata: JSON.parse(flag('--metadata')) })
    return Buffer.from('')
  }
  return { objects, writes, run }
}
test('publication verifies all remote packages before advancing any manifest and is retryable', async () =>
  fixture(async (root) => {
    const plan = await planRelease(release, root, 'https://updates.example.com'),
      store = fakeR2()
    await publishPlan(plan, { run: store.run, bucket: 'autodoc-updates-staging' })
    assert.ok(
      store.writes.indexOf('stable/latest-mac.yml') > store.writes.indexOf(plan.packages[1].key)
    )
    const first = store.writes.length
    await publishPlan(plan, { run: store.run, bucket: 'autodoc-updates-staging' })
    assert.equal(
      store.writes.slice(first).some((key) => key.endsWith('.exe') || key.endsWith('.zip')),
      false
    )
    store.objects.get(plan.packages[0].key).metadata.sha512 = 'different'
    await assert.rejects(
      publishPlan(plan, { run: store.run, bucket: 'autodoc-updates-staging' }),
      /Immutable/
    )
  }))
test('failed manifest advancement restores the already-advanced platform', async () =>
  fixture(async (root) => {
    const plan = await planRelease(release, root, 'https://updates.example.com'),
      store = fakeR2('stable/latest.yml')
    const oldKey = 'releases/v1.3.0/autodoc-1.3.0-setup.exe',
      oldBody = Buffer.from('old signed package')
    const old = yaml.dump({
      version: '1.3.0',
      files: [{ url: `https://updates.example.com/${oldKey}` }]
    })
    store.objects.set(oldKey, {
      body: oldBody,
      metadata: {
        app_version: '1.3.0',
        platform: 'windows',
        architecture: 'x64',
        release_published_at: release.published_at
      }
    })
    for (const m of plan.manifests)
      store.objects.set(m.key, { body: Buffer.from(old), metadata: {} })
    await assert.rejects(
      publishPlan(plan, { run: store.run, bucket: 'autodoc-updates-staging' }),
      /Injected/
    )
    assert.equal(store.objects.get('stable/latest-mac.yml').body.toString(), old)
    assert.equal(store.objects.get('stable/latest.yml').body.toString(), old)
  }))
test('an older published release cannot replace a newer stable feed', async () =>
  fixture(async (root) => {
    const plan = await planRelease(release, root, 'https://updates.example.com'),
      store = fakeR2()
    store.objects.set('stable/latest-mac.yml', {
      body: Buffer.from('version: 1.4.0'),
      metadata: {}
    })
    await assert.rejects(
      publishPlan(plan, { run: store.run, bucket: 'autodoc-updates-staging' }),
      /downgrade/
    )
    assert.equal(store.writes.length, 0)
  }))
const row = {
  day: '2026-10-01',
  asset_key: 'releases/v1.3.1/autodoc-1.3.1-setup.exe',
  app_version: '1.3.1',
  platform: 'windows',
  architecture: 'x64',
  asset_kind: 'package',
  request_kind: 'full',
  response_status: 200,
  release_published_at: release.published_at,
  request_count: 5,
  last_seen_at: '2026-10-01T12:00:00Z'
}
test('aggregate export ignores client fields, suppresses profiles/GeoIP, and deduplicates repeated snapshots', () => {
  const payload = {
    environment: 'production',
    observed_at: '2026-10-02T00:00:00Z',
    rows: [{ ...row, ip: 'secret', device_id: 'secret' }]
  }
  const [a] = buildHostedEvents(payload),
    [b] = buildHostedEvents({ ...payload, observed_at: '2026-10-03T00:00:00Z' })
  assert.equal(a.properties.$insert_id, b.properties.$insert_id)
  assert.equal(a.properties.$process_person_profile, false)
  assert.equal(a.properties.$geoip_disable, true)
  assert.equal(JSON.stringify(a).includes('secret'), false)
  assert.notEqual(
    a.properties.$insert_id,
    buildHostedEvents({ ...payload, rows: [{ ...row, request_count: 6 }] })[0].properties.$insert_id
  )
})
test('staging and malformed aggregate exports cannot enter the live dashboard', () => {
  assert.throws(() => buildHostedEvents({ environment: 'staging', rows: [row] }), /production/)
  assert.throws(
    () =>
      buildHostedEvents({
        environment: 'production',
        observed_at: release.published_at,
        rows: [{ ...row, request_count: -1 }]
      }),
    /Invalid/
  )
})
test('fixture input cannot send either event family to PostHog', async () => {
  process.env.HOSTED_COUNTS_JSON_FILE = '/missing'
  process.env.GITHUB_RELEASES_JSON = '[]'
  const originalArgs = process.argv
  process.argv = ['node', 'script']
  try {
    await assert.rejects(ingestHosted([]), /Fixture input requires/)
    await assert.rejects(github.main(), /Fixture input requires/)
  } finally {
    process.argv = originalArgs
    delete process.env.HOSTED_COUNTS_JSON_FILE
    delete process.env.GITHUB_RELEASES_JSON
  }
})
test('GitHub snapshots suppress person profiles and contain asset aggregate identities', () => {
  const [event] = github.buildEvents(
    [
      {
        ...release,
        id: 42,
        assets: [{ id: 99, name: 'autodoc-1.3.1-setup.exe', download_count: 8 }]
      }
    ],
    'DuetDisplay/AutoDoc',
    false
  )
  assert.equal(event.properties.$process_person_profile, false)
  assert.equal(event.properties.$geoip_disable, true)
  assert.equal(event.properties.asset_kind, 'installer')
  assert.equal(event.distinct_id, 'github-release-asset:DuetDisplay/AutoDoc:99')
})
test('retention protects current/previous/manual versions, recent files and manifest references', () => {
  const object = (v, date = '2026-01-01') => ({
    Key: `releases/v${v}/autodoc-${v}-setup.exe`,
    LastModified: date,
    Size: 10
  })
  const manifests = ['latest.yml', 'latest-mac.yml'].map(() => ({
    version: '1.5.0',
    files: [{ url: 'https://updates.example.com/releases/v1.1.0/autodoc-1.1.0-setup.exe' }]
  }))
  const plan = retentionPlan(
    [
      object('1.1.0'),
      object('1.2.0'),
      object('1.3.0'),
      object('1.4.0'),
      object('1.5.0'),
      object('1.6.0'),
      object('1.0.0', '2026-10-01')
    ],
    manifests,
    ['1.3.0'],
    Date.parse('2026-10-07')
  )
  assert.deepEqual(
    plan.deletions.map((o) => o.Key),
    ['releases/v1.2.0/autodoc-1.2.0-setup.exe']
  )
})
