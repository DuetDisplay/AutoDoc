import { BUCKET_HEADINGS, type Bucket, type IaItem } from '../notes-ia/types.ts'
import { distinctiveContentLemmas } from './arm-g.ts'

export const OTHER_TOPICS_GROUP = 'Other topics'

export const ARM_E_GROUP_MIN = 3
export const ARM_E_GROUP_MAX = 7
/** Accept valid JSON that leaves at most this fraction of ids unassigned. */
export const ARM_E_REMAINDER_MAX_FRACTION = 0.2

export interface TopicGroup {
  name: string
  ids: string[]
}

export interface GroupValidation {
  ok: boolean
  groups: TopicGroup[]
  reason: string | null
  remainderIds: string[]
}

export interface CatalogItem {
  id: string
  item: IaItem
  titleLine: string
  fullText: string
}

function stripJsonFence(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/u)
  if (fenced?.[1]) return fenced[1].trim()
  return text.trim()
}

function unwrapGrouping(parsed: unknown): unknown {
  if (!Array.isArray(parsed)) return parsed
  const withGroups = parsed.filter(
    (entry) =>
      entry !== null &&
      typeof entry === 'object' &&
      !Array.isArray(entry) &&
      ('groups' in entry || 'topics' in entry)
  )
  if (withGroups.length === 1) return withGroups[0]
  if (parsed.length === 1) return unwrapGrouping(parsed[0])
  return parsed
}

function parseGroupingPayload(raw: string): unknown {
  const stripped = stripJsonFence(raw)
  try {
    return unwrapGrouping(JSON.parse(stripped))
  } catch {
    const start = stripped.indexOf('{')
    const end = stripped.lastIndexOf('}')
    if (start < 0 || end <= start) return undefined
    try {
      return unwrapGrouping(JSON.parse(stripped.slice(start, end + 1)))
    } catch {
      return undefined
    }
  }
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const ids: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim().length === 0) return null
    ids.push(entry.trim())
  }
  return ids
}

function catalogItemLemmas(row: CatalogItem | undefined): Set<string> {
  if (!row) return new Set()
  return distinctiveContentLemmas(`${row.titleLine} ${row.fullText}`)
}

function groupContentLemmas(group: TopicGroup, catalogById: Map<string, CatalogItem>): Set<string> {
  const lemmas = distinctiveContentLemmas(group.name)
  for (const id of group.ids) {
    for (const lemma of catalogItemLemmas(catalogById.get(id))) lemmas.add(lemma)
  }
  return lemmas
}

function sharedLemmaCount(left: Set<string>, right: Set<string>): number {
  let count = 0
  for (const lemma of left) {
    if (right.has(lemma)) count += 1
  }
  return count
}

function otherTopicsIndex(groups: TopicGroup[]): number {
  const existing = groups.findIndex((group) => group.name === OTHER_TOPICS_GROUP)
  if (existing >= 0) return existing
  groups.push({ name: OTHER_TOPICS_GROUP, ids: [] })
  return groups.length - 1
}

function remainderTargetIndex(
  groups: TopicGroup[],
  missingId: string,
  catalogById: Map<string, CatalogItem>
): number {
  const itemLemmas = catalogItemLemmas(catalogById.get(missingId))
  let best = -1
  let bestShared = 0
  for (const [index, group] of groups.entries()) {
    if (group.name === OTHER_TOPICS_GROUP) continue
    const shared = sharedLemmaCount(itemLemmas, groupContentLemmas(group, catalogById))
    if (shared > bestShared) {
      bestShared = shared
      best = index
    }
  }
  // One shared non-generic lemma is the minimum that can mean "same topic".
  if (best >= 0 && bestShared >= 1) return best
  return otherTopicsIndex(groups)
}

