import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, writeFile, mkdtemp, rm, stat, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, basename, join } from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import yaml from 'js-yaml'
import {
  newer,
  readStorage,
  cleanupStorage,
  capacityPlan,
  capacityMessage,
  storageLimit
} from './update-mirror-storage.mjs'
export { newer } from './update-mirror-storage.mjs'

export const MANIFESTS = ['latest-mac.yml', 'latest.yml']
const STABLE = /^\d+\.\d+\.\d+$/
const PACKAGE = /^(?:AutoDoc|autodoc)-[A-Za-z0-9._-]+\.(?:zip|exe)$/

export async function digestFile(path) {
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('base64')
}

export function mirrorOrigin(value) {
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new Error('UPDATE_MIRROR_ORIGIN must be an HTTPS origin without a path or credentials')
  }
  return url.origin
}

export async function planRelease(release, directory, origin) {
  origin = mirrorOrigin(origin)
  if (release.draft || release.prerelease) return null
  const version = String(release.tag_name ?? '').replace(/^v/, '')
  if (!STABLE.test(version) || !Number.isFinite(Date.parse(release.published_at))) {
    throw new Error('Only published stable semver releases may advance this feed')
  }
  const root = await realpath(directory)
  const packages = new Map(),
    manifests = []
  for (const name of MANIFESTS) {
    const manifest = yaml.load(await readFile(join(root, name), 'utf8'))
    if (manifest?.version !== version || !Array.isArray(manifest.files) || !manifest.files.length) {
      throw new Error(`Invalid version/files in ${name}`)
    }
    const platform = name === 'latest-mac.yml' ? 'macos' : 'windows'
    const files = []
    for (const item of manifest.files) {
      // These public builds use full packages; installers such as DMGs stay on GitHub.
      const file = item.url
      if (
        typeof file !== 'string' ||
        !PACKAGE.test(file) ||
        basename(file) !== file ||
        (!file.startsWith(`AutoDoc-${version}-`) && !file.startsWith(`autodoc-${version}-`)) ||
        !(platform === 'macos' ? file.endsWith('.zip') : file.endsWith('.exe'))
      ) {
        throw new Error(`Unexpected package in ${name}`)
      }
      const path = await realpath(join(root, file))
      if (path !== join(root, file)) throw new Error('Symlinked release packages are not accepted')
      const size = (await stat(path)).size
      const sha512 = await digestFile(path)
      if (item.sha512 !== sha512 || item.size !== size)
        throw new Error(`Checksum/size mismatch: ${file}`)
      const key = `releases/v${version}/${file}`
      const metadata = {
        app_version: version,
        platform,
        architecture: file.includes('arm64')
          ? 'arm64'
          : file.includes('universal')
            ? 'universal'
            : 'x64',
        release_published_at: new Date(release.published_at).toISOString(),
        sha512
      }
      packages.set(key, { key, path, size, sha512, metadata })
      files.push({ ...item, url: `${origin}/${key}` })
    }
    const primary = packages.get(new URL(files[0].url).pathname.slice(1))
    if (manifest.sha512 && manifest.sha512 !== primary.sha512)
      throw new Error(`Legacy checksum mismatch: ${name}`)
    manifests.push({
      key: `stable/${name}`,
      archiveKey: `releases/v${version}/${name}`,
      body: yaml.dump(
        { ...manifest, files, path: files[0].url, sha512: primary.sha512 },
        { lineWidth: -1 }
      ),
      metadata: primary.metadata
    })
  }
  return { version, packages: [...packages.values()], manifests }
}

