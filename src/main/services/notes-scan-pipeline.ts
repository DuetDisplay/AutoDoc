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
import {
  composeDocument,
  renderUnrestyledItems,
  unionNextSteps
} from '../../../scripts/notes-writer-probe/compose.ts'
import {
  DEFAULT_SEED,
  type AllowedTemperature
} from '../../../scripts/notes-writer-probe/constants.ts'
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
import { nestFlatPeerKeyPoints } from '../../shared/notes-section-display'
import type { MeetingNotesContent, MeetingSegments, MeetingSegmentsWithCandidates, Transcript } from '../../shared/types'
import { attachNotesTimestamps } from './notes-attach-timestamps'
import {
  emptyValidationStats,
  type NotesValidationStats,
  type TranscriptRow
} from './notes-evidence-validate'
import {
  losslessPresentationStats,
  presentMeetingSegmentsLosslessly
} from './notes-lossless-presenter'
import { recoverExplicitTranscriptActions } from './notes-explicit-action-recovery'
import { withoutNextStepCandidates } from './writer-catalog'
import { presentActionContext, refineNextSteps } from './notes-action-context'
import { restoreActionContinuations } from './notes-action-continuation'
import { recoverExplicitTranscriptDecisions } from './notes-explicit-decision-recovery'
import {
  dedupeWindowsNotes,
  isWindowsNotesQualityEnabled,
  isWindowsTopicWriterEnabled
} from './windows-notes-experiment'
import { organizeWindowsNotes } from './windows-notes-organization'
import { isWindowsEvidenceWriterEnabled } from './windows-notes-evidence'
import { resolveSpeakerAwareOwner } from './notes-owner-attribution'
import { generateNotesOverview, notesCatalogMarkdown } from './notes-overview'
import { fallbackMeetingOverviewFromNotes } from '../../shared/notes-overview-text'
import { meetingSpanSources, parseScanMarkdown } from './notes-scan-markdown'
import { NOTES_SCAN_PROGRESS_END, NOTES_WRITER_PROGRESS_END } from '../../shared/constants'
import { applyNotesBudget, countWords } from './notes-scan-budget'
import {
  appendTranscriptQuantities,
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
  /** Ollama structured-output schema for JSON responses (overview pass). */
  format?: unknown
}

export type ScanGenerateFn = (request: ScanGenerateRequest) => Promise<string>

export interface NotesRewritePolicy {
  /** LLM attempts per section/chunk before deterministic fallback (today: 2). */
  maxAttemptsPerSection: 1 | 2
  /** After this many consecutive rejections, stop attempting LLM rewrites for the remaining sections/chunks (null = never bail, today's behavior). */
  bailAfterConsecutiveRejects: number | null
  /** Skip restyle and compress entirely (eval-only Item 4 extreme). */
  skipRewrites?: boolean
  /** Skip grouping and overview LLM calls; use writer/catalog groups and fallback overview. */
  skipStructureLlm?: boolean
}

export const DEFAULT_NOTES_REWRITE_POLICY: NotesRewritePolicy = {
  maxAttemptsPerSection: 2,
  bailAfterConsecutiveRejects: null
}

export interface RunNotesScanOptions {
  embed?: (texts: string[]) => Promise<number[][]>
  title: string
  generate: ScanGenerateFn
  spanSources: { startMs: number; endMs: number }[]
  transcript?: readonly TranscriptRow[]
  /** Explicitly selects the model-free structured presenter. Omission keeps the legacy scan path. */
  presentationMode?: 'lossless'
  /** Required evidence for conservative action-owner attribution in lossless mode. */
  attributionTranscript?: readonly Transcript[]
  /** Safe local label for explicit commitments spoken on the captured `me` channel. */
  localOwnerLabel?: string | null
  /** Required by the lossless presenter, including when the writer returned no records. */
  meetingId?: string
  seed?: number
  temperature?: AllowedTemperature
  onProgress?: (update: { stage: string; fraction: number }) => void
  rewritePolicy?: NotesRewritePolicy
}

