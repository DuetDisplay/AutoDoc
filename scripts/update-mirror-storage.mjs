// Storage accounting includes incomplete multipart uploads and incoming bytes.
// This is a per-bucket budget, not a cap on the entire Cloudflare bill.
export const DEFAULT_STORAGE_LIMIT_BYTES = 8_000_000_000
export const RETENTION_GRACE_MS = 24 * 60 * 60 * 1000
const VERSION = /^\d+\.\d+\.\d+$/

export function newer(left, right) {
  const a = left.split('.').map(Number),
    b = right.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}

export function storageLimit(value = process.env.UPDATE_MIRROR_MAX_STORAGE_BYTES) {
  if (value === undefined || value === '') return DEFAULT_STORAGE_LIMIT_BYTES
  const limit = Number(value)
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(limit) || limit <= 0)
    throw new Error('UPDATE_MIRROR_MAX_STORAGE_BYTES must be a positive integer byte limit')
  return limit
}

export function retentionPlan(objects, manifests, keep = [], now = Date.now(), superseded = {}) {
  if (
    manifests.length !== 2 ||
    manifests.some((m) => !VERSION.test(m.version) || !Array.isArray(m.files))
  )
    throw new Error('Both stable manifests required')
  const protectedVersions = new Set([...keep, ...manifests.map((m) => m.version)])
  const referenced = new Set()
  for (const m of manifests)
    for (const f of m.files) referenced.add(new URL(f.url).pathname.slice(1))
  const current = manifests
    .map((m) => m.version)
    .sort((a, b) => (newer(a, b) ? -1 : newer(b, a) ? 1 : 0))[0]
  // Only known, superseded releases qualify as rollback versions. Failed uploads
  // without a published manifest must not crowd out the actual previous release.
  const previous = Object.keys(superseded)
    .filter((v) => VERSION.test(v) && newer(current, v))
    .sort((a, b) => (newer(a, b) ? -1 : newer(b, a) ? 1 : 0))[0]
  if (previous) protectedVersions.add(previous)
  const deletions = objects.filter((o) => {
    const version =
      /^releases\/v(\d+\.\d+\.\d+)\/(?:latest(?:-mac)?\.yml|(?:AutoDoc|autodoc)-[A-Za-z0-9._-]+\.(?:zip|exe))$/.exec(
        o.Key
      )?.[1]
    const replacedAt = Date.parse(superseded[version])
    return (
      version &&
      newer(current, version) &&
      !protectedVersions.has(version) &&
      !referenced.has(o.Key) &&
      Number.isFinite(replacedAt) &&
      replacedAt <= now - RETENTION_GRACE_MS
    )
  })
  return { protectedVersions: [...protectedVersions], deletions }
}

export async function readStorage(run, bucket) {
  const listing = JSON.parse(
    (await run(['s3api', 'list-objects-v2', '--bucket', bucket, '--output', 'json'])).toString()
  )
  const multipart = JSON.parse(
    (
      await run(['s3api', 'list-multipart-uploads', '--bucket', bucket, '--output', 'json'])
    ).toString()
  )
  const objects = listing.Contents ?? [],
    uploads = multipart.Uploads ?? []
  for (const object of objects)
    if (!Number.isSafeInteger(object.Size) || object.Size < 0)
      throw new Error('Invalid storage size reported by R2')
  for (const upload of uploads) {
    const parts =
      JSON.parse(
        (
          await run([
            's3api',
            'list-parts',
            '--bucket',
            bucket,
            '--key',
            upload.Key,
            '--upload-id',
            upload.UploadId,
            '--output',
            'json'
          ])
        ).toString()
      ).Parts ?? []
    upload.bytes = parts.reduce((sum, part) => {
      if (!Number.isSafeInteger(part.Size) || part.Size < 0)
        throw new Error('Invalid multipart size reported by R2')
      return sum + part.Size
    }, 0)
  }
  return { objects, uploads }
}

export async function cleanupStorage(
  run,
  bucket,
  state,
  manifests,
  { apply = false, keep = [], now = Date.now() } = {}
) {
  const superseded = {}
  for (const object of state.objects) {
    const version = /^retention\/superseded\/v(\d+\.\d+\.\d+)\.json$/.exec(object.Key)?.[1]
    if (!version) continue
    const marker = JSON.parse(
      (
        await run(['s3', 'cp', `s3://${bucket}/${object.Key}`, '-', '--only-show-errors'])
      ).toString()
    )
    if (marker.version !== version || !Number.isFinite(Date.parse(marker.superseded_at)))
      throw new Error('Invalid superseded-release marker; cleanup stopped')
    superseded[version] = marker.superseded_at
  }
  // A partially configured feed or unknown history is kept rather than guessed.
  const plan =
    manifests.length === 2
      ? retentionPlan(state.objects, manifests, keep, now, superseded)
      : { protectedVersions: [], deletions: [] }
  const expiredUploads = state.uploads.filter(
    (u) =>
      Number.isFinite(Date.parse(u.Initiated)) &&
      Date.parse(u.Initiated) <= now - RETENTION_GRACE_MS
  )
  if (apply) {
    for (const object of plan.deletions)
      await run(['s3api', 'delete-object', '--bucket', bucket, '--key', object.Key])
    for (const upload of expiredUploads)
      await run([
        's3api',
        'abort-multipart-upload',
        '--bucket',
        bucket,
        '--key',
        upload.Key,
        '--upload-id',
        upload.UploadId
      ])
  }
  return { ...plan, expiredUploads, superseded }
}

export function capacityPlan(state, plan, maxBytes = storageLimit()) {
  const currentBytes =
    state.objects.reduce((sum, o) => sum + o.Size, 0) +
    state.uploads.reduce((sum, u) => sum + u.bytes, 0)
  const existing = new Set(state.objects.map((o) => o.Key))
  const packageBytes = plan.packages
    .filter((p) => !existing.has(p.key))
    .reduce((sum, p) => sum + p.size, 0)
  // Conservatively reserve both copies of each manifest and two retention markers.
  const incomingBytes =
    packageBytes + plan.manifests.reduce((sum, m) => sum + 2 * Buffer.byteLength(m.body), 0) + 2048
  const projectedBytes = currentBytes + incomingBytes
  return { currentBytes, incomingBytes, projectedBytes, maxBytes, fits: projectedBytes <= maxBytes }
}

export function capacityMessage(budget) {
  const gb = (n) => `${(n / 1e9).toFixed(3)} GB (${n} bytes)`
  return `Update mirror upload blocked: storage budget exceeded. Current ${gb(budget.currentBytes)}; incoming/reserved ${gb(budget.incomingBytes)}; projected ${gb(budget.projectedBytes)}; limit ${gb(budget.maxBytes)}. No new packages were uploaded and the latest feed is unchanged. Wait for eligible cleanup or explicitly increase UPDATE_MIRROR_MAX_STORAGE_BYTES.`
}
