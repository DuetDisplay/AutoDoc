import {
  armERetrySeed,
  catalogTextById,
  containsCatalogItemId,
  planArmEGroup,
  planArmERestyle,
  splitLegacyItems,
  toCatalogItem
} from '../../../scripts/notes-writer-probe/arm-e.ts'
import {
  armFRetrySeed,
  joinNotesDocument,
  judgeCompression,
  planArmFCompress,
  reconstructWith,
  sectionBody,
  splitNotesDocument,
  stripEmittedHeading
} from '../../../scripts/notes-writer-probe/arm-f.ts'
import { applyArmG } from '../../../scripts/notes-writer-probe/arm-g.ts'
import { composeDocument, renderUnrestyledItems, unionNextSteps } from '../../../scripts/notes-writer-probe/compose.ts'
import { DEFAULT_SEED, type AllowedTemperature } from '../../../scripts/notes-writer-probe/constants.ts'
import { scoreCoverage, type CoverageItem } from '../../../scripts/notes-writer-probe/coverage.ts'
import { factsPass } from '../../../scripts/notes-writer-probe/facts.ts'
import {
  fallbackBucketGroups,
  fallbackWriterTopicGroups,
  parseGroupingJson,
  type CatalogItem,
  type TopicGroup
} from '../../../scripts/notes-writer-probe/groups.ts'
import { sanitizeMarkdown } from '../../../scripts/notes-writer-probe/sanitize.ts'
import type { MeetingNotesContent, MeetingSegments } from '../../shared/types'
import { attachNotesTimestamps } from './notes-attach-timestamps'
import { emptyValidationStats, type NotesValidationStats, type TranscriptRow } from './notes-evidence-validate'
import { generateNotesOverview } from './notes-overview'
import { meetingSpanSources, parseScanMarkdown } from './notes-scan-markdown'
import { NOTES_SCAN_PROGRESS_END, NOTES_WRITER_PROGRESS_END } from '../../shared/constants'
import { applyNotesBudget, countWords } from './notes-scan-budget'
import {
  appendTranscriptTickets,
  chooseScanGroups,
  dropAssertiveTakeaways,
  entitiesPreserved,
  preserveWriterEntities
} from './notes-scan-preserve'

export interface ScanGenerateRequest {
  prompt: string
  num_ctx: number
  num_predict: number
  temperature: number
  seed: number
  stop: readonly string[]
}

export type ScanGenerateFn = (request: ScanGenerateRequest) => Promise<string>

export interface RunNotesScanOptions {
  title: string
  generate: ScanGenerateFn
  spanSources: { startMs: number; endMs: number }[]
  transcript?: readonly TranscriptRow[]
  seed?: number
  temperature?: AllowedTemperature
  onProgress?: (update: { stage: string; fraction: number }) => void
}

export function scanLayerProgress(fraction: number): number {
  const clamped = Math.min(1, Math.max(0, fraction))
  return Math.min(
    NOTES_SCAN_PROGRESS_END,
    NOTES_WRITER_PROGRESS_END +
      Math.round(clamped * (NOTES_SCAN_PROGRESS_END - NOTES_WRITER_PROGRESS_END))
  )
}

export interface NotesScanResult {
  markdown: string
  content: MeetingNotesContent
  groupingFallback: boolean
  restyleFallbacks: number
  compressFallbacks: number
  attachFailed: boolean
  overviewFailed: boolean
  validation: NotesValidationStats
}

function catalogById(catalog: readonly CatalogItem[]): Map<string, CatalogItem> {
  return new Map(catalog.map((row) => [row.id, row]))
}

function itemsForGroup(group: TopicGroup, byId: Map<string, CatalogItem>): CatalogItem[] {
  return group.ids.map((id) => byId.get(id)).filter((row): row is CatalogItem => row !== undefined)
}

const TICKET_COVERAGE_RE = /\bDD[- ]?\d{2,5}\b/gi
const NUMBER_UNIT_COVERAGE_RE =
  /\b\d+(?:\.\d+)?\s*(?:%|x|ms|secs?|seconds?|mins?|minutes?|hrs?|hours?|days?|kb|mb|gb|tb)\b/gi
const VERSION_COVERAGE_RE = /\b\d+(?:\.\d+){1,3}\b/g
const STANDALONE_NUMBER_COVERAGE_RE = /\b\d{2,}(?:[.,]\d+)?\b/g

