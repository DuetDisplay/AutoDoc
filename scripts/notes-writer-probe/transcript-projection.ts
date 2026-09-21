import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

import {
  CHUNK_OVERLAP_TOKENS,
  CHUNK_TARGET_TOKENS,
  CONTEXT_32K_TOKENS,
  CONTEXT_8K_TOKENS,
  SINGLE_CALL_LEFTOVER_HEADROOM_TOKENS
} from './constants.ts'
import { countWords, estimateTokens } from './tokens.ts'

export interface TranscriptTurn {
  speaker: string
  text: string
  startMs?: number
  endMs?: number
}

export interface LabeledTurn {
  speakerLabel: string
  text: string
}

export interface TranscriptChunk {
  index: number
  total: number
  turns: LabeledTurn[]
  text: string
  estimatedTokens: number
}

export interface ProjectionStats {
  turnCount: number
  charCount: number
  wordCount: number
  estimatedTokens: number
  titleCharCount: number
  context8kFits: boolean
  context32kFitsWithHeadroom: boolean
  mode: 'single-call' | 'chunk-hierarchy'
  chunkCount: number
  chunkTargetTokens: number
  chunkOverlapTokens: number
  leftoverHeadroomTokens: number
  contextBudgetTokens: number
}

export interface TranscriptProjection {
  title: string
  turns: LabeledTurn[]
  text: string
  stats: ProjectionStats
  chunks: TranscriptChunk[]
}

interface SpeakerRecord {
  label?: string
}

const TIMESTAMP_PREFIX =
  /^(?:\[?\d{1,2}:\d{2}(?::\d{2})?(?:\s*[–-]\s*\d{1,2}:\d{2}(?::\d{2})?)?\]?\s*)/u

export function stripTimestampPrefix(text: string): string {
  return text.replace(TIMESTAMP_PREFIX, '').trim()
}

export function speakerLabelFor(speaker: string, labels: Record<string, string> = {}): string {
  const key = speaker.trim().toLowerCase()
  if (labels[key]) return labels[key]
  if (key === 'me') return 'Me'
  if (key === 'them') return 'Them'
  if (speaker.trim().length === 0) return 'Unknown'
  return speaker.trim()
}

export function formatTurn(turn: LabeledTurn): string {
  return `${turn.speakerLabel}: ${stripTimestampPrefix(turn.text)}`
}

export function renderProjectionText(title: string, turns: LabeledTurn[]): string {
  const body = turns.map(formatTurn).join('\n')
  return `Meeting: ${title}\n\n${body}`
}

export function chunkTurns(
  turns: LabeledTurn[],
  targetTokens = CHUNK_TARGET_TOKENS,
  overlapTokens = CHUNK_OVERLAP_TOKENS
): TranscriptChunk[] {
  if (turns.length === 0) return []
  const tokenCounts = turns.map((turn) => estimateTokens(formatTurn(turn)))
  const groups: LabeledTurn[][] = []
  let start = 0
  while (start < turns.length) {
    let end = start
    let tokens = 0
    while (end < turns.length) {
      const next = tokenCounts[end] ?? 0
      if (end > start && tokens + next > targetTokens) break
      tokens += next
      end += 1
    }
    if (end === start) end = start + 1
    groups.push(turns.slice(start, end))
    if (end >= turns.length) break
    let overlap = 0
    let nextStart = end
    while (nextStart > start && overlap < overlapTokens) {
      nextStart -= 1
      overlap += tokenCounts[nextStart] ?? 0
    }
    if (nextStart <= start) nextStart = start + 1
    start = nextStart
  }
  const total = groups.length
  return groups.map((group, index) => {
    const text = group.map(formatTurn).join('\n')
    return {
      index: index + 1,
      total,
      turns: group,
      text,
      estimatedTokens: estimateTokens(text)
    }
  })
}

export function chooseWriterMode(
  filledPromptTokens: number,
  numPredict: number,
  contextBudget = CONTEXT_32K_TOKENS,
  leftoverHeadroom = SINGLE_CALL_LEFTOVER_HEADROOM_TOKENS
): 'single-call' | 'chunk-hierarchy' {
  return filledPromptTokens + numPredict + leftoverHeadroom <= contextBudget
    ? 'single-call'
    : 'chunk-hierarchy'
}

export function projectTurns(
  title: string,
  turns: LabeledTurn[],
  directPromptTokensWithoutTranscript: number,
  numPredict: number
): TranscriptProjection {
  const text = renderProjectionText(title, turns)
  const estimatedTokens = estimateTokens(text)
  const filledDirectTokens = directPromptTokensWithoutTranscript + estimatedTokens
  const mode = chooseWriterMode(filledDirectTokens, numPredict)
  const chunks = chunkTurns(turns)
  const stats: ProjectionStats = {
    turnCount: turns.length,
    charCount: text.length,
    wordCount: countWords(text),
    estimatedTokens,
    titleCharCount: title.length,
    context8kFits:
      estimatedTokens + directPromptTokensWithoutTranscript + numPredict <= CONTEXT_8K_TOKENS,
    context32kFitsWithHeadroom:
      filledDirectTokens + numPredict + SINGLE_CALL_LEFTOVER_HEADROOM_TOKENS <= CONTEXT_32K_TOKENS,
    mode,
    chunkCount: mode === 'single-call' ? 1 : chunks.length,
    chunkTargetTokens: CHUNK_TARGET_TOKENS,
    chunkOverlapTokens: CHUNK_OVERLAP_TOKENS,
    leftoverHeadroomTokens: SINGLE_CALL_LEFTOVER_HEADROOM_TOKENS,
    contextBudgetTokens: CONTEXT_32K_TOKENS
  }
  return { title, turns, text, stats, chunks }
}

