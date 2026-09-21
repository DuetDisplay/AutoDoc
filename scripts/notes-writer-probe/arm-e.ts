import { demoteModality } from '../notes-ia/demote.ts'
import { parseMeetingSegments, segmentsToItems } from '../notes-ia/parse.ts'
import { itemText } from '../notes-ia/text.ts'
import type { IaItem } from '../notes-ia/types.ts'

import {
  ARM_E_GROUP_NUM_CTX,
  ARM_E_GROUP_NUM_PREDICT,
  ARM_E_RESTYLE_NUM_CTX,
  ARM_E_RESTYLE_NUM_PREDICT,
  ARM_E_RETRY_SEED,
  DEFAULT_SEED,
  STOP_CONDITIONS,
  type AllowedTemperature
} from './constants.ts'
import { firstLine, type CatalogItem } from './groups.ts'
import { sha256Utf8 } from './hash.ts'
import type { GenerateRequest } from './ollama-client.ts'
import { ARM_E_GROUP_TEMPLATE, ARM_E_RESTYLE_TEMPLATE, fillTemplate } from './prompts.ts'
import { stripLegacyDecorations } from './sanitize.ts'
import { countWords, estimateTokens } from './tokens.ts'

export interface ArmECallPlan {
  role: 'group' | 'restyle'
  templateName: 'ARM_E_GROUP_TEMPLATE' | 'ARM_E_RESTYLE_TEMPLATE'
  templateSha256: string
  filledPromptSha256: string
  prompt: string
  temperature: number
  seed: number
  request: Omit<GenerateRequest, 'model'>
}

export interface ArmESplit {
  topical: CatalogItem[]
  decisions: IaItem[]
  actions: IaItem[]
  demotedCount: number
}

export function catalogId(index: number): string {
  return `i${String(index + 1).padStart(2, '0')}`
}

/** Arm E topical catalog ids are `i` plus at least two digits (`i01`, `i03`, `i12`). */
export const CATALOG_ITEM_ID_PATTERN = /\bi\d{2,}\b/u

export function containsCatalogItemId(text: string): boolean {
  CATALOG_ITEM_ID_PATTERN.lastIndex = 0
  return CATALOG_ITEM_ID_PATTERN.test(text)
}

export function catalogTextById(catalog: readonly CatalogItem[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const row of catalog) {
    out[row.id] = row.fullText.trim().length > 0 ? row.fullText : row.titleLine
  }
  return out
}

export function toCatalogItem(item: IaItem, index: number): CatalogItem {
  const fullText = stripLegacyDecorations(itemText(item))
  const titleLine = stripLegacyDecorations(item.title?.trim() || firstLine(item.content) || fullText)
  return {
    id: catalogId(index),
    item,
    titleLine,
    fullText
  }
}

export function splitLegacyItems(raw: unknown): ArmESplit {
  const items = segmentsToItems(parseMeetingSegments(raw))
  const { items: demoted, demoted: demotedCount } = demoteModality(items)
  const topicalSource = demoted.filter(
    (item) => item.bucket !== 'decisions' && item.bucket !== 'actionItems'
  )
  return {
    topical: topicalSource.map(toCatalogItem),
    decisions: demoted.filter((item) => item.bucket === 'decisions'),
    actions: demoted.filter((item) => item.bucket === 'actionItems'),
    demotedCount
  }
}

export function groupingItemList(catalog: readonly CatalogItem[]): string {
  return catalog.map((row) => `${row.id}: ${row.titleLine}`).join('\n')
}

export function restyleItemList(catalog: readonly CatalogItem[]): string {
  return catalog
    .map((row) => {
      const title = row.item.title?.trim()
      const content = stripLegacyDecorations(row.item.content)
      if (title && content && title !== content) {
        return `${row.id}: ${stripLegacyDecorations(title)}\n${content}`
      }
      return `${row.id}: ${row.fullText}`
    })
    .join('\n\n')
}

function groupRequest(prompt: string, seed: number): Omit<GenerateRequest, 'model'> {
  return {
    prompt,
    stream: true,
    options: {
      num_ctx: ARM_E_GROUP_NUM_CTX,
      num_predict: ARM_E_GROUP_NUM_PREDICT,
      temperature: 0,
      seed,
      stop: STOP_CONDITIONS
    }
  }
}

function restyleRequest(
  prompt: string,
  temperature: AllowedTemperature,
  seed: number
): Omit<GenerateRequest, 'model'> {
  return {
    prompt,
    stream: true,
    options: {
      num_ctx: ARM_E_RESTYLE_NUM_CTX,
      num_predict: ARM_E_RESTYLE_NUM_PREDICT,
      temperature,
      seed,
      stop: STOP_CONDITIONS
    }
  }
}

export function planArmEGroup(catalog: readonly CatalogItem[], seed: number = DEFAULT_SEED): ArmECallPlan {
  const prompt = fillTemplate(ARM_E_GROUP_TEMPLATE, { ITEMS: groupingItemList(catalog) })
  return {
    role: 'group',
    templateName: 'ARM_E_GROUP_TEMPLATE',
    templateSha256: sha256Utf8(ARM_E_GROUP_TEMPLATE),
    filledPromptSha256: sha256Utf8(prompt),
    prompt,
    temperature: 0,
    seed,
    request: groupRequest(prompt, seed)
  }
}

export function planArmERestyle(
  topicName: string,
  catalog: readonly CatalogItem[],
  temperature: AllowedTemperature,
  seed: number = DEFAULT_SEED
): ArmECallPlan {
  const prompt = fillTemplate(ARM_E_RESTYLE_TEMPLATE, {
    TOPIC_NAME: topicName,
    ITEMS: restyleItemList(catalog)
  })
  return {
    role: 'restyle',
    templateName: 'ARM_E_RESTYLE_TEMPLATE',
    templateSha256: sha256Utf8(ARM_E_RESTYLE_TEMPLATE),
    filledPromptSha256: sha256Utf8(prompt),
    prompt,
    temperature,
    seed,
    request: restyleRequest(prompt, temperature, seed)
  }
}

export function armERetrySeed(): number {
  return ARM_E_RETRY_SEED
}

export function catalogStats(catalog: readonly CatalogItem[]): Record<string, number> {
  const text = groupingItemList(catalog)
  return {
    itemCount: catalog.length,
    titleCharCount: text.length,
    titleWordCount: countWords(text),
    titleEstimatedTokens: estimateTokens(text)
  }
}
