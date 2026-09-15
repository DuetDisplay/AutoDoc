import {
  ALLOWED_TEMPERATURES,
  DEFAULT_HOST,
  DEFAULT_MODEL,
  DEFAULT_SEED,
  type AllowedTemperature
} from './constants.ts'
import type { ArmAPromptVersion } from './prompts.ts'

export class UsageError extends Error {}

export interface RunOptions {
  arm: 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g'
  temperature: AllowedTemperature
  promptVersion: ArmAPromptVersion
  seed: number
  out: string | null
  fixture: string | null
  input: string | null
  commitments: string | null
  extractor: string | null
  coverageKey: string | null
  host: string
  model: string
  inspect: boolean
  stream: boolean
}

export function usage(): string {
  return [
    'Usage: npx --no-install vite-node scripts/notes-writer-probe/run.ts',
    '  --arm a|b|c|d|e|f|g',
    '  --temperature 0|0.4',
    '  --out <external-output-directory>',
    '  [--fixture <corpus-dir-or-transcript.json>]  (arm a, arm c, arm e)',
    '  [--input <v3.md-or-json>]                    (arm b notes; arm d legacy notes; arm e segments JSON; arm f/g candidate.md)',
    '  [--commitments <verified.md>]                (arm d)',
    '  [--extractor <arm-c-candidate.md>]           (arm e)',
    '  [--coverage-key <key.md>]                    (arm f, arm g)',
    '  [--host 127.0.0.1:11438]',
    '  [--model llama3.1:latest]',
    '  [--prompt-version 1|2|3]   Arm A templates; default 1 (frozen v1); ignored for arm c/d/e/f',
    '  [--seed <int>]            default 42',
    '  [--inspect]   content-free plan only; no inference',
    '',
    'Do not run writer arms until Phase 2 review establishes the standing bar.',
    'Refuses to write if --out already exists. Output must be outside the Git worktree.'
  ].join('\n')
}

export function parseRunArgs(args: string[]): RunOptions {
  const values = new Map<string, string>()
  const flags = new Set<string>()
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--inspect') {
      flags.add('inspect')
      continue
    }
    if (
      argument === '--arm' ||
      argument === '--temperature' ||
      argument === '--out' ||
      argument === '--fixture' ||
      argument === '--input' ||
      argument === '--host' ||
      argument === '--model' ||
      argument === '--stream' ||
      argument === '--prompt-version' ||
      argument === '--seed' ||
      argument === '--commitments' ||
      argument === '--extractor' ||
      argument === '--coverage-key'
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

  const arm = values.get('arm')
  if (arm !== 'a' && arm !== 'b' && arm !== 'c' && arm !== 'd' && arm !== 'e' && arm !== 'f' && arm !== 'g') {
    throw new UsageError('`--arm` must be a, b, c, d, e, f, or g')
  }
  const temperatureRaw = values.get('temperature') ?? '0'
  const temperature = Number(temperatureRaw)
  if (!ALLOWED_TEMPERATURES.includes(temperature as AllowedTemperature)) {
    throw new UsageError('`--temperature` must be 0 or 0.4')
  }
  const promptVersionRaw = values.get('prompt-version') ?? '1'
  if (promptVersionRaw !== '1' && promptVersionRaw !== '2' && promptVersionRaw !== '3') {
    throw new UsageError('`--prompt-version` must be 1, 2, or 3')
  }
  const seedRaw = values.get('seed')
  const seed = seedRaw === undefined ? DEFAULT_SEED : Number(seedRaw)
  if (!Number.isInteger(seed)) {
    throw new UsageError('`--seed` must be an integer')
  }
  const streamValue = values.get('stream')
  return {
    arm,
    temperature: temperature as AllowedTemperature,
    promptVersion: Number(promptVersionRaw) as ArmAPromptVersion,
    seed,
    out: values.get('out') ?? null,
    fixture: values.get('fixture') ?? null,
    input: values.get('input') ?? null,
    commitments: values.get('commitments') ?? null,
    extractor: values.get('extractor') ?? null,
    coverageKey: values.get('coverage-key') ?? null,
    host: values.get('host') ?? DEFAULT_HOST,
    model: values.get('model') ?? DEFAULT_MODEL,
    inspect: flags.has('inspect'),
    stream: streamValue === undefined ? true : streamValue !== 'false'
  }
}
