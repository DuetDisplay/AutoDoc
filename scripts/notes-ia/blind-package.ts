#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto'
import { readFile, realpath, rm } from 'node:fs/promises'
import path from 'node:path'

import { ensurePrivateDirectory, writePrivateFile, writePrivateJson } from './privacy.ts'

class UsageError extends Error {}

const FORBIDDEN_LABELS = new Set([
  'Cedar',
  'Harbor',
  'Juniper',
  'Mesa',
  'Orchid',
  'Ironwood',
  'Redwood',
  'Tamarack'
])
const FRESH_TREE_NAMES = [
  'Larch',
  'Sycamore',
  'Basswood',
  'Sweetgum',
  'Hornbeam',
  'Magnolia',
  'Alder',
  'Pecan',
  'Beech',
  'Hawthorn'
] as const

const SCORE_HEADER =
  'row_type,scorer,is_prompt_author,arm_blind_label,gate,pairwise_winner,pairwise_confidence,hierarchy_1to5,brevity_1to5,nondup_1to5,coverage_pass,trust_pass,notes_freetext\n'

function usage(): string {
  return [
    'Usage: npx --no-install vite-node scripts/notes-ia/blind-package.ts',
    '  --arms <directory-with-P0.md-P1.md-P2.md>',
    '  --granola <reference-markdown>',
    '  --scorecard <scorecard.md>',
    '  --out <ia-arms-root>'
  ].join('\n')
}

interface CliOptions {
  arms: string
  granola: string
  scorecard: string
  out: string
}

function parseArgs(args: string[]): CliOptions {
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    const value = args[index + 1]
    if (!['--arms', '--granola', '--scorecard', '--out'].includes(name) || !value) {
      throw new UsageError(usage())
    }
    values.set(name, value)
  }
  const arms = values.get('--arms')
  const granola = values.get('--granola')
  const scorecard = values.get('--scorecard')
  const out = values.get('--out')
  if (!arms || !granola || !scorecard || !out) throw new UsageError(usage())
  return { arms, granola, scorecard, out }
}

function shuffle<T>(values: readonly T[]): T[] {
  const copy = [...values]
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const bytes = randomBytes(4)
    const pick = bytes.readUInt32BE(0) % (index + 1)
    ;[copy[index], copy[pick]] = [copy[pick], copy[index]]
  }
  return copy
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

function scorerReadme(controlLabel: string, candidateLabels: readonly string[]): string {
  const pairs = candidateLabels.map((label) => `${label} vs ${controlLabel}`).join('; ')
  return [
    '# Scorer brief',
    '',
    `Control for G1 pairing: **${controlLabel}**.`,
    '',
    `G1 pairs to judge: ${pairs}.`,
    '',
    'Scoring order: write G1 rows first, then G2, then G3/G4. Do not open `g2-reference/` until your G1 rows are written.',
    '',
    'Use `scorecard.md` and record every judgment in `scores.csv`. Two reviewers; adjudicate disagreements as specified in the scorecard.',
    ''
  ].join('\n')
}

async function readMetrics(armsDir: string, armId: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = JSON.parse(await readFile(path.join(armsDir, `${armId}.metrics.json`), 'utf8'))
    if (raw && typeof raw === 'object' && 'metrics' in raw) {
      return raw as Record<string, unknown>
    }
    return null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const armsDir = await realpath(options.arms)
  const granolaPath = await realpath(options.granola)
  const scorecardPath = await realpath(options.scorecard)
  const outDir = path.resolve(options.out)

  const pool = FRESH_TREE_NAMES.filter((name) => !FORBIDDEN_LABELS.has(name))
  const labels = shuffle(pool).slice(0, 3)
  if (labels.length !== 3) throw new Error('Need three fresh blind labels.')
  const armIds = ['P0', 'P1', 'P2'] as const
  const mapping = Object.fromEntries(labels.map((label, index) => [label, armIds[index]])) as Record<
    string,
    (typeof armIds)[number]
  >
  const controlLabel = labels[0]
  const candidateLabels = labels.slice(1)

  const scorerDir = path.join(outDir, 'scorer')
  const coordinatorDir = path.join(outDir, 'coordinator')
  const referenceDir = path.join(outDir, 'g2-reference')
  const staleBlind = path.join(outDir, 'blind')

  await rm(staleBlind, { recursive: true, force: true })
  await rm(scorerDir, { recursive: true, force: true })
  await rm(coordinatorDir, { recursive: true, force: true })
  await rm(referenceDir, { recursive: true, force: true })

  await ensurePrivateDirectory(outDir)
  await ensurePrivateDirectory(scorerDir)
  await ensurePrivateDirectory(coordinatorDir)
  await ensurePrivateDirectory(referenceDir)

  const checksums: Record<string, string> = {}

  for (let index = 0; index < armIds.length; index += 1) {
    const armId = armIds[index]
    const label = labels[index]
    const bytes = await readFile(path.join(armsDir, `${armId}.md`))
    checksums[`scorer/${label}.md`] = sha256(bytes)
    const text = bytes.toString('utf8')
    await writePrivateFile(path.join(scorerDir, `${label}.md`), text.endsWith('\n') ? text : `${text}\n`)
  }

  const granolaBytes = await readFile(granolaPath)
  checksums['g2-reference/reference-granola.md'] = sha256(granolaBytes)
  const granolaText = granolaBytes.toString('utf8')
  await writePrivateFile(
    path.join(referenceDir, 'reference-granola.md'),
    granolaText.endsWith('\n') ? granolaText : `${granolaText}\n`
  )

  const scorecardText = await readFile(scorecardPath, 'utf8')
  await writePrivateFile(
    path.join(scorerDir, 'scorecard.md'),
    scorecardText.endsWith('\n') ? scorecardText : `${scorecardText}\n`
  )
  await writePrivateFile(path.join(scorerDir, 'scores.csv'), SCORE_HEADER)
  await writePrivateFile(path.join(scorerDir, 'README-scorer.md'), scorerReadme(controlLabel, candidateLabels))

  await writePrivateJson(path.join(coordinatorDir, 'blind-map.json'), {
    generatedAt: new Date().toISOString(),
    mapping
  })

  const p0 = await readMetrics(armsDir, 'P0')
  const p1 = await readMetrics(armsDir, 'P1')
  const p2 = await readMetrics(armsDir, 'P2')
  for (const armId of armIds) {
    const metrics = await readMetrics(armsDir, armId)
    if (metrics) await writePrivateJson(path.join(coordinatorDir, `${armId}.metrics.json`), metrics)
  }

  await writePrivateJson(path.join(coordinatorDir, 'coordinator-manifest.json'), {
    schemaVersion: 1,
    date: '2026-08-16',
    phase: 2,
    granolaBlinded: false,
    blindedArmCount: 3,
    blindLabels: [...labels].sort(),
    checksums,
    transformFlags: {
      P0: [],
      P1: ['dedup-clusters', 'demote-modality', 'nest-details', 'meeting-headings'],
      P2: ['presentation-shell-only']
    },
    metrics: {
      P0: p0?.metrics ?? null,
      P1: p1?.metrics ?? null,
      P2: p2?.metrics ?? null
    }
  })

  process.stdout.write(
    `Packets written with labels ${[...labels].sort().join(', ')}. Mapping is coordinator-only.\n`
  )
}

main().catch((error: unknown) => {
  if (error instanceof UsageError) process.stderr.write(`${error.message}\n`)
  else process.stderr.write('Blind package failed without logging meeting content.\n')
  process.exitCode = 1
})
