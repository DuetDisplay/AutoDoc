#!/usr/bin/env node
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { UsageError } from './cli.ts'
import { loadFixtureProjection } from './transcript-projection.ts'
import {
  renderVerifiedMarkdown,
  verifyCommitments,
  type VerifyResult
} from './verify-commitments.ts'

function usage(): string {
  return [
    'Usage: npx --no-install vite-node scripts/notes-writer-probe/verify.ts',
    '  --extractor <arm-c-candidate.md>',
    '  --fixture <corpus-dir-or-transcript.json>',
    '  --out <verified-commitments.md>',
    '  [--report <verified-report.json>]',
    '',
    'Deterministic. Does not call a model. Does not log transcript or note text.'
  ].join('\n')
}

function parseArgs(args: string[]): {
  extractor: string
  fixture: string
  out: string
  report: string | null
} {
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (
      argument === '--extractor' ||
      argument === '--fixture' ||
      argument === '--out' ||
      argument === '--report'
    ) {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new UsageError(`Missing value for ${argument}`)
      }
      values.set(argument.slice(2), value)
      index += 1
      continue
    }
    throw new UsageError(`${usage()}\n\nUnknown argument: ${argument}`)
  }
  const extractor = values.get('extractor')
  const fixture = values.get('fixture')
  const out = values.get('out')
  if (!extractor || !fixture || !out) {
    throw new UsageError('`--extractor`, `--fixture`, and `--out` are required')
  }
  return {
    extractor,
    fixture,
    out,
    report: values.get('report') ?? null
  }
}

async function writePrivate(filePath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  await chmod(path.dirname(filePath), 0o700)
  await writeFile(filePath, contents, { mode: 0o600 })
  await chmod(filePath, 0o600)
}

function contentFreeReport(result: VerifyResult): Record<string, unknown> {
  return {
    extractedCount: result.extracted.length,
    keptCount: result.kept.length,
    rejectedCount: result.extracted.length - result.kept.length,
    decisions: result.decisions.map((decision) => ({
      index: decision.index,
      keep: decision.keep,
      reason: decision.reason,
      actionTokenCount: decision.actionTokenCount,
      groundedTokenCount: decision.groundedTokenCount,
      supportingUtteranceCount: decision.supportingUtteranceCount,
      hedgeHits: decision.hedgeHits,
      confirmationUtteranceCount: decision.confirmationUtteranceCount
    }))
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const { readFile } = await import('node:fs/promises')
  const extractorMarkdown = await readFile(path.resolve(options.extractor), 'utf8')
  const projection = await loadFixtureProjection(options.fixture, 0, 0)
  const utterances = projection.turns.map((turn) => turn.text)
  const result = verifyCommitments(extractorMarkdown, utterances)
  const markdown = renderVerifiedMarkdown(result.kept)
  await writePrivate(path.resolve(options.out), markdown)
  const report = contentFreeReport(result)
  const reportPath = options.report
    ? path.resolve(options.report)
    : path.join(path.dirname(path.resolve(options.out)), 'verified-report.json')
  await writePrivate(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(
    `verified=${result.kept.length} of ${result.extracted.length}\n`
  )
}

main().catch((error: unknown) => {
  if (error instanceof UsageError) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
    return
  }
  process.stderr.write('Commitment verify failed. No transcript or notes content was logged.\n')
  process.exitCode = 1
})
