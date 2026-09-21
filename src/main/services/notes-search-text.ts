import type { MeetingSegments } from '../../shared/types'

export type NotesSearchCategory = keyof MeetingSegments

export interface NotesV2SearchEntry {
  id: string
  category: NotesSearchCategory
  title: string
  content: string
  topic: string | null
  owner: string | null
  deadline: string | null
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
      deadline: asTrimmedString(item.deadline)
    })
  }
}

/** Walk a notes.json document without requiring a valid revision hash. */
export function collectNotesV2SearchEntries(value: unknown): NotesV2SearchEntry[] {
  if (!isRecord(value)) return []
  if (value.schemaVersion != null && value.schemaVersion !== 2) return []

  const entries: NotesV2SearchEntry[] = []
  const overview = isRecord(value.overview) ? asTrimmedString(value.overview.text) : null
  if (overview) {
    entries.push({
      id: 'overview',
      category: 'information',
      title: 'Overview',
      content: overview,
      topic: null,
      owner: null,
      deadline: null
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
): Array<{ type: 'segment'; text: string; category: string }> {
  const matches: Array<{ type: 'segment'; text: string; category: string }> = []
  for (const entry of entries) {
    const combined = `${entry.topic ?? ''} ${entry.title} ${entry.content}`.toLowerCase()
    if (terms.every((term) => combined.includes(term))) {
      matches.push({
        type: 'segment',
        text: `${entry.title}: ${entry.content}`,
        category: entry.category
      })
    }
  }
  return matches
}
