import { access, chmod, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  ARM_D_INPUT_PROJECTION_DESCRIPTION,
  ARM_E_GUARD_VERSION,
  ARM_E_INPUT_PROJECTION_DESCRIPTION,
  ARM_F_GUARD_VERSION,
  ARM_F_INPUT_PROJECTION_DESCRIPTION,
  CHUNKING_POLICY_VERSION,
  INPUT_PROJECTION_DESCRIPTION
} from './constants.ts'
import { sha256Utf8 } from './hash.ts'
import type { GenerateOptions, ModelIdentity } from './ollama-client.ts'
import {
  ARM_A_CHUNK_SUMMARY_TEMPLATE,
  ARM_A_CHUNK_SUMMARY_TEMPLATE_V2,
  ARM_A_CHUNK_SUMMARY_TEMPLATE_V3,
  ARM_A_COMBINE_TEMPLATE,
  ARM_A_COMBINE_TEMPLATE_V2,
  ARM_A_COMBINE_TEMPLATE_V3,
  ARM_A_DIRECT_TEMPLATE,
  ARM_A_DIRECT_TEMPLATE_V2,
  ARM_A_DIRECT_TEMPLATE_V3,
  ARM_A_V1_TO_V2_PROMPT_DIFF,
  ARM_A_V2_TO_V3_PROMPT_DIFF,
  ARM_B_TASK_VERBATIM,
  ARM_B_TEMPLATE,
  ARM_C_TEMPLATE,
  ARM_D_TEMPLATE,
  ARM_E_GROUP_TEMPLATE,
  ARM_E_RESTYLE_TEMPLATE,
  ARM_F_COMPRESS_TEMPLATE_V2,
  type ArmAPromptVersion
} from './prompts.ts'
import type { ProjectionStats } from './transcript-projection.ts'

export interface PromptTemplateRecord {
  name: string
  sha256: string
  bytes: number
}

export interface WriterManifest {
  schemaVersion: 1
  performanceEligible: false
  createdAt: string
  arm: 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'smoke'
  temperature: number
  seed: number
  model: ModelIdentity
  ollamaVersion: string
  options: GenerateOptions
  stopConditions: readonly string[]
  prompt: {
    version: ArmAPromptVersion
    templates: PromptTemplateRecord[]
    packSha256: string
    filledPromptSha256: string | null
    v1ToV2Diff?: typeof ARM_A_V1_TO_V2_PROMPT_DIFF
    v2ToV3Diff?: typeof ARM_A_V2_TO_V3_PROMPT_DIFF
  }
  inputProjection: {
    description: string
    chunkingPolicyVersion: string
    stats: ProjectionStats | Record<string, unknown>
  }
  notes: string[]
  guardVersion?: number
}

export function promptTemplateRecords(
  version: ArmAPromptVersion = 1,
  arm: WriterManifest['arm'] = 'a'
): PromptTemplateRecord[] {
  const entries: [string, string][] =
    arm === 'f'
      ? [['ARM_F_COMPRESS_TEMPLATE_V2', ARM_F_COMPRESS_TEMPLATE_V2]]
      : arm === 'e'
      ? [
          ['ARM_E_GROUP_TEMPLATE', ARM_E_GROUP_TEMPLATE],
          ['ARM_E_RESTYLE_TEMPLATE', ARM_E_RESTYLE_TEMPLATE]
        ]
      : arm === 'd'
      ? [['ARM_D_TEMPLATE', ARM_D_TEMPLATE]]
      : arm === 'c'
        ? [['ARM_C_TEMPLATE', ARM_C_TEMPLATE]]
      : version === 3
        ? [
            ['ARM_A_DIRECT_TEMPLATE_V3', ARM_A_DIRECT_TEMPLATE_V3],
            ['ARM_A_CHUNK_SUMMARY_TEMPLATE_V3', ARM_A_CHUNK_SUMMARY_TEMPLATE_V3],
            ['ARM_A_COMBINE_TEMPLATE_V3', ARM_A_COMBINE_TEMPLATE_V3]
          ]
        : version === 2
          ? [
              ['ARM_A_DIRECT_TEMPLATE_V2', ARM_A_DIRECT_TEMPLATE_V2],
              ['ARM_A_CHUNK_SUMMARY_TEMPLATE_V2', ARM_A_CHUNK_SUMMARY_TEMPLATE_V2],
              ['ARM_A_COMBINE_TEMPLATE_V2', ARM_A_COMBINE_TEMPLATE_V2]
            ]
          : [
              ['ARM_A_DIRECT_TEMPLATE', ARM_A_DIRECT_TEMPLATE],
              ['ARM_A_CHUNK_SUMMARY_TEMPLATE', ARM_A_CHUNK_SUMMARY_TEMPLATE],
              ['ARM_A_COMBINE_TEMPLATE', ARM_A_COMBINE_TEMPLATE],
              ['ARM_B_TASK_VERBATIM', ARM_B_TASK_VERBATIM],
              ['ARM_B_TEMPLATE', ARM_B_TEMPLATE]
            ]
  return entries.map(([name, text]) => ({
    name,
    sha256: sha256Utf8(text),
    bytes: Buffer.byteLength(text, 'utf8')
  }))
}

export function promptPackSha256(
  version: ArmAPromptVersion = 1,
  arm: WriterManifest['arm'] = 'a'
): string {
  const templates = promptTemplateRecords(version, arm)
  const packed = templates.map((item) => `${item.name}:${item.sha256}`).join('\n')
  return sha256Utf8(packed)
}

