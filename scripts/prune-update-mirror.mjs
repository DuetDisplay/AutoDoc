import { aws, MANIFESTS } from './update-mirror.mjs'
import yaml from 'js-yaml'
import { readStorage, cleanupStorage } from './update-mirror-storage.mjs'
export { retentionPlan } from './update-mirror-storage.mjs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

async function main() {
  const args = process.argv.slice(2)
  if (args.some((a) => a !== '--apply' && !/^--keep=\d+\.\d+\.\d+$/.test(a)))
    throw new Error('Usage: prune-update-mirror.mjs [--apply] [--keep=VERSION]')
  const bucket = process.env.UPDATE_MIRROR_BUCKET
  if (!['autodoc-updates', 'autodoc-updates-staging'].includes(bucket))
    throw new Error('Explicit mirror bucket required')
  const bodies = []
  for (const name of MANIFESTS)
    bodies.push(
      await aws(['s3', 'cp', `s3://${bucket}/stable/${name}`, '-', '--only-show-errors'], {
        allowMissing: true
      })
    )
  if (bodies.every((body) => body === null)) {
    console.log('No stable release published yet; nothing to clean up.')
    return
  }
  if (bodies.some((body) => body === null))
    throw new Error('Both stable manifests required; refusing cleanup of an incomplete feed')
  const manifests = bodies.map((body) => yaml.load(body.toString()))
  const state = await readStorage(aws, bucket)
  const plan = await cleanupStorage(aws, bucket, state, manifests, {
    apply: args.includes('--apply'),
    keep: args.filter((a) => a.startsWith('--keep=')).map((a) => a.slice(7))
  })
  console.log(
    JSON.stringify(
      {
        protected_versions: plan.protectedVersions,
        deletion_keys: plan.deletions.map((o) => o.Key),
        reclaim_bytes: plan.deletions.reduce((n, o) => n + o.Size, 0),
        aborted_uploads: plan.expiredUploads.map((u) => u.Key),
        reclaim_multipart_bytes: plan.expiredUploads.reduce((n, u) => n + u.bytes, 0),
        apply: args.includes('--apply')
      },
      null,
      2
    )
  )
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