export function scanLayerProgress(fraction: number): number {
  const clamped = Math.min(1, Math.max(0, fraction))
  return Math.min(
    NOTES_SCAN_PROGRESS_END,
    NOTES_WRITER_PROGRESS_END +
      Math.round(clamped * (NOTES_SCAN_PROGRESS_END - NOTES_WRITER_PROGRESS_END))
  )
}

export type ScanRewriteRejectReason =
  | 'facts'
  | 'catalog-id'
  | 'entities'
  | 'grew'
  | 'item-id'
  | 'ungrounded'
  | 'coverage'

export interface NotesScanResult {
  markdown: string
  content: MeetingNotesContent
  presentationMode?: 'lossless' | 'scan'
  exactWriterCoverage?: boolean
  contextualizedNextStepCount?: number
  organizationAttempted?: boolean
  organizationAccepted?: boolean
  organizationOverviewAccepted?: boolean
  attributionOwnersAdded?: number
  attributionOwnersStripped?: number
  attributionOwnersPreserved?: number
  attributionOwnersChanged?: number
  recoveredActionCount?: number
  promotedActionCount?: number
  dedupedRecoveredActionCount?: number
  recoveredDecisionCount?: number
  promotedDecisionCount?: number
  dedupedRecoveredDecisionCount?: number
  overviewSkipped?: boolean
  groupingFallback: boolean
  topicCoveragePercent?: number
  genericHeadingPercent?: number
  needsReviewCount?: number
  contextDependentRejected?: number
  restyleFallbacks: number
  compressFallbacks: number
  restyleSkips: number
  compressSkips: number
  restyleRejectReasons: ScanRewriteRejectReason[]
  compressRejectReasons: ScanRewriteRejectReason[]
  attachFailed: boolean
  overviewFailed: boolean
  overviewFailureReasons: string[]
  validation: NotesValidationStats
}

export function restyleRejectReason(
  input: string,
  output: string
): Extract<ScanRewriteRejectReason, 'facts' | 'catalog-id' | 'entities'> | null {
  if (containsCatalogItemId(output)) return 'catalog-id'
  if (!factsPass(input, output)) return 'facts'
  if (!entitiesPreserved(input, output)) return 'entities'
  return null
}

function rewriteBailReached(consecutiveRejects: number, policy: NotesRewritePolicy): boolean {
  if (policy.skipRewrites) return true
  return (
    policy.bailAfterConsecutiveRejects != null &&
    consecutiveRejects >= policy.bailAfterConsecutiveRejects
  )
}

