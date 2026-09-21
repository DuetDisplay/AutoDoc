import { itemText } from './text.ts'
import { rangeKey } from './timestamps.ts'
import type { IaItem } from './types.ts'

export interface DedupStats {
  exactDuplicatesDropped: number
  timestampClusterChildren: number
}

function cloneItem(item: IaItem): IaItem {
  return { ...item, sources: item.sources.map((range) => ({ ...range })), children: item.children.map(cloneItem) }
}

function modalityPriority(item: IaItem): number {
  return item.bucket === 'decisions' || item.bucket === 'actionItems' ? 0 : 1
}

function compareParent(left: IaItem, right: IaItem, indexById: Map<string, number>): number {
  const priorityDelta = modalityPriority(left) - modalityPriority(right)
  if (priorityDelta !== 0) return priorityDelta
  const lengthDelta = itemText(right).length - itemText(left).length
  if (lengthDelta !== 0) return lengthDelta
  return (indexById.get(left.id) ?? 0) - (indexById.get(right.id) ?? 0)
}

/**
 * Identical (startMs,endMs) clusters: Decisions/Actions win the parent slot
 * over body buckets; length is the tiebreak within a priority class. Other
 * distinct texts become children; exact text duplicates are dropped.
 */
export function dedupClusters(items: readonly IaItem[]): { items: IaItem[]; stats: DedupStats } {
  const indexById = new Map<string, number>()
  items.forEach((item, index) => indexById.set(item.id, index))

  const groups = new Map<string, IaItem[]>()
  for (const item of items) {
    if (item.sources.length !== 1) {
      const key = `multi:${item.id}`
      const group = groups.get(key)
      if (group) group.push(item)
      else groups.set(key, [item])
      continue
    }
    const key = rangeKey(item.sources[0])
    const group = groups.get(key)
    if (group) group.push(item)
    else groups.set(key, [item])
  }

  const result: IaItem[] = []
  let exactDuplicatesDropped = 0
  let timestampClusterChildren = 0

  for (const group of groups.values()) {
    if (group.length === 1) {
      result.push(cloneItem(group[0]))
      continue
    }

    const ranked = [...group].sort((left, right) => compareParent(left, right, indexById))
    const primary = cloneItem(ranked[0])
    const seenText = new Set([itemText(primary)])

    for (const extra of ranked.slice(1)) {
      const text = itemText(extra)
      if (seenText.has(text)) {
        exactDuplicatesDropped += 1
        continue
      }
      seenText.add(text)
      primary.children.push(cloneItem(extra))
      timestampClusterChildren += 1
    }

    result.push(primary)
  }

  result.sort((left, right) => (indexById.get(left.id) ?? 0) - (indexById.get(right.id) ?? 0))
  return { items: result, stats: { exactDuplicatesDropped, timestampClusterChildren } }
}
