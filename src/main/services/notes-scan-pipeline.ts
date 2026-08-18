import {
  armERetrySeed,
  catalogTextById,
  containsCatalogItemId,
  planArmEGroup,
  planArmERestyle,
  splitLegacyItems
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
import { factsPass } from '../../../scripts/notes-writer-probe/facts.ts'
import {
  fallbackBucketGroups,
  parseGroupingJson,
  type CatalogItem,
  type TopicGroup
} from '../../../scripts/notes-writer-probe/groups.ts'
import { sanitizeMarkdown } from '../../../scripts/notes-writer-probe/sanitize.ts'
import type { MeetingNotesContent, MeetingSegments } from '../../shared/types'
import { meetingSpanSources, parseScanMarkdown } from './notes-scan-markdown'

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
  seed?: number
  temperature?: AllowedTemperature
}

export interface NotesScanResult {
  markdown: string
  content: MeetingNotesContent
  groupingFallback: boolean
  restyleFallbacks: number
  compressFallbacks: number
}

function catalogById(catalog: readonly CatalogItem[]): Map<string, CatalogItem> {
  return new Map(catalog.map((row) => [row.id, row]))
}

function itemsForGroup(group: TopicGroup, byId: Map<string, CatalogItem>): CatalogItem[] {
  return group.ids.map((id) => byId.get(id)).filter((row): row is CatalogItem => row !== undefined)
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
  const split = splitLegacyItems(segments)
  const topicalIds = split.topical.map((row) => row.id)

  const groupPlan = planArmEGroup(split.topical, seed)
  let groupingText = await generateFromPlan(options.generate, groupPlan)
  let groupingValidation = parseGroupingJson(groupingText, topicalIds, split.topical)
  if (!groupingValidation.ok) {
    groupingText = await generateFromPlan(
      options.generate,
      planArmEGroup(split.topical, armERetrySeed())
    )
    groupingValidation = parseGroupingJson(groupingText, topicalIds, split.topical)
  }
  const groupingFallback = !groupingValidation.ok
  const groups = groupingFallback ? fallbackBucketGroups(split.topical) : groupingValidation.groups

  const byId = catalogById(split.topical)
  const sectionBodies: { name: string; markdown: string }[] = []
  let restyleFallbacks = 0
  for (const group of groups) {
    const members = itemsForGroup(group, byId)
    const inputText = members.map((row) => row.fullText).join('\n')
    let markdown = sanitizeMarkdown(
      await generateFromPlan(
        options.generate,
        planArmERestyle(group.name, members, temperature, seed)
      )
    )
    if (!factsPass(inputText, markdown) || containsCatalogItemId(markdown)) {
      markdown = sanitizeMarkdown(
        await generateFromPlan(
          options.generate,
          planArmERestyle(group.name, members, temperature, armERetrySeed())
        )
      )
    }
    if (!factsPass(inputText, markdown) || containsCatalogItemId(markdown)) {
      restyleFallbacks += 1
      markdown = renderUnrestyledItems(members.map((row) => row.item))
    }
    sectionBodies.push({ name: group.name, markdown })
  }

  const composed = sanitizeMarkdown(
    composeDocument({
      title: options.title,
      sections: sectionBodies,
      decisions: split.decisions,
      nextSteps: unionNextSteps(split.actions, [])
    })
  )

  const chunks = splitNotesDocument(composed)
  let working = chunks.map((chunk) => ({ ...chunk }))
  let compressFallbacks = 0
  for (const [index, chunk] of working.entries()) {
    if (chunk.kind !== 'topical') continue
    const inputText = sectionBody(chunk.raw)
    const accept = (text: string): boolean =>
      judgeCompression({
        inputSection: inputText,
        compressed: text,
        trialDocument: joinNotesDocument(reconstructWith(working, index, text)),
        baselineStrict: 0,
        coverageItems: []
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
  }

  const compressed = joinNotesDocument(working)
  const presented = applyArmG(compressed, { sourceCatalog: catalogTextById(split.topical) })
  const content = parseScanMarkdown(presented.markdown, {
    fallbackSources: meetingSpanSources(options.spanSources)
  })

  return {
    markdown: presented.markdown,
    content,
    groupingFallback,
    restyleFallbacks,
    compressFallbacks
  }
}