export function requiredManifestKeys(): string[] {
  return [
    'schemaVersion',
    'performanceEligible',
    'createdAt',
    'arm',
    'temperature',
    'seed',
    'model',
    'ollamaVersion',
    'options',
    'stopConditions',
    'prompt',
    'inputProjection',
    'notes'
  ]
}

export function buildManifest(args: {
  arm: WriterManifest['arm']
  temperature: number
  seed: number
  model: ModelIdentity
  ollamaVersion: string
  options: GenerateOptions
  stopConditions: readonly string[]
  filledPromptSha256: string | null
  projectionStats: ProjectionStats | Record<string, unknown>
  createdAt?: string
  promptVersion?: ArmAPromptVersion
}): WriterManifest {
  const promptVersion = args.promptVersion ?? 1
  const templates = promptTemplateRecords(promptVersion, args.arm)
  const armC = args.arm === 'c'
  const armD = args.arm === 'd'
  const armE = args.arm === 'e'
  const armF = args.arm === 'f'
  const skipArmADiff = armC || armD || armE || armF
  return {
    schemaVersion: 1,
    performanceEligible: false,
    createdAt: args.createdAt ?? new Date().toISOString(),
    arm: args.arm,
    temperature: args.temperature,
    seed: args.seed,
    model: args.model,
    ollamaVersion: args.ollamaVersion,
    options: args.options,
    stopConditions: args.stopConditions,
    prompt: {
      version: promptVersion,
      templates,
      packSha256: promptPackSha256(promptVersion, args.arm),
      filledPromptSha256: args.filledPromptSha256,
      ...(!skipArmADiff && promptVersion === 2 ? { v1ToV2Diff: ARM_A_V1_TO_V2_PROMPT_DIFF } : {}),
      ...(!skipArmADiff && promptVersion === 3 ? { v2ToV3Diff: ARM_A_V2_TO_V3_PROMPT_DIFF } : {})
    },
    inputProjection: {
      description: armF
        ? ARM_F_INPUT_PROJECTION_DESCRIPTION
        : armE
        ? ARM_E_INPUT_PROJECTION_DESCRIPTION
        : armD
          ? ARM_D_INPUT_PROJECTION_DESCRIPTION
          : INPUT_PROJECTION_DESCRIPTION,
      chunkingPolicyVersion: CHUNKING_POLICY_VERSION,
      stats: args.projectionStats
    },
    notes: [
      'Manifest is written before inference. Do not treat timings as a ship performance gate.',
      armF
        ? 'Arm F per-section compression of a passing Arm E candidate. Frozen Arm A/B/C/D/E templates and ARM_F_COMPRESS_TEMPLATE v1 were not edited.'
        : armE
        ? 'Arm E chunked restyle plus deterministic composition. Frozen Arm A/B/C/D templates were not edited.'
        : armD
        ? 'Arm D restyle-legacy-and-patch-commitments. Frozen Arm A/B/C templates were not edited.'
        : armC
          ? 'Arm C specialist commitment extractor. Frozen Arm A/B templates were not edited.'
          : promptVersion === 3
            ? 'Phase 4 Arm A prompt v3. Frozen v1 and v2 templates were not edited.'
            : promptVersion === 2
              ? 'Phase 4 Arm A prompt v2. Frozen v1 templates were not edited.'
              : 'Phase 3 writer runs wait until Phase 2 review establishes the standing bar.'
    ],
    ...(armE || armF ? { guardVersion: armF ? ARM_F_GUARD_VERSION : ARM_E_GUARD_VERSION } : {})
  }
}

export function assertManifestComplete(manifest: WriterManifest): void {
  for (const key of requiredManifestKeys()) {
    if (!(key in manifest)) {
      throw new Error(`Manifest missing key: ${key}`)
    }
  }
  if (manifest.performanceEligible !== false) {
    throw new Error('Manifest must set performanceEligible to false')
  }
  if (typeof manifest.model.tag !== 'string' || manifest.model.tag.length === 0) {
    throw new Error('Manifest missing model tag')
  }
  if (typeof manifest.prompt.packSha256 !== 'string' || manifest.prompt.packSha256.length !== 64) {
    throw new Error('Manifest missing prompt pack hash')
  }
  if (!Array.isArray(manifest.prompt.templates) || manifest.prompt.templates.length === 0) {
    throw new Error('Manifest missing prompt templates')
  }
  if (
    typeof manifest.options.num_ctx !== 'number' ||
    typeof manifest.options.num_predict !== 'number'
  ) {
    throw new Error('Manifest missing generate options')
  }
}

export async function writeManifestFile(
  outputDirectory: string,
  manifest: WriterManifest
): Promise<string> {
  assertManifestComplete(manifest)
  const filePath = path.join(outputDirectory, 'manifest.json')
  await writeFile(filePath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  await chmod(filePath, 0o600)
  return filePath
}

export async function ensureNewPrivateOutputDir(
  outputDirectory: string,
  worktree: string
): Promise<string> {
  const output = path.resolve(outputDirectory)
  const repo = path.resolve(worktree)
  const relative = path.relative(repo, output)
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new Error('Output directory must be outside the Git worktree')
  }
  try {
    await access(output)
    throw new Error('Output directory already exists; refusing to overwrite')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await mkdir(output, { recursive: true, mode: 0o700 })
  await chmod(output, 0o700)
  return output
}
