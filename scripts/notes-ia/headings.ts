import { BUCKET_HEADINGS, P0_BUCKET_ORDER } from './types.ts'
import type { Bucket, IaDocument, IaItem, IaSection } from './types.ts'

function earliestStart(item: IaItem): number {
  const starts = [
    ...item.sources.map((range) => range.startMs),
    ...item.children.flatMap((child) => child.sources.map((range) => range.startMs))
  ]
  return starts.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...starts)
}

function topicKey(item: IaItem): string | null {
  const topic = item.topic?.trim()
  return topic ? topic : null
}

/**
 * Meeting-derived sections from topic labels, chronological by earliest range.
 * Decisions / Next Steps trail only when nonempty. Empty headings are omitted.
 */
export function buildMeetingHeadings(items: readonly IaItem[]): { document: IaDocument; emptyHeadingsSuppressed: number } {
  const bodyItems: IaItem[] = []
  const decisions: IaItem[] = []
  const nextSteps: IaItem[] = []

  for (const item of items) {
    if (item.bucket === 'decisions') decisions.push(item)
    else if (item.bucket === 'actionItems') nextSteps.push(item)
    else bodyItems.push(item)
  }

  const topics = new Map<string, IaItem[]>()
  const ungrouped: IaItem[] = []
  for (const item of bodyItems) {
    const topic = topicKey(item)
    if (!topic) {
      ungrouped.push(item)
      continue
    }
    const group = topics.get(topic)
    if (group) group.push(item)
    else topics.set(topic, [item])
  }

  const rankedTopics = [...topics.entries()].sort((left, right) => {
    const leftStart = Math.min(...left[1].map(earliestStart))
    const rightStart = Math.min(...right[1].map(earliestStart))
    return leftStart - rightStart
  })

  const sections: IaSection[] = []
  for (const [title, group] of rankedTopics) {
    if (group.length === 0) continue
    sections.push({ title, kind: 'topic', items: group })
  }
  if (ungrouped.length > 0) {
    sections.push({ title: 'Notes', kind: 'topic', items: ungrouped })
  }
  if (decisions.length > 0) {
    sections.push({ title: 'Decisions', kind: 'decisions', items: decisions })
  }
  if (nextSteps.length > 0) {
    sections.push({ title: 'Next Steps', kind: 'next-steps', items: nextSteps })
  }

  const possibleEmpty =
    (decisions.length === 0 ? 1 : 0) + (nextSteps.length === 0 ? 1 : 0)
  return {
    document: { title: 'Meeting notes', sections },
    emptyHeadingsSuppressed: possibleEmpty
  }
}

/** Five-bucket shell; skip empty buckets. */
export function buildBucketHeadings(items: readonly IaItem[]): { document: IaDocument; emptyHeadingsSuppressed: number } {
  const byBucket = new Map<Bucket, IaItem[]>()
  for (const bucket of P0_BUCKET_ORDER) byBucket.set(bucket, [])
  for (const item of items) {
    const list = byBucket.get(item.bucket)
    if (list) list.push(item)
    else byBucket.set(item.bucket, [item])
  }

  const sections: IaSection[] = []
  let emptyHeadingsSuppressed = 0
  for (const bucket of P0_BUCKET_ORDER) {
    const group = byBucket.get(bucket) ?? []
    if (group.length === 0) {
      emptyHeadingsSuppressed += 1
      continue
    }
    sections.push({
      title: BUCKET_HEADINGS[bucket],
      kind: bucket === 'decisions' ? 'decisions' : bucket === 'actionItems' ? 'next-steps' : 'bucket',
      items: group
    })
  }

  return { document: { title: 'Meeting notes', sections }, emptyHeadingsSuppressed }
}