function rangesOverlap(start: number, end: number, occupied: readonly [number, number][]): boolean {
  return occupied.some(([left, right]) => start < right && end > left)
}

export function coverageItemsFromSection(inputSection: string): CoverageItem[] {
  const items: CoverageItem[] = []
  const seen = new Set<string>()
  const occupied: [number, number][] = []

  const add = (type: string, claim: string, start: number, end: number): void => {
    const key = `${type}:${claim.toLowerCase()}`
    if (seen.has(key)) return
    seen.add(key)
    occupied.push([start, end])
    items.push({
      id: `cov-${items.length + 1}`,
      type,
      claim,
      grounded: true
    })
  }

  for (const match of inputSection.matchAll(TICKET_COVERAGE_RE)) {
    if (match.index == null) continue
    add('ticket', match[0], match.index, match.index + match[0].length)
  }
  for (const match of inputSection.matchAll(NUMBER_UNIT_COVERAGE_RE)) {
    if (match.index == null) continue
    if (rangesOverlap(match.index, match.index + match[0].length, occupied)) continue
    add('quantity', match[0].replace(/\s+/g, ''), match.index, match.index + match[0].length)
  }
  for (const match of inputSection.matchAll(VERSION_COVERAGE_RE)) {
    if (match.index == null) continue
    if (rangesOverlap(match.index, match.index + match[0].length, occupied)) continue
    add('quantity', match[0], match.index, match.index + match[0].length)
  }
  for (const match of inputSection.matchAll(STANDALONE_NUMBER_COVERAGE_RE)) {
    if (match.index == null) continue
    if (rangesOverlap(match.index, match.index + match[0].length, occupied)) continue
    add('quantity', match[0], match.index, match.index + match[0].length)
  }
  return items
}

async function generateFromPlan(
  generate: ScanGenerateFn,
  plan: {
    prompt: string
    request: {
      options: {
        num_ctx: number
        num_predict: number
        temperature: number
        seed: number
        stop: readonly string[]
      }
    }
  }
): Promise<string> {
  const options = plan.request.options
  return generate({
    prompt: plan.prompt,
    num_ctx: options.num_ctx,
    num_predict: options.num_predict,
    temperature: options.temperature,
    seed: options.seed,
    stop: options.stop
  })
}