// AWS CLI performs streaming multipart uploads, avoiding Worker request-size limits.
// Arguments are passed directly, never interpolated into a shell. Credentials stay in env.
export function aws(args, { allowMissing = false, hash = false } = {}) {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID
  if (!/^[a-f0-9]{32}$/.test(account ?? '')) throw new Error('Missing CLOUDFLARE_ACCOUNT_ID')
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY)
    throw new Error(
      'Missing R2 upload credentials: set UPDATE_MIRROR_R2_ACCESS_KEY_ID and UPDATE_MIRROR_R2_SECRET_ACCESS_KEY in the selected GitHub environment.'
    )
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      'aws',
      ['--endpoint-url', `https://${account}.r2.cloudflarestorage.com`, ...args],
      {
        env: {
          ...process.env,
          AWS_DEFAULT_REGION: 'auto',
          AWS_PAGER: '',
          AWS_EC2_METADATA_DISABLED: 'true'
        },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    const chunks = [],
      errors = [],
      digest = hash ? createHash('sha512') : null
    child.stdout.on('data', (chunk) => (digest ? digest.update(chunk) : chunks.push(chunk)))
    child.stderr.on('data', (chunk) => errors.push(chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      const error = Buffer.concat(errors).toString()
      if (code && allowMissing && /\b(404|NoSuchKey|Not Found)\b/.test(error))
        return resolvePromise(null)
      if (code) {
        const providerCode = /\(([A-Za-z][A-Za-z0-9]{0,63})\) when calling/.exec(error)?.[1]
        const reason =
          providerCode === 'AccessDenied'
            ? 'Check the CI credential and bucket permissions.'
            : providerCode === 'NoSuchBucket'
              ? 'Check UPDATE_MIRROR_BUCKET and account configuration.'
              : 'Check R2 availability, upload credentials, and the CI operation log.'
        return reject(
          new Error(`R2 ${args[1]} failed (${providerCode ?? `exit ${code}`}). ${reason}`)
        )
      }
      resolvePromise(digest ? digest.digest('base64') : Buffer.concat(chunks))
    })
  })
}

function bucketName() {
  const bucket = process.env.UPDATE_MIRROR_BUCKET
  if (!['autodoc-updates', 'autodoc-updates-staging'].includes(bucket))
    throw new Error('Explicit update mirror bucket required')
  return bucket
}

