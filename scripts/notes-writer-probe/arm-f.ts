import {
  ARM_F_NUM_CTX,
  ARM_F_NUM_PREDICT,
  ARM_F_RETRY_SEED,
  DEFAULT_SEED,
  STOP_CONDITIONS,
  type AllowedTemperature
} from './constants.ts'
import { containsCatalogItemId } from './arm-e.ts'
import { extraFacts, factsPass, missingFacts } from './facts.ts'
import { sha256Utf8 } from './hash.ts'
import type { GenerateRequest } from './ollama-client.ts'
import { ARM_F_COMPRESS_TEMPLATE_V2, fillTemplate } from './prompts.ts'
import { sanitizeMarkdown } from './sanitize.ts'
import { countWords, estimateTokens } from './tokens.ts'
import { scoreCoverage, type CoverageItem, type CoverageScore } from './coverage.ts'

export type NotesChunkKind = 'prefix' | 'topical' | 'decisions' | 'nextSteps'

export interface NotesChunk {
  kind: NotesChunkKind
  name: string | null
  raw: string
}

export interface ArmFCallPlan {
  role: 'compress'
  templateName: 'ARM_F_COMPRESS_TEMPLATE_V2'
  templateSha256: string
  filledPromptSha256: string
  prompt: string
  temperature: number
  seed: number
  request: Omit<GenerateRequest, 'model'>
}

export interface CompressionJudgment {
  accept: boolean
  reason: 'ok' | 'facts' | 'ungrounded' | 'coverage' | 'item-id'
  missingNumberCount: number
  missingNameCount: number
  extraNumberCount: number
  extraNameCount: number
  trialStrict: number
}

function compressRequest(
  prompt: string,
  temperature: AllowedTemperature,
  seed: number
): Omit<GenerateRequest, 'model'> {
  return {
    prompt,
    stream: true,
    options: {
      num_ctx: ARM_F_NUM_CTX,
      num_predict: ARM_F_NUM_PREDICT,
      temperature,
      seed,
      stop: STOP_CONDITIONS
    }
  }
}

export function splitNotesDocument(markdown: string): NotesChunk[] {
  const parts = markdown.split(/(?=^## )/mu)
  return parts.map((raw, index) => {
    if (index === 0 && !raw.startsWith('## ')) {
      return { kind: 'prefix', name: null, raw }
    }
    const first = raw.split('\n', 1)[0] ?? ''
    const name = first.replace(/^##\s+/u, '').trim()
    const key = name.toLowerCase()
    if (key === 'decisions') return { kind: 'decisions', name, raw }
    if (key === 'next steps') return { kind: 'nextSteps', name, raw }
    return { kind: 'topical', name, raw }
  })
}

export function joinNotesDocument(chunks: readonly NotesChunk[]): string {
  return chunks.map((chunk) => chunk.raw).join('')
}

export function sectionBody(raw: string): string {
  const newline = raw.indexOf('\n')
  if (newline < 0) return ''
  return raw.slice(newline + 1).replace(/\n$/u, '')
}

export function withSectionBody(raw: string, body: string): string {
  const newline = raw.indexOf('\n')
  const heading = newline < 0 ? raw : raw.slice(0, newline)
  const hadTrailingNewline = raw.endsWith('\n')
  const next = `${heading}\n${body.replace(/\n$/u, '')}`
  return hadTrailingNewline ? `${next}\n` : next
}

export function passthroughRaw(chunks: readonly NotesChunk[], kind: 'decisions' | 'nextSteps'): string {
  return chunks.find((chunk) => chunk.kind === kind)?.raw ?? ''
}

export function stripEmittedHeading(markdown: string, topicName: string): string {
  const sanitized = sanitizeMarkdown(markdown)
  const escaped = topicName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return sanitized
    .replace(new RegExp(`^#+\\s*${escaped}\\s*\\n+`, 'iu'), '')
    .replace(/^#+\s+.+\n+/u, '')
}

export function planArmFCompress(
  topicName: string,
  section: string,
  temperature: AllowedTemperature,
  seed: number = DEFAULT_SEED
): ArmFCallPlan {
  const prompt = fillTemplate(ARM_F_COMPRESS_TEMPLATE_V2, {
    TOPIC_NAME: topicName,
    SECTION: section
  })
  return {
    role: 'compress',
    templateName: 'ARM_F_COMPRESS_TEMPLATE_V2',
    templateSha256: sha256Utf8(ARM_F_COMPRESS_TEMPLATE_V2),
    filledPromptSha256: sha256Utf8(prompt),
    prompt,
    temperature,
    seed,
    request: compressRequest(prompt, temperature, seed)
  }
}

export function armFRetrySeed(): number {
  return ARM_F_RETRY_SEED
}

export function judgeCompression(args: {
  inputSection: string
  compressed: string
  trialDocument: string
  baselineStrict: number
  coverageItems: readonly CoverageItem[]
}): CompressionJudgment {
  const missing = missingFacts(args.inputSection, args.compressed)
  const extra = extraFacts(args.inputSection, args.compressed)
  if (containsCatalogItemId(args.compressed)) {
    return {
      accept: false,
      reason: 'item-id',
      missingNumberCount: 0,
      missingNameCount: 0,
      extraNumberCount: 0,
      extraNameCount: 0,
      trialStrict: 0
    }
  }
  if (!factsPass(args.inputSection, args.compressed)) {
    return {
      accept: false,
      reason: 'facts',
      missingNumberCount: missing.numbers.length,
      missingNameCount: missing.names.length,
      extraNumberCount: extra.numbers.length,
      extraNameCount: extra.names.length,
      trialStrict: 0
    }
  }
  if (extra.numbers.length > 0) {
    return {
      accept: false,
      reason: 'ungrounded',
      missingNumberCount: 0,
      missingNameCount: 0,
      extraNumberCount: extra.numbers.length,
      extraNameCount: extra.names.length,
      trialStrict: 0
    }
  }
  const coverage = scoreCoverage(args.trialDocument, args.coverageItems)
  if (coverage.strict < args.baselineStrict) {
    return {
      accept: false,
      reason: 'coverage',
      missingNumberCount: 0,
      missingNameCount: 0,
      extraNumberCount: extra.numbers.length,
      extraNameCount: extra.names.length,
      trialStrict: coverage.strict
    }
  }
  return {
    accept: true,
    reason: 'ok',
    missingNumberCount: 0,
    missingNameCount: 0,
    extraNumberCount: extra.numbers.length,
    extraNameCount: extra.names.length,
    trialStrict: coverage.strict
  }
}

export function reconstructWith(
  chunks: readonly NotesChunk[],
  index: number,
  body: string
): NotesChunk[] {
  return chunks.map((chunk, current) =>
    current === index ? { ...chunk, raw: withSectionBody(chunk.raw, body) } : chunk
  )
}

export function sectionStats(section: string): Record<string, number> {
  return {
    charCount: section.length,
    wordCount: countWords(section),
    estimatedTokens: estimateTokens(section)
  }
}

export function coverageDelta(before: CoverageScore, after: CoverageScore): number {
  return after.strict - before.strict
}