function compressRejectReason(
  inputText: string,
  markdown: string,
  judgmentReason: string
): ScanRewriteRejectReason {
  if (!entitiesPreserved(inputText, markdown)) return 'entities'
  if (countWords(inputText) >= 80 && countWords(markdown) > countWords(inputText)) return 'grew'
  if (
    judgmentReason === 'item-id' ||
    judgmentReason === 'facts' ||
    judgmentReason === 'ungrounded' ||
    judgmentReason === 'coverage'
  ) {
    return judgmentReason
  }
  return 'coverage'
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
  segments: MeetingSegmentsWithCandidates,
  options: RunNotesScanOptions
): Promise<NotesScanResult> {
  const nextStepCandidates = segments.nextStepCandidates ?? []
  segments = withoutNextStepCandidates(segments)
  const seed = options.seed ?? DEFAULT_SEED
  const temperature = options.temperature ?? 0.4
  const rewritePolicy = options.rewritePolicy ?? DEFAULT_NOTES_REWRITE_POLICY
  const reportProgress = (stage: string, fraction: number): void => {
    options.onProgress?.({ stage, fraction: Math.min(1, Math.max(0, fraction)) })
  }
  reportProgress('scan-start', 0)

  if (options.presentationMode === 'lossless') {
    if (!options.meetingId) {
      throw new Error('Lossless notes presentation requires a meeting ID')
    }

    const attributionTranscript = options.attributionTranscript
    if (!attributionTranscript) {
      throw new Error('Lossless notes presentation requires attribution evidence')
    }
    const decisionRecovery = isWindowsEvidenceWriterEnabled()
      ? { segments, recoveredDecisionCount: 0, promotedDecisionCount: 0, dedupedRecoveredDecisionCount: 0 }
      : recoverExplicitTranscriptDecisions(segments, attributionTranscript)
    const recovery = isWindowsEvidenceWriterEnabled()
      ? { segments: decisionRecovery.segments, recoveredActionCount: 0, promotedActionCount: 0, dedupedRecoveredActionCount: 0 }
      : recoverExplicitTranscriptActions(
      decisionRecovery.segments,
      attributionTranscript,
      {
        localOwnerLabel: options.localOwnerLabel?.trim() || undefined
      }
    )
    let attributionOwnersAdded = 0
    let attributionOwnersStripped = 0
    let attributionOwnersPreserved = 0
    let attributionOwnersChanged = 0
    const actionItems = recovery.segments.actionItems.map((segment) => {
      const resolvedOwner = resolveSpeakerAwareOwner(
        segment,
        attributionTranscript,
        options.localOwnerLabel
      )
      const originalOwner = segment.assignee?.trim() || null
      if (!originalOwner && resolvedOwner) attributionOwnersAdded += 1
      if (originalOwner && !resolvedOwner) attributionOwnersStripped += 1
      if (originalOwner && resolvedOwner === originalOwner) attributionOwnersPreserved += 1
      if (originalOwner && resolvedOwner && resolvedOwner !== originalOwner) {
        attributionOwnersChanged += 1
      }
      return { ...segment, assignee: resolvedOwner }
    })
    let presentedSegments: MeetingSegments = {
      ...recovery.segments,
      actionItems
    }
    const organization = isWindowsTopicWriterEnabled() && !isWindowsEvidenceWriterEnabled()
      ? await organizeWindowsNotes(dedupeWindowsNotes(presentedSegments), options.generate, options.meetingId, options.embed)
      : null
    if (organization) presentedSegments = organization.segments
    let content = presentMeetingSegmentsLosslessly(options.meetingId, presentedSegments)
    if (organization?.overview) content.overview = organization.overview
    // An overview must add a grounded synthesis; copying selected body records
    // into another area adds repetition without adding meaning.
    if (isWindowsTopicWriterEnabled()) content.overview = organization?.overview ?? null
    let overviewFailed = false
    let overviewFailureReasons: string[] = []
    if (
      isWindowsNotesQualityEnabled() &&
      !isWindowsTopicWriterEnabled() &&
      !organization?.overview
    ) {
      const catalog = notesCatalogMarkdown(content)
      if (catalog) {
        reportProgress('overview', 0.95)
        try {
          const overview = await generateNotesOverview(
            catalog,
            (request) =>
              options.generate({
                ...request,
                seed,
                stop: []
              }),
            meetingSpanSources(options.spanSources),
            { overviewOnly: true, meetingId: options.meetingId }
          )
          overviewFailed = !overview.usedModel
          overviewFailureReasons = overview.failureReasons
          if (overview.overview?.text.trim()) {
            content = { ...content, overview: overview.overview }
          }
        } catch (error) {
          overviewFailed = true
          overviewFailureReasons = [
            `overview pass threw: ${error instanceof Error ? error.message : String(error)}`
          ]
        }
      }
    }
    const presentationStats = losslessPresentationStats(presentedSegments, content)
    const contextualized = presentActionContext(content, presentedSegments.actionItems)
    const refined = refineNextSteps(contextualized.content, nextStepCandidates, attributionTranscript, options.localOwnerLabel)
    const continued = restoreActionContinuations(refined.content, attributionTranscript)
    reportProgress('lossless-presentation', 1)

    return {
      markdown: '',
      content: continued.content,
      presentationMode: 'lossless',
      exactWriterCoverage: contextualized.count + refined.count + continued.count === 0,
      contextualizedNextStepCount: contextualized.count + refined.count + continued.count,
      organizationAttempted: organization?.attempted ?? false,
      organizationAccepted: organization?.grouped ?? false,
      organizationOverviewAccepted: organization?.overviewAccepted ?? false,
      attributionOwnersAdded,
      attributionOwnersStripped,
      attributionOwnersPreserved,
      attributionOwnersChanged,
      recoveredActionCount: recovery.recoveredActionCount,
      promotedActionCount: recovery.promotedActionCount,
      dedupedRecoveredActionCount: recovery.dedupedRecoveredActionCount,
      recoveredDecisionCount: decisionRecovery.recoveredDecisionCount,
      promotedDecisionCount: decisionRecovery.promotedDecisionCount,
      dedupedRecoveredDecisionCount: decisionRecovery.dedupedRecoveredDecisionCount,
      overviewSkipped: false,
      groupingFallback: (organization?.attempted && !organization.grouped) || presentationStats.groupingFallback,
      topicCoveragePercent: presentationStats.topicCoveragePercent,
      genericHeadingPercent: presentationStats.genericHeadingPercent,
      needsReviewCount: presentationStats.needsReviewCount,
      contextDependentRejected: presentationStats.contextDependentRejected,
      restyleFallbacks: 0,
      compressFallbacks: 0,
      restyleSkips: 0,
      compressSkips: 0,
      restyleRejectReasons: [],
      compressRejectReasons: [],
      attachFailed: false,
      overviewFailed,
      overviewFailureReasons,
      validation: emptyValidationStats(false)
    }
  }

  const split = splitLegacyItems(segments)
  const topical = [
    ...split.topical,
    ...split.decisions.map((item, index) => toCatalogItem(item, split.topical.length + index))
  ]
  const actions = split.actions.map((item, index) => toCatalogItem(item, topical.length + index))
  const topicalIds = topical.map((row) => row.id)
  const groupingLimits = { minGroups: 2, maxGroups: 8 }

  const groupPlan = planArmEGroup(topical, seed)
  const writerTopicGroups = fallbackWriterTopicGroups(topical)
  let llmGroups: TopicGroup[] | null = null
  if (!rewritePolicy.skipStructureLlm) {
    let groupingText = await generateFromPlan(options.generate, groupPlan)
    let groupingValidation = parseGroupingJson(groupingText, topicalIds, topical, groupingLimits)
    if (!groupingValidation.ok) {
      groupingText = await generateFromPlan(
        options.generate,
        planArmEGroup(topical, armERetrySeed())
      )
      groupingValidation = parseGroupingJson(groupingText, topicalIds, topical, groupingLimits)
    }
    llmGroups = groupingValidation.ok ? groupingValidation.groups : null
  }
  const chosen = chooseScanGroups(llmGroups, writerTopicGroups, topical)
  const groupingFallback =
    chosen.groupingFallback &&
    (chosen.groups.length === 0 || fallbackBucketGroups(topical).length === 0)
  const groups = chosen.groups.length > 0 ? chosen.groups : fallbackBucketGroups(topical)
  reportProgress('grouping', 0.12)

  const byId = catalogById(topical)
  const sectionBodies: { name: string; markdown: string }[] = []
  let restyleFallbacks = 0
  let restyleSkips = 0
  let consecutiveRestyleRejects = 0
  const restyleRejectReasons: ScanRewriteRejectReason[] = []
  for (const [groupIndex, group] of groups.entries()) {
    const members = itemsForGroup(group, byId)
    const inputText = members.map((row) => row.fullText).join('\n')
    let markdown: string
    if (rewriteBailReached(consecutiveRestyleRejects, rewritePolicy)) {
      // Skips are policy short-circuits, not model rejections — keep them off
      // restyleFallbacks / reject-reason tallies so quality metrics stay honest.
      restyleSkips += 1
      markdown = renderUnrestyledItems(members.map((row) => row.item))
    } else {
      markdown = sanitizeMarkdown(
        await generateFromPlan(
          options.generate,
          planArmERestyle(group.name, members, temperature, seed)
        )
      )
      if (
        rewritePolicy.maxAttemptsPerSection === 2 &&
        (!factsPass(inputText, markdown) ||
          containsCatalogItemId(markdown) ||
          !entitiesPreserved(inputText, markdown))
      ) {
        markdown = sanitizeMarkdown(
          await generateFromPlan(
            options.generate,
            planArmERestyle(group.name, members, temperature, armERetrySeed())
          )
        )
      }
      const restyleRejected = restyleRejectReason(inputText, markdown)
      if (restyleRejected) {
        restyleFallbacks += 1
        restyleRejectReasons.push(restyleRejected)
        markdown = renderUnrestyledItems(members.map((row) => row.item))
        consecutiveRestyleRejects += 1
      } else {
        consecutiveRestyleRejects = 0
      }
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
  let compressSkips = 0
  let consecutiveCompressRejects = 0
  const compressRejectReasons: ScanRewriteRejectReason[] = []
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
    if (rewriteBailReached(consecutiveCompressRejects, rewritePolicy)) {
      // Same honesty rule as restyle: skips are not compressFallbacks.
      compressSkips += 1
    } else {
      let markdown = stripEmittedHeading(
        await generateFromPlan(
          options.generate,
          planArmFCompress(chunk.name ?? 'Topic', inputText, temperature, seed)
        ),
        chunk.name ?? ''
      )
      if (rewritePolicy.maxAttemptsPerSection === 2 && !accept(markdown)) {
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
        const judgment = judgeCompression({
          inputSection: inputText,
          compressed: markdown,
          trialDocument: joinNotesDocument(reconstructWith(working, index, markdown)),
          baselineStrict: scoreCoverage(inputText, coverageItems).strict,
          coverageItems
        })
        compressRejectReasons.push(compressRejectReason(inputText, markdown, judgment.reason))
        markdown = inputText
        consecutiveCompressRejects += 1
      } else {
        consecutiveCompressRejects = 0
      }
      working = reconstructWith(working, index, markdown)
    }
    compressDone += 1
    reportProgress('compress', 0.55 + (0.32 * compressDone) / Math.max(topicalChunks.length, 1))
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
  let overviewFailureReasons: string[] = []
  reportProgress('overview', 0.9)
  if (rewritePolicy.skipStructureLlm) {
    overviewFailed = true
    overviewFailureReasons = ['structure-llm-skipped']
  } else {
    try {
      const overview = await generateNotesOverview(
        presented.markdown,
        (request) =>
          options.generate({
            ...request,
            seed,
            stop: []
          }),
        meetingSpan,
        { numCtx: groupPlan.request.options.num_ctx }
      )
      overviewFailed = !overview.usedModel
      overviewFailureReasons = overview.failureReasons
      content = dropAssertiveTakeaways({
        ...content,
        overview: overview.overview,
        keyTakeaways: overview.keyTakeaways
      })
    } catch (error) {
      overviewFailed = true
      overviewFailureReasons = [
        `overview pass threw: ${error instanceof Error ? error.message : String(error)}`
      ]
    }
  }
  if (!content.overview?.text.trim()) {
    const fallbackText = fallbackMeetingOverviewFromNotes(content.sections, options.title)
    if (fallbackText) {
      overviewFailed = true
      content = {
        ...content,
        overview: {
          text: fallbackText,
          sources: meetingSpan.map((source) => ({ ...source })),
          provenance: 'generated'
        }
      }
    }
  }

  content = preserveWriterEntities(content, [...topical, ...actions])
  const transcript = options.transcript ?? []
  if (transcript.length > 0) {
    content = appendTranscriptTickets(content, transcript)
    if (process.platform === 'win32') {
      content = appendTranscriptQuantities(content, transcript)
    }
  }
  const durationMs = meetingSpan[0] ? meetingSpan[0].endMs - meetingSpan[0].startMs : 0
  content = applyNotesBudget(content, durationMs)
  if (process.platform === 'win32') {
    content = {
      ...content,
      sections: nestFlatPeerKeyPoints(content.sections)
    }
  }
  const validation = emptyValidationStats(false)
  reportProgress('budget', 1)

  return {
    markdown: presented.markdown,
    content,
    presentationMode: 'scan',
    exactWriterCoverage: false,
    groupingFallback,
    restyleFallbacks,
    compressFallbacks,
    restyleSkips,
    compressSkips,
    restyleRejectReasons,
    compressRejectReasons,
    attachFailed,
    overviewFailed,
    overviewFailureReasons,
    validation
  }
}