export function parseGroupingJson(
  raw: string,
  expectedIds: readonly string[],
  catalog: readonly CatalogItem[] = [],
  limits?: { minGroups?: number; maxGroups?: number }
): GroupValidation {
  const minGroups = limits?.minGroups ?? ARM_E_GROUP_MIN
  const maxGroups = limits?.maxGroups ?? ARM_E_GROUP_MAX
  const empty = { ok: false, groups: [] as TopicGroup[], reason: 'invalid_json', remainderIds: [] as string[] }
  const parsed = parseGroupingPayload(raw)
  if (parsed === undefined) return empty
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ...empty, reason: 'invalid_json' }
  }
  const record = parsed as Record<string, unknown>
  const list = record.groups ?? record.topics
  if (!Array.isArray(list)) return { ...empty, reason: 'missing_groups' }
  if (list.length < minGroups || list.length > maxGroups) {
    return { ...empty, reason: 'group_count' }
  }

  const groups: TopicGroup[] = []
  const assigned = new Map<string, number>()
  for (const row of list) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      return { ...empty, reason: 'invalid_group' }
    }
    const entry = row as Record<string, unknown>
    const name = typeof entry.name === 'string' ? entry.name.trim() : ''
    if (name.length === 0) return { ...empty, reason: 'empty_name' }
    const ids = asStringArray(entry.ids ?? entry.item_ids ?? entry.items)
    if (ids === null || ids.length === 0) return { ...empty, reason: 'empty_ids' }
    for (const id of ids) {
      assigned.set(id, (assigned.get(id) ?? 0) + 1)
    }
    groups.push({ name, ids: [...ids] })
  }

  const expected = new Set(expectedIds)
  for (const id of assigned.keys()) {
    if (!expected.has(id)) return { ...empty, reason: 'unknown_id' }
  }
  for (const count of assigned.values()) {
    if (count !== 1) return { ...empty, reason: 'assignment' }
  }

  const missing = expectedIds.filter((id) => (assigned.get(id) ?? 0) === 0)
  if (missing.length === 0) return { ok: true, groups, reason: null, remainderIds: [] }
  if (expectedIds.length === 0) return { ...empty, reason: 'assignment' }
  if (missing.length / expectedIds.length > ARM_E_REMAINDER_MAX_FRACTION) {
    return { ...empty, reason: 'assignment' }
  }
  if (catalog.length === 0) return { ...empty, reason: 'assignment' }

  const catalogById = new Map(catalog.map((row) => [row.id, row]))
  for (const id of missing) {
    const index = remainderTargetIndex(groups, id, catalogById)
    const target = groups[index]
    if (!target) return { ...empty, reason: 'assignment' }
    target.ids.push(id)
  }
  return { ok: true, groups, reason: null, remainderIds: missing }
}

export function fallbackWriterTopicGroups(catalog: readonly CatalogItem[]): TopicGroup[] {
  const byTopic = new Map<string, string[]>()
  for (const row of catalog) {
    const topic = row.item.topic?.trim()
    if (!topic) continue
    const list = byTopic.get(topic)
    if (list) list.push(row.id)
    else byTopic.set(topic, [row.id])
  }
  if (byTopic.size === 0) return []
  const assigned = new Set<string>()
  const groups: TopicGroup[] = []
  for (const [name, ids] of byTopic) {
    groups.push({ name, ids })
    for (const id of ids) assigned.add(id)
  }
  const remainder = catalog.filter((row) => !assigned.has(row.id)).map((row) => row.id)
  if (remainder.length > 0) {
    const other = groups.find((group) => group.name === OTHER_TOPICS_GROUP)
    if (other) other.ids.push(...remainder)
    else groups.push({ name: OTHER_TOPICS_GROUP, ids: remainder })
  }
  return groups
}

export function fallbackBucketGroups(catalog: readonly CatalogItem[]): TopicGroup[] {
  const byBucket = new Map<Bucket, string[]>()
  for (const row of catalog) {
    const bucket = row.item.bucket
    const list = byBucket.get(bucket)
    if (list) list.push(row.id)
    else byBucket.set(bucket, [row.id])
  }
  const groups: TopicGroup[] = []
  for (const [bucket, ids] of byBucket) {
    if (ids.length === 0) continue
    groups.push({ name: BUCKET_HEADINGS[bucket], ids })
  }
  return groups
}

export function firstLine(text: string): string {
  const line = text.split(/\r?\n/u).find((row) => row.trim().length > 0) ?? ''
  return line.trim()
}