function asTurns(value: unknown): TranscriptTurn[] {
  if (!Array.isArray(value)) {
    throw new Error('Transcript JSON must be an array of turns')
  }
  return value.map((item, index) => {
    if (item === null || typeof item !== 'object') {
      throw new Error(`Transcript turn ${index} is not an object`)
    }
    const record = item as Record<string, unknown>
    if (typeof record.text !== 'string' || typeof record.speaker !== 'string') {
      throw new Error(`Transcript turn ${index} missing speaker or text`)
    }
    return {
      speaker: record.speaker,
      text: record.text,
      startMs: typeof record.startMs === 'number' ? record.startMs : undefined,
      endMs: typeof record.endMs === 'number' ? record.endMs : undefined
    }
  })
}

function labelsFromSpeakers(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object') return {}
  const labels: Record<string, string> = {}
  for (const [key, record] of Object.entries(value as Record<string, SpeakerRecord>)) {
    if (record && typeof record.label === 'string' && record.label.trim().length > 0) {
      labels[key.toLowerCase()] = record.label.trim()
    }
  }
  return labels
}

async function readJsonIfExists(filePath: string): Promise<unknown | null> {
  try {
    await stat(filePath)
  } catch {
    return null
  }
  return JSON.parse(await readFile(filePath, 'utf8')) as unknown
}

export function parseDerivedMarkdown(markdown: string): LabeledTurn[] {
  const turns: LabeledTurn[] = []
  for (const line of markdown.split(/\r?\n/u)) {
    const match = line.match(
      /^- \*\*(?:\d{2}:\d{2}:\d{2}–\d{2}:\d{2}:\d{2} · )?([^:*]+):\*\* (.*)$/u
    )
    if (!match) continue
    const speaker = speakerLabelFor(match[1] ?? '')
    const text = stripTimestampPrefix(match[2] ?? '')
    if (text.length === 0) continue
    turns.push({ speakerLabel: speaker, text })
  }
  return turns
}

async function resolveFixturePaths(fixture: string): Promise<{
  transcriptJson: string | null
  derivedMarkdown: string | null
  metadataJson: string | null
  speakersJson: string | null
  manifestJson: string | null
}> {
  const resolved = path.resolve(fixture)
  const stats = await stat(resolved)
  if (stats.isFile()) {
    const dir = path.dirname(resolved)
    const decrypted = path.basename(dir) === 'decrypted' ? dir : null
    const fixtureRoot = decrypted ? path.resolve(decrypted, '../..') : dir
    return {
      transcriptJson: resolved.endsWith('.json') ? resolved : null,
      derivedMarkdown: resolved.endsWith('.md') ? resolved : null,
      metadataJson: decrypted
        ? path.join(decrypted, 'metadata.json')
        : path.join(dir, 'metadata.json'),
      speakersJson: decrypted
        ? path.join(decrypted, 'speakers.json')
        : path.join(dir, 'speakers.json'),
      manifestJson: path.join(fixtureRoot, 'manifest.json')
    }
  }
  const decrypted = path.join(resolved, 'autodoc', 'decrypted')
  return {
    transcriptJson: path.join(decrypted, 'transcript.json'),
    derivedMarkdown: path.join(resolved, 'autodoc', 'derived', 'transcript.md'),
    metadataJson: path.join(decrypted, 'metadata.json'),
    speakersJson: path.join(decrypted, 'speakers.json'),
    manifestJson: path.join(resolved, 'manifest.json')
  }
}

function titleFromSidecars(metadata: unknown, manifest: unknown): string | null {
  if (metadata !== null && typeof metadata === 'object') {
    const sourceName = (metadata as { sourceName?: unknown }).sourceName
    if (typeof sourceName === 'string' && sourceName.trim().length > 0) return sourceName.trim()
  }
  if (manifest !== null && typeof manifest === 'object') {
    const meeting = (manifest as { meeting?: { autoDocDisplayTitle?: unknown } }).meeting
    const title = meeting?.autoDocDisplayTitle
    if (typeof title === 'string' && title.trim().length > 0) return title.trim()
  }
  return null
}

export async function loadFixtureProjection(
  fixture: string,
  directPromptTokensWithoutTranscript: number,
  numPredict: number,
  titleOverride?: string
): Promise<TranscriptProjection> {
  const paths = await resolveFixturePaths(fixture)
  const metadata = paths.metadataJson ? await readJsonIfExists(paths.metadataJson) : null
  const speakers = paths.speakersJson ? await readJsonIfExists(paths.speakersJson) : null
  const manifest = paths.manifestJson ? await readJsonIfExists(paths.manifestJson) : null
  const labels = labelsFromSpeakers(speakers)
  const title = titleOverride?.trim() || titleFromSidecars(metadata, manifest) || 'Meeting'

  let labeled: LabeledTurn[] = []
  if (paths.transcriptJson) {
    const raw = await readJsonIfExists(paths.transcriptJson)
    if (raw !== null) {
      labeled = asTurns(raw).map((turn) => ({
        speakerLabel: speakerLabelFor(turn.speaker, labels),
        text: stripTimestampPrefix(turn.text)
      }))
    }
  }
  if (labeled.length === 0 && paths.derivedMarkdown) {
    const markdown = await readFile(paths.derivedMarkdown, 'utf8')
    labeled = parseDerivedMarkdown(markdown)
  }
  if (labeled.length === 0) {
    throw new Error('Fixture contained no transcript turns')
  }
  return projectTurns(title, labeled, directPromptTokensWithoutTranscript, numPredict)
}