export async function runNotesScanPipeline(
  segments: MeetingSegments,
  options: RunNotesScanOptions
): Promise<NotesScanResult> {
  const seed = options.seed ?? DEFAULT_SEED
  const temperature = options.temperature ?? 0.4
  const reportProgress = (stage: string, fraction: number): void => {
    options.onProgress?.({ stage, fraction: Math.min(1, Math.max(0, fraction)) })
  }
  reportProgress('scan-start', 0)
  const split = splitLegacyItems(segments)
  const topical = [
    ...split.topical,
    ...split.decisions.map((item, index) => toCatalogItem(item, split.topical.length + index))
  ]
  const actions = split.actions.map((item, index) => toCatalogItem(item, topical.length + index))
  const topicalIds = topical.map((row) => row.id)
  const groupingLimits = { minGroups: 2, maxGroups: 8 }

  const groupPlan = planArmEGroup(topical, seed)
  let groupingText = await generateFromPlan(options.generate, groupPlan)
  let groupingValidation = parseGroupingJson(groupingText, topicalIds, topical, groupingLimits)
  if (!groupingValidation.ok) {
    groupingText = await generateFromPlan(
      options.generate,
      planArmEGroup(topical, armERetrySeed())
    )
    groupingValidation = parseGroupingJson(groupingText, topicalIds, topical, groupingLimits)
  }
  const writerTopicGroups = fallbackWriterTopicGroups(topical)
  const chosen = chooseScanGroups(
    groupingValidation.ok ? groupingValidation.groups : null,
    writerTopicGroups,
    topical
  )
  const groupingFallback =
    chosen.groupingFallback && (chosen.groups.length === 0 || fallbackBucketGroups(topical).length === 0)
  const groups =
    chosen.groups.length > 0 ? chosen.groups : fallbackBucketGroups(topical)
  reportProgress('grouping', 0.12)

  const byId = catalogById(topical)
  const sectionBodies: { name: string; markdown: string }[] = []
  let restyleFallbacks = 0
  for (const [groupIndex, group] of groups.entries()) {
    const members = itemsForGroup(group, byId)
    const inputText = members.map((row) => row.fullText).join('\n')
    let markdown = sanitizeMarkdown(
      await generateFromPlan(
        options.generate,
        planArmERestyle(group.name, members, temperature, seed)
      )
    )
    if (
      !factsPass(inputText, markdown) ||
      containsCatalogItemId(markdown) ||
      !entitiesPreserved(inputText, markdown)
    ) {
      markdown = sanitizeMarkdown(
        await generateFromPlan(
          options.generate,
          planArmERestyle(group.name, members, temperature, armERetrySeed())
        )
      )
    }
    if (
      !factsPass(inputText, markdown) ||
      containsCatalogItemId(markdown) ||
      !entitiesPreserved(inputText, markdown)
    ) {
      restyleFallbacks += 1
      markdown = renderUnrestyledItems(members.map((row) => row.item))
    }
    sectionBodies.push({ name: group.name, markdown })
    reportProgress('restyle', 0.12 + (0.43 * (groupIndex + 1)) / Math.max(groups.length, 1))
  }

  const composed = sanitizeMarkdown(
    composeDocument({
      title: options.title,
      sections: sectionBodies,
      decisions: [],
      nextSteps: unionNextSteps(split.actions, [])
    })
  )

  const chunks = splitNotesDocument(composed)
  let working = chunks.map((chunk) => ({ ...chunk }))
  let compressFallbacks = 0
  const topicalChunks = working.filter((chunk) => chunk.kind === 'topical')
  let compressDone = 0
  for (const [index, chunk] of working.entries()) {
    if (chunk.kind !== 'topical') continue
    const inputText = sectionBody(chunk.raw)
    const coverageItems = coverageItemsFromSection(inputText)
    const accept = (text: string): boolean =>
      entitiesPreserved(inputText, text) &&
      (countWords(inputText) < 80 || countWords(text) <= countWords(inputText)) &&
      judgeCompression({
        inputSection: inputText,
        compressed: text,
        trialDocument: joinNotesDocument(reconstructWith(working, index, text)),
        baselineStrict: scoreCoverage(inputText, coverageItems).strict,
        coverageItems
      }).accept
    let markdown = stripEmittedHeading(
      await generateFromPlan(
        options.generate,
        planArmFCompress(chunk.name ?? 'Topic', inputText, temperature, seed)
      ),
      chunk.name ?? ''
    )
    if (!accept(markdown)) {
      markdown = stripEmittedHeading(
        await generateFromPlan(
          options.generate,
          planArmFCompress(chunk.name ?? 'Topic', inputText, temperature, armFRetrySeed())
        ),
        chunk.name ?? ''
      )
    }
    if (!accept(markdown)) {
      compressFallbacks += 1
      markdown = inputText
    }
    working = reconstructWith(working, index, markdown)
    compressDone += 1
    reportProgress(
      'compress',
      0.55 + (0.32 * compressDone) / Math.max(topicalChunks.length, 1)
    )
  }

  const compressed = joinNotesDocument(working)
  const presented = applyArmG(compressed, { sourceCatalog: catalogTextById(topical) })
  const meetingSpan = meetingSpanSources(options.spanSources)
  let content = parseScanMarkdown(presented.markdown, {
    fallbackSources: meetingSpan
  })
  let attachFailed = false
  try {
    content = attachNotesTimestamps(content, {
      topical,
      actions,
      groups,
      meetingSpan
    })
  } catch {
    attachFailed = true
  }

  let overviewFailed = false
  reportProgress('overview', 0.9)
  try {
    const overview = await generateNotesOverview(
      presented.markdown,
      (request) =>
        options.generate({
          ...request,
          seed,
          stop: []
        }),
      meetingSpan
    )
    content = dropAssertiveTakeaways({
      ...content,
      overview: overview.overview,
      keyTakeaways: overview.keyTakeaways
    })
  } catch {
    overviewFailed = true
  }

  content = preserveWriterEntities(content, [...topical, ...actions])
  const transcript = options.transcript ?? []
  if (transcript.length > 0) {
    content = appendTranscriptTickets(content, transcript)
  }
  const durationMs = meetingSpan[0] ? meetingSpan[0].endMs - meetingSpan[0].startMs : 0
  content = applyNotesBudget(content, durationMs)
  const validation = emptyValidationStats(false)
  reportProgress('budget', 1)

  return {
    markdown: presented.markdown,
    content,
    groupingFallback,
    restyleFallbacks,
    compressFallbacks,
    attachFailed,
    overviewFailed,
    validation
  }
}
