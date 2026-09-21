import type { MeetingNotesContent, NoteItem, NoteSourceRange } from '../../shared/types'
import type { CatalogItem, TopicGroup } from '../../../scripts/notes-writer-probe/groups.ts'
import { isMeetingSpanOnly } from '../../shared/notes-timestamps'

export { isMeetingSpanOnly }

export interface AttachTimestampCatalog {
  topical: readonly CatalogItem[]
  actions: readonly CatalogItem[]
  groups: readonly TopicGroup[]
  meetingSpan: readonly NoteSourceRange[]
}

const RANGE_MERGE_GAP_MS = 15_000
const MAX_MERGED_RANGES = 5
const COVER_COLLAPSE_RATIO = 0.5
const EXTENT_COLLAPSE_RATIO = 0.8

function tokens(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []).filter((token) => token.length > 0))
}

function unionSources(items: readonly CatalogItem[]): NoteSourceRange[] {
  const ranges: NoteSourceRange[] = []
  for (const row of items) {
    for (const source of row.item.sources) {
      if (source.endMs >= source.startMs && (source.startMs > 0 || source.endMs > 0)) {
        ranges.push({ startMs: source.startMs, endMs: source.endMs })
      }
    }
  }
  ranges.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)

  const merged: NoteSourceRange[] = []
  for (const range of ranges) {
    const last = merged[merged.length - 1]
    if (last && range.startMs - last.endMs <= RANGE_MERGE_GAP_MS) {
      last.endMs = Math.max(last.endMs, range.endMs)
    } else {
      merged.push({ startMs: range.startMs, endMs: range.endMs })
    }
  }
  return merged.slice(0, MAX_MERGED_RANGES)
}

function sharedTokenCount(left: Set<string>, right: Set<string>): number {
  let count = 0
  for (const token of left) {
    if (right.has(token)) count += 1
  }
  return count
}

function matchCatalog(text: string, catalog: readonly CatalogItem[]): CatalogItem[] {
  const needle = tokens(text)
  if (needle.size === 0) return []
  const minShared = needle.size >= 6 ? 3 : 2
  const scored = catalog
    .map((row) => ({
      row,
      shared: sharedTokenCount(needle, tokens(`${row.titleLine} ${row.fullText}`))
    }))
    .filter((entry) => entry.shared >= minShared)
    .sort((a, b) => b.shared - a.shared)
  const best = scored[0]
  if (!best) return []
  return scored
    .filter((entry) => entry.shared >= best.shared - 1)
    .slice(0, 3)
    .map((entry) => entry.row)
}

function collapseBroadSources(
  sources: NoteSourceRange[],
  meetingSpan: readonly NoteSourceRange[]
): NoteSourceRange[] {
  const meeting = meetingSpan[0]
  if (!meeting || sources.length === 0) return [...meetingSpan]
  const meetingDuration = meeting.endMs - meeting.startMs
  if (meetingDuration <= 0) return sources

  const covered = sources.reduce((sum, range) => sum + (range.endMs - range.startMs), 0)
  const extent = sources[sources.length - 1].endMs - sources[0].startMs
  if (covered >= meetingDuration * COVER_COLLAPSE_RATIO || extent >= meetingDuration * EXTENT_COLLAPSE_RATIO) {
    return [...meetingSpan]
  }
  return sources
}

function attachItem(
  item: NoteItem,
  catalog: readonly CatalogItem[],
  meetingSpan: readonly NoteSourceRange[]
): NoteItem {
  const matched = matchCatalog(`${item.title ?? ''} ${item.text}`, catalog)
  if (matched.length === 0) {
    return { ...item, sources: [...meetingSpan] }
  }
  const sources = unionSources(matched)
  return {
    ...item,
    sources: sources.length > 0 ? collapseBroadSources(sources, meetingSpan) : [...meetingSpan]
  }
}

export function attachNotesTimestamps(
  content: MeetingNotesContent,
  catalog: AttachTimestampCatalog
): MeetingNotesContent {
  const meetingSpan =
    catalog.meetingSpan.length > 0 ? [...catalog.meetingSpan] : [{ startMs: 0, endMs: 0 }]

  return {
    ...content,
    keyTakeaways: content.keyTakeaways.map((item) => attachItem(item, catalog.topical, meetingSpan)),
    sections: content.sections.map((section) => ({
      ...section,
      keyPoints: section.keyPoints.map((item) => attachItem(item, catalog.topical, meetingSpan)),
      supportingDetails: section.supportingDetails.map((item) =>
        attachItem(item, catalog.topical, meetingSpan)
      )
    })),
    nextSteps: content.nextSteps.map((item) => attachItem(item, catalog.actions, meetingSpan))
  }
}
