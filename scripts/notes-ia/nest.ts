import { contentWords, itemText, jaccard } from './text.ts'
import type { IaItem, SourceRange } from './types.ts'

/**
 * Frozen nesting thresholds (Phase 2). Tune once; do not retune per candidate.
 * Adjacent means the gap between the earlier range's end and the later range's
 * start is at most 30 seconds. Lexical overlap is Jaccard on content words
 * (tokens longer than two characters, stopwords dropped).
 */
export const NEST_ADJACENCY_GAP_MS = 30_000
export const NEST_JACCARD_THRESHOLD = 0.3

export function rangesOverlapOrAdjacent(
  left: readonly SourceRange[],
  right: readonly SourceRange[],
  gapMs = NEST_ADJACENCY_GAP_MS
): boolean {
  for (const a of left) {
    for (const b of right) {
      const earlierEnd = Math.min(a.endMs, b.endMs)
      const laterStart = Math.max(a.startMs, b.startMs)
      if (laterStart - earlierEnd <= gapMs) return true
    }
  }
  return false
}

function topicKey(item: IaItem): string {
  return item.topic?.trim() || '\0ungrouped'
}

function cloneItem(item: IaItem): IaItem {
  return { ...item, sources: item.sources.map((range) => ({ ...range })), children: item.children.map(cloneItem) }
}

function lexicalOverlap(left: IaItem, right: IaItem): number {
  return jaccard(contentWords(itemText(left)), contentWords(itemText(right)))
}

/**
 * Within each topic group, shortest (then earliest) item is primary. Other items
 * with overlapping/adjacent ranges and Jaccard ≥ threshold become children.
 */
export function nestDetails(items: readonly IaItem[]): { items: IaItem[]; nestChildrenAdded: number } {
  const groups = new Map<string, IaItem[]>()
  const originalIndex = new Map<string, number>()
  items.forEach((item, index) => {
    originalIndex.set(item.id, index)
    const key = topicKey(item)
    const group = groups.get(key)
    if (group) group.push(item)
    else groups.set(key, [item])
  })

  const nested: IaItem[] = []
  let nestChildrenAdded = 0

  for (const group of groups.values()) {
    const remaining = group
      .map(cloneItem)
      .sort((left, right) => {
        const lengthDelta = itemText(left).length - itemText(right).length
        if (lengthDelta !== 0) return lengthDelta
        const leftStart = Math.min(...left.sources.map((range) => range.startMs))
        const rightStart = Math.min(...right.sources.map((range) => range.startMs))
        if (leftStart !== rightStart) return leftStart - rightStart
        return (originalIndex.get(left.id) ?? 0) - (originalIndex.get(right.id) ?? 0)
      })

    const primaries: IaItem[] = []
    const used = new Set<string>()

    for (const candidate of remaining) {
      if (used.has(candidate.id)) continue
      used.add(candidate.id)
      const primary = candidate
      for (const other of remaining) {
        if (used.has(other.id)) continue
        if (!rangesOverlapOrAdjacent(primary.sources, other.sources)) continue
        if (lexicalOverlap(primary, other) < NEST_JACCARD_THRESHOLD) continue
        primary.children.push(other)
        used.add(other.id)
        nestChildrenAdded += 1
      }
      primaries.push(primary)
    }

    nested.push(...primaries)
  }

  nested.sort((left, right) => (originalIndex.get(left.id) ?? 0) - (originalIndex.get(right.id) ?? 0))
  return { items: nested, nestChildrenAdded }
}
