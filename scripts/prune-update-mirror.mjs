import { aws, MANIFESTS, newer } from './update-mirror.mjs'
import yaml from 'js-yaml'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function retentionPlan(objects, manifests, keep = [], now = Date.now()) {
  if (manifests.length !== 2 || manifests.some((m) => !/^\d+\.\d+\.\d+$/.test(m.version)))
    throw new Error('Both stable manifests required')
  const protectedVersions = new Set([...keep, ...manifests.map((m) => m.version)])
  const referenced = new Set()
  for (const m of manifests)
    for (const f of m.files) referenced.add(new URL(f.url).pathname.slice(1))
  const current = manifests
    .map((m) => m.version)
    .sort((a, b) => (newer(a, b) ? -1 : newer(b, a) ? 1 : 0))[0]
  const versions = [
    ...new Set(objects.map((o) => /^releases\/v(\d+\.\d+\.\d+)\//.exec(o.Key)?.[1]).filter(Boolean))
  ]
  const previous = versions
    .filter((v) => newer(current, v))
    .sort((a, b) => (newer(a, b) ? -1 : 1))[0]
  if (previous) protectedVersions.add(previous)
  const deletions = objects.filter((o) => {
    const version =
      /^releases\/v(\d+\.\d+\.\d+)\/(?:latest(?:-mac)?\.yml|(?:AutoDoc|autodoc)-[A-Za-z0-9._-]+\.(?:zip|exe))$/.exec(
        o.Key
      )?.[1]
    return (
      version &&
      newer(current, version) &&
      !protectedVersions.has(version) &&
      !referenced.has(o.Key) &&
      Number.isFinite(Date.parse(o.LastModified)) &&
      Date.parse(o.LastModified) < now - 30 * 86400000
    )
  })
  return { protectedVersions: [...protectedVersions], deletions }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.some((a) => a !== '--apply' && !/^--keep=\d+\.\d+\.\d+$/.test(a)))
    throw new Error('Usage: prune-update-mirror.mjs [--apply] [--keep=VERSION]')
  const bucket = process.env.UPDATE_MIRROR_BUCKET
  if (!['autodoc-updates', 'autodoc-updates-staging'].includes(bucket))
    throw new Error('Explicit mirror bucket required')
  const manifests = []
  for (const name of MANIFESTS)
    manifests.push(
      yaml.load(
        (
          await aws(['s3', 'cp', `s3://${bucket}/stable/${name}`, '-', '--only-show-errors'])
        ).toString()
      )
    )
  const listing = JSON.parse(
    (
      await aws(['s3api', 'list-objects-v2', '--bucket', bucket, '--prefix', 'releases/'])
    ).toString()
  )
  const plan = retentionPlan(
    listing.Contents ?? [],
    manifests,
    args.filter((a) => a.startsWith('--keep=')).map((a) => a.slice(7))
  )
  console.log(
    JSON.stringify(
      {
        protected_versions: plan.protectedVersions,
        deletion_keys: plan.deletions.map((o) => o.Key),
        reclaim_bytes: plan.deletions.reduce((n, o) => n + o.Size, 0),
        apply: args.includes('--apply')
      },
      null,
      2
    )
  )
  if (args.includes('--apply')) {
    for (const item of plan.deletions)
      await aws(['s3api', 'delete-object', '--bucket', bucket, '--key', item.Key])
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