export async function publishPlan(
  plan,
  { run = aws, bucket = bucketName(), maxStorageBytes = storageLimit() } = {}
) {
  const previous = new Map()
  // CI serializes all publication paths with a single concurrency group.
  for (const m of plan.manifests) {
    const old = await run(['s3', 'cp', `s3://${bucket}/${m.key}`, '-', '--only-show-errors'], {
      allowMissing: true
    })
    previous.set(m.key, old)
    if (old) {
      const current = yaml.load(old.toString())?.version
      if (!STABLE.test(current) || newer(current, plan.version))
        throw new Error('Refusing to downgrade stable feed')
    }
  }
  let state = await readStorage(run, bucket)
  const oldManifests = [...previous.values()]
    .filter(Boolean)
    .map((body) => yaml.load(body.toString()))
  const cleanup = await cleanupStorage(run, bucket, state, oldManifests, { apply: true })
  if (cleanup.deletions.length || cleanup.expiredUploads.length)
    state = await readStorage(run, bucket)
  const budget = capacityPlan(state, plan, maxStorageBytes)
  console.log(
    `Update mirror storage: current ${budget.currentBytes} bytes, incoming/reserved ${budget.incomingBytes} bytes, projected ${budget.projectedBytes} bytes, limit ${budget.maxBytes} bytes`
  )
  if (!budget.fits) {
    const error = new Error(capacityMessage(budget))
    error.code = 'MIRROR_STORAGE_BUDGET'
    error.budget = budget
    throw error
  }
  for (const item of plan.packages) {
    const head = await run(['s3api', 'head-object', '--bucket', bucket, '--key', item.key], {
      allowMissing: true
    })
    if (head) {
      const existing = JSON.parse(head.toString())
      if (existing.ContentLength !== item.size || existing.Metadata?.sha512 !== item.sha512) {
        throw new Error('Immutable package already exists with different contents')
      }
    } else {
      await run([
        's3',
        'cp',
        item.path,
        `s3://${bucket}/${item.key}`,
        '--only-show-errors',
        '--content-type',
        'application/octet-stream',
        '--cache-control',
        'public,max-age=31536000,immutable',
        '--metadata',
        JSON.stringify(item.metadata)
      ])
    }
    // Verify actual remote bytes rather than trusting uploaded checksum metadata.
    if (
      (await run(['s3', 'cp', `s3://${bucket}/${item.key}`, '-', '--only-show-errors'], {
        hash: true
      })) !== item.sha512
    ) {
      throw new Error('Remote package checksum verification failed; manifests were not advanced')
    }
  }
  const temp = await mkdtemp(join(tmpdir(), 'autodoc-mirror-publish-'))
  const advanced = []
  try {
    for (const m of plan.manifests) {
      const file = join(temp, basename(m.key))
      await writeFile(file, m.body)
      for (const key of [m.archiveKey, m.key]) {
        await run([
          's3',
          'cp',
          file,
          `s3://${bucket}/${key}`,
          '--only-show-errors',
          '--content-type',
          'text/yaml',
          '--cache-control',
          'no-store',
          '--metadata',
          JSON.stringify(m.metadata)
        ])
        if (key === m.key) advanced.push(m)
        const uploaded = await run(['s3', 'cp', `s3://${bucket}/${key}`, '-', '--only-show-errors'])
        if (uploaded.toString() !== m.body) throw new Error('Manifest verification failed')
      }
    }
  } catch (error) {
    for (const m of advanced.reverse()) {
      const old = previous.get(m.key)
      if (!old) await run(['s3api', 'delete-object', '--bucket', bucket, '--key', m.key])
      else {
        const file = join(temp, `restore-${basename(m.key)}`)
        const oldManifest = yaml.load(old.toString())
        const oldKey = new URL(oldManifest.files[0].url).pathname.slice(1)
        const head = JSON.parse(
          (await run(['s3api', 'head-object', '--bucket', bucket, '--key', oldKey])).toString()
        )
        await writeFile(file, old)
        await run([
          's3',
          'cp',
          file,
          `s3://${bucket}/${m.key}`,
          '--only-show-errors',
          '--content-type',
          'text/yaml',
          '--cache-control',
          'no-store',
          '--metadata',
          JSON.stringify(head.Metadata)
        ])
      }
    }
    throw error
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
  const markers = await mkdtemp(join(tmpdir(), 'autodoc-mirror-retention-'))
  try {
    for (const version of new Set(oldManifests.map((m) => m.version))) {
      if (version === plan.version || cleanup.superseded[version]) continue
      const key = `retention/superseded/v${version}.json`,
        file = join(markers, `${version}.json`)
      await writeFile(file, JSON.stringify({ version, superseded_at: new Date().toISOString() }))
      await run([
        's3',
        'cp',
        file,
        `s3://${bucket}/${key}`,
        '--only-show-errors',
        '--content-type',
        'application/json'
      ])
    }
    const publishedState = await readStorage(run, bucket)
    await cleanupStorage(
      run,
      bucket,
      publishedState,
      plan.manifests.map((m) => yaml.load(m.body)),
      { apply: true }
    )
  } catch {
    throw new Error(
      'Update packages and latest feed were published, but retention bookkeeping/cleanup failed. Check the feed and rerun cleanup; unknown replacement times are retained.'
    )
  } finally {
    await rm(markers, { recursive: true, force: true })
  }
}

async function main() {
  const [releaseFile, directory, ...flags] = process.argv.slice(2)
  if (!releaseFile || !directory || flags.some((f) => f !== '--apply'))
    throw new Error('Usage: update-mirror.mjs RELEASE.json ASSETS_DIR [--apply]')
  const plan = await planRelease(
    JSON.parse(await readFile(releaseFile)),
    directory,
    process.env.UPDATE_MIRROR_ORIGIN
  )
  if (!plan) return console.log('Draft/prerelease: stable mirror unchanged')
  console.log(
    `Validated ${plan.packages.length} packages for ${plan.version}; ${flags.includes('--apply') ? 'publishing' : 'dry run'}`
  )
  if (flags.includes('--apply')) await publishPlan(plan)
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(async (error) => {
    console.error(error.message)
    if (process.env.GITHUB_ACTIONS === 'true') {
      const message = error.message
        .replaceAll('%', '%25')
        .replaceAll('\r', '%0D')
        .replaceAll('\n', '%0A')
      console.error(`::error title=Update mirror failed::${message}`)
      if (process.env.GITHUB_STEP_SUMMARY)
        await writeFile(
          process.env.GITHUB_STEP_SUMMARY,
          `## Update mirror failed\n\n${error.message}\n`,
          { flag: 'a' }
        )
    }
    process.exitCode = 1
  })
}
