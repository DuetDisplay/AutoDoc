import type { MeetingSegments, NoteSourceRange } from '../../shared/types'

export type NotesSearchCategory = keyof MeetingSegments

export interface NotesV2SearchEntry {
  id: string
  category: NotesSearchCategory
  title: string
  content: string
  topic: string | null
  owner: string | null
  deadline: string | null
  sources: NoteSourceRange[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function itemText(item: Record<string, unknown>): string | null {
  return asTrimmedString(item.text) ?? asTrimmedString(item.title)
}

function itemSources(value: unknown): NoteSourceRange[] {
  if (!Array.isArray(value)) return []
  const ranges: NoteSourceRange[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    if (typeof item.startMs !== 'number' || typeof item.endMs !== 'number') continue
    if (!Number.isFinite(item.startMs) || !Number.isFinite(item.endMs)) continue
    ranges.push({ startMs: item.startMs, endMs: item.endMs })
  }
  return ranges
}

function pushItems(
  entries: NotesV2SearchEntry[],
  value: unknown,
  category: NotesSearchCategory,
  fallbackTitle: string,
  topic: string | null
): void {
  if (!Array.isArray(value)) return
  for (const item of value) {
    if (!isRecord(item)) continue
    const content = itemText(item)
    if (!content) continue
    entries.push({
      id: asTrimmedString(item.id) ?? `${category}-${entries.length}`,
      category,
      title: asTrimmedString(item.title) ?? fallbackTitle,
      content,
      topic,
      owner: asTrimmedString(item.owner),
      deadline: asTrimmedString(item.deadline),
      sources: itemSources(item.sources)
    })
  }
}

/** Walk a notes.json document without requiring a valid revision hash. */
export function collectNotesV2SearchEntries(value: unknown): NotesV2SearchEntry[] {
  if (!isRecord(value)) return []
  if (value.schemaVersion != null && value.schemaVersion !== 2) return []

  const entries: NotesV2SearchEntry[] = []
  const overviewBlock = isRecord(value.overview) ? value.overview : null
  const overview = overviewBlock ? asTrimmedString(overviewBlock.text) : null
  if (overview && overviewBlock) {
    entries.push({
      id: 'overview',
      category: 'information',
      title: 'Overview',
      content: overview,
      topic: null,
      owner: null,
      deadline: null,
      sources: itemSources(overviewBlock.sources)
    })
  }

  pushItems(entries, value.keyTakeaways, 'information', 'Key takeaway', null)

  if (Array.isArray(value.sections)) {
    for (const section of value.sections) {
      if (!isRecord(section)) continue
      const topic = asTrimmedString(section.title)
      const heading = topic ?? 'Notes'
      pushItems(entries, section.keyPoints, 'information', heading, topic)
      pushItems(entries, section.supportingDetails, 'information', heading, topic)
    }
  }

  pushItems(entries, value.decisions, 'decisions', 'Agreed', null)
  pushItems(entries, value.nextSteps, 'actionItems', 'Next step', null)
  return entries
}

export function formatNotesV2SearchBody(entries: readonly NotesV2SearchEntry[]): string {
  const byCategory = new Map<NotesSearchCategory, NotesV2SearchEntry[]>()
  for (const entry of entries) {
    const list = byCategory.get(entry.category) ?? []
    list.push(entry)
    byCategory.set(entry.category, list)
  }

  let body = ''
  for (const [category, items] of byCategory) {
    body += `\n### ${category}\n`
    for (const item of items) {
      const fields = [
        item.topic ? `Topic: ${item.topic}` : null,
        item.owner ? `Owner: ${item.owner}` : null,
        item.deadline ? `Due: ${item.deadline}` : null
      ]
        .filter(Boolean)
        .join('; ')
      body += `- **${item.title}**: ${item.content}${fields ? ` (${fields})` : ''}\n`
    }
  }
  return body.trim()
}

export function matchNotesV2SearchEntries(
  entries: readonly NotesV2SearchEntry[],
  terms: readonly string[]
): Array<{ type: 'segment'; text: string; category: string; startMs?: number }> {
  const matches: Array<{ type: 'segment'; text: string; category: string; startMs?: number }> = []
  for (const entry of entries) {
    const combined = `${entry.topic ?? ''} ${entry.title} ${entry.content}`.toLowerCase()
    if (terms.every((term) => combined.includes(term))) {
      const startMs = entry.sources[0]?.startMs
      matches.push({
        type: 'segment',
        text: `${entry.title}: ${entry.content}`,
        category: entry.category,
        ...(startMs != null ? { startMs } : {})
      })
    }
  }
  return matches
}
