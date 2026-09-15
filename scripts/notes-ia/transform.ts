#!/usr/bin/env node
import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'

import { writePrivateFile, writePrivateJson } from './privacy.ts'
import { transformPresentation, transformSegments } from './pipeline.ts'
import type { TransformFlags } from './types.ts'

class UsageError extends Error {}

function usage(): string {
  return [
    'Usage: npx --no-install vite-node scripts/notes-ia/transform.ts',
    '  --segments <meeting-segments.json> | --presentation <notes-eval-presentation.json>',
    '  --out <directory>',
    '  [--arm-id <id>]',
    '  [--dedup-clusters] [--demote-modality] [--nest-details] [--meeting-headings]'
  ].join('\n')
}

interface CliOptions {
  segments: string | null
  presentation: string | null
  out: string
  armId: string
  flags: TransformFlags
}

function parseArgs(args: string[]): CliOptions {
  const values = new Map<string, string>()
  const flags: TransformFlags = {
    dedupClusters: false,
    demoteModality: false,
    nestDetails: false,
    meetingHeadings: false
  }

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    switch (argument) {
      case '--segments':
      case '--presentation':
      case '--out':
      case '--arm-id': {
        const value = args[index + 1]
        if (!value || value.startsWith('--')) throw new UsageError(usage())
        values.set(argument, value)
        index += 1
        break
      }
      case '--dedup-clusters':
        flags.dedupClusters = true
        break
      case '--demote-modality':
        flags.demoteModality = true
        break
      case '--nest-details':
        flags.nestDetails = true
        break
      case '--meeting-headings':
        flags.meetingHeadings = true
        break
      default:
        throw new UsageError(usage())
    }
  }

  const segments = values.get('--segments') ?? null
  const presentation = values.get('--presentation') ?? null
  const out = values.get('--out')
  if (!out || (segments && presentation) || (!segments && !presentation)) {
    throw new UsageError(usage())
  }
  if (presentation && (flags.dedupClusters || flags.demoteModality || flags.nestDetails || flags.meetingHeadings)) {
    throw new UsageError('Presentation input does not accept transform flags.')
  }

  return {
    segments,
    presentation,
    out,
    armId: path.basename(values.get('--arm-id') ?? 'notes'),
    flags
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const raw = JSON.parse(await readFile(await realpath(options.segments ?? options.presentation ?? ''), 'utf8'))
  const result = options.presentation
    ? transformPresentation(raw)
    : transformSegments(raw, options.flags)

  const directory = path.resolve(options.out)
  const stem = options.armId
  await writePrivateFile(path.join(directory, `${stem}.md`), result.markdown)
  await writePrivateJson(path.join(directory, `${stem}.metrics.json`), {
    armId: stem,
    flags: result.flags,
    metrics: result.metrics
  })

  process.stdout.write(
    [
      `Wrote ${stem}.md and ${stem}.metrics.json`,
      `bullets=${result.metrics.bulletCount}`,
      `headings=${result.metrics.headingCount}`,
      `words=${result.metrics.wordCount}`,
      `demoted=${result.metrics.itemsDemoted}`,
      `deduped=${result.metrics.itemsDeduped}`,
      `rangesIn=${result.metrics.rangesIn}`,
      `rangesOut=${result.metrics.rangesOut}`
    ].join(' ') + '\n'
  )
}

main().catch((error: unknown) => {
  if (error instanceof UsageError) process.stderr.write(`${error.message}\n`)
  else process.stderr.write('Transform failed without logging meeting content.\n')
  process.exitCode = 1
})
