import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_SEED, STOP_CONDITIONS } from '../constants.ts'
import {
  assertManifestComplete,
  buildManifest,
  ensureNewPrivateOutputDir,
  promptPackSha256,
  requiredManifestKeys,
  writeManifestFile
} from '../manifest.ts'
import type { ModelIdentity } from '../ollama-client.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  )
})

function identity(): ModelIdentity {
  return {
    tag: 'llama3.1:latest',
    digest: 'sha256:deadbeef',
    parameterSize: '8.0B',
    quantization: 'Q4_K_M',
    family: 'llama',
    modifiedAt: '2026-01-01T00:00:00Z'
  }
}

describe('manifest completeness', () => {
  it('includes every preregistration field and freezes performanceEligible', () => {
    const manifest = buildManifest({
      arm: 'a',
      temperature: 0,
      seed: DEFAULT_SEED,
      model: identity(),
      ollamaVersion: '0.30.0',
      options: {
        num_ctx: 32768,
        num_predict: 4096,
        temperature: 0,
        seed: DEFAULT_SEED,
        stop: STOP_CONDITIONS
      },
      stopConditions: STOP_CONDITIONS,
      filledPromptSha256: 'a'.repeat(64),
      projectionStats: { mode: 'single-call', estimatedTokens: 1 },
      createdAt: '2026-08-16T00:00:00.000Z'
    })
    expect(manifest.performanceEligible).toBe(false)
    expect(manifest.schemaVersion).toBe(1)
    expect(manifest.model.digest).toBe('sha256:deadbeef')
    expect(manifest.prompt.version).toBe(1)
    expect(manifest.prompt.v1ToV2Diff).toBeUndefined()
    expect(manifest.prompt.packSha256).toBe(promptPackSha256())
    expect(manifest.prompt.templates.map((item) => item.name)).toEqual([
      'ARM_A_DIRECT_TEMPLATE',
      'ARM_A_CHUNK_SUMMARY_TEMPLATE',
      'ARM_A_COMBINE_TEMPLATE',
      'ARM_B_TASK_VERBATIM',
      'ARM_B_TEMPLATE'
    ])
    for (const key of requiredManifestKeys()) {
      expect(manifest).toHaveProperty(key)
    }
    expect(() => assertManifestComplete(manifest)).not.toThrow()
  })

  it('hashes v2 templates and records the v1→v2 diff when promptVersion is 2', () => {
    const manifest = buildManifest({
      arm: 'a',
      temperature: 0.4,
      seed: DEFAULT_SEED,
      model: identity(),
      ollamaVersion: '0.30.0',
      options: {
        num_ctx: 32768,
        num_predict: 4096,
        temperature: 0.4,
        seed: DEFAULT_SEED,
        stop: STOP_CONDITIONS
      },
      stopConditions: STOP_CONDITIONS,
      filledPromptSha256: 'c'.repeat(64),
      projectionStats: { mode: 'single-call' },
      promptVersion: 2,
      createdAt: '2026-08-17T00:00:00.000Z'
    })
    expect(manifest.prompt.version).toBe(2)
    expect(manifest.prompt.packSha256).toBe(promptPackSha256(2))
    expect(manifest.prompt.templates.map((item) => item.name)).toEqual([
      'ARM_A_DIRECT_TEMPLATE_V2',
      'ARM_A_CHUNK_SUMMARY_TEMPLATE_V2',
      'ARM_A_COMBINE_TEMPLATE_V2'
    ])
    expect(manifest.prompt.v1ToV2Diff?.to).toBe('v2')
    expect(manifest.notes.some((note) => note.includes('prompt v2'))).toBe(true)
  })

  it('hashes v3 templates and records the v2→v3 diff when promptVersion is 3', () => {
    const manifest = buildManifest({
      arm: 'a',
      temperature: 0.4,
      seed: 43,
      model: identity(),
      ollamaVersion: '0.30.0',
      options: {
        num_ctx: 32768,
        num_predict: 4096,
        temperature: 0.4,
        seed: 43,
        stop: STOP_CONDITIONS
      },
      stopConditions: STOP_CONDITIONS,
      filledPromptSha256: 'd'.repeat(64),
      projectionStats: { mode: 'single-call' },
      promptVersion: 3,
      createdAt: '2026-08-17T00:00:00.000Z'
    })
    expect(manifest.prompt.version).toBe(3)
    expect(manifest.prompt.packSha256).toBe(promptPackSha256(3))
    expect(manifest.prompt.templates.map((item) => item.name)).toEqual([
      'ARM_A_DIRECT_TEMPLATE_V3',
      'ARM_A_CHUNK_SUMMARY_TEMPLATE_V3',
      'ARM_A_COMBINE_TEMPLATE_V3'
    ])
    expect(manifest.prompt.v2ToV3Diff?.to).toBe('v3')
    expect(manifest.notes.some((note) => note.includes('prompt v3'))).toBe(true)
  })

  it('hashes the Arm C extractor template and does not record Arm A diffs', () => {
    const manifest = buildManifest({
      arm: 'c',
      temperature: 0,
      seed: 42,
      model: identity(),
      ollamaVersion: '0.30.0',
      options: {
        num_ctx: 32768,
        num_predict: 2048,
        temperature: 0,
        seed: 42,
        stop: STOP_CONDITIONS
      },
      stopConditions: STOP_CONDITIONS,
      filledPromptSha256: 'e'.repeat(64),
      projectionStats: { mode: 'single-call' },
      createdAt: '2026-08-17T00:00:00.000Z'
    })
    expect(manifest.arm).toBe('c')
    expect(manifest.prompt.templates.map((item) => item.name)).toEqual(['ARM_C_TEMPLATE'])
    expect(manifest.prompt.packSha256).toBe(promptPackSha256(1, 'c'))
    expect(manifest.prompt.v1ToV2Diff).toBeUndefined()
    expect(manifest.prompt.v2ToV3Diff).toBeUndefined()
    expect(manifest.notes.some((note) => note.includes('commitment extractor'))).toBe(true)
  })

  it('hashes the Arm D restyle template and does not record Arm A diffs', () => {
    const manifest = buildManifest({
      arm: 'd',
      temperature: 0.4,
      seed: 42,
      model: identity(),
      ollamaVersion: '0.30.0',
      options: {
        num_ctx: 16384,
        num_predict: 4096,
        temperature: 0.4,
        seed: 42,
        stop: STOP_CONDITIONS
      },
      stopConditions: STOP_CONDITIONS,
      filledPromptSha256: 'f'.repeat(64),
      projectionStats: { mode: 'single-call' },
      createdAt: '2026-08-17T00:00:00.000Z'
    })
    expect(manifest.arm).toBe('d')
    expect(manifest.prompt.templates.map((item) => item.name)).toEqual(['ARM_D_TEMPLATE'])
    expect(manifest.prompt.packSha256).toBe(promptPackSha256(1, 'd'))
    expect(manifest.prompt.v1ToV2Diff).toBeUndefined()
    expect(manifest.prompt.v2ToV3Diff).toBeUndefined()
    expect(manifest.inputProjection.description).toContain('verified commitment list')
    expect(manifest.notes.some((note) => note.includes('restyle-legacy'))).toBe(true)
  })

  it('hashes the Arm E grouping and restyle templates and does not record Arm A diffs', () => {
    const manifest = buildManifest({
      arm: 'e',
      temperature: 0.4,
      seed: 42,
      model: identity(),
      ollamaVersion: '0.30.0',
      options: {
        num_ctx: 8192,
        num_predict: 1024,
        temperature: 0,
        seed: 42,
        stop: STOP_CONDITIONS
      },
      stopConditions: STOP_CONDITIONS,
      filledPromptSha256: 'e'.repeat(64),
      projectionStats: { mode: 'chunked-restyle' },
      createdAt: '2026-08-17T00:00:00.000Z'
    })
    expect(manifest.arm).toBe('e')
    expect(manifest.prompt.templates.map((item) => item.name)).toEqual([
      'ARM_E_GROUP_TEMPLATE',
      'ARM_E_RESTYLE_TEMPLATE'
    ])
    expect(manifest.prompt.packSha256).toBe(promptPackSha256(1, 'e'))
    expect(manifest.prompt.v1ToV2Diff).toBeUndefined()
    expect(manifest.prompt.v2ToV3Diff).toBeUndefined()
    expect(manifest.inputProjection.description).toContain('parsed into discrete items')
    expect(manifest.notes.some((note) => note.includes('chunked restyle'))).toBe(true)
    expect(manifest.guardVersion).toBe(3)
  })

  it('hashes the Arm F compress template and does not record Arm A diffs', () => {
    const manifest = buildManifest({
      arm: 'f',
      temperature: 0.4,
      seed: 42,
      model: identity(),
      ollamaVersion: '0.30.0',
      options: {
        num_ctx: 8192,
        num_predict: 1024,
        temperature: 0.4,
        seed: 42,
        stop: STOP_CONDITIONS
      },
      stopConditions: STOP_CONDITIONS,
      filledPromptSha256: 'f'.repeat(64),
      projectionStats: { mode: 'section-compress' },
      createdAt: '2026-08-17T00:00:00.000Z'
    })
    expect(manifest.arm).toBe('f')
    expect(manifest.prompt.templates.map((item) => item.name)).toEqual(['ARM_F_COMPRESS_TEMPLATE_V2'])
    expect(manifest.prompt.packSha256).toBe(promptPackSha256(1, 'f'))
    expect(manifest.prompt.v1ToV2Diff).toBeUndefined()
    expect(manifest.prompt.v2ToV3Diff).toBeUndefined()
    expect(manifest.inputProjection.description).toContain('compression')
    expect(manifest.notes.some((note) => note.includes('per-section compression'))).toBe(true)
    expect(manifest.guardVersion).toBe(3)
  })

  it('writes the manifest file and refuses to reuse an existing output directory', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'notes-writer-probe-'))
    temporaryDirectories.push(parent)
    const worktree = path.join(parent, 'repo')
    await mkdir(worktree)
    const output = path.join(parent, 'results', 'run-1')
    const created = await ensureNewPrivateOutputDir(output, worktree)
    expect(created).toBe(path.resolve(output))
    await expect(ensureNewPrivateOutputDir(output, worktree)).rejects.toThrow('already exists')
    await expect(
      ensureNewPrivateOutputDir(path.join(worktree, 'inside'), worktree)
    ).rejects.toThrow('outside the Git worktree')
    const manifest = buildManifest({
      arm: 'b',
      temperature: 0.4,
      seed: DEFAULT_SEED,
      model: identity(),
      ollamaVersion: '0.30.0',
      options: {
        num_ctx: 16384,
        num_predict: 2048,
        temperature: 0.4,
        seed: DEFAULT_SEED,
        stop: STOP_CONDITIONS
      },
      stopConditions: STOP_CONDITIONS,
      filledPromptSha256: 'b'.repeat(64),
      projectionStats: { mode: 'single-call' }
    })
    const filePath = await writeManifestFile(created, manifest)
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as { performanceEligible: boolean }
    expect(parsed.performanceEligible).toBe(false)
  })
})
