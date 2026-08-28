import { createHash } from 'crypto'
import type { CatalogItem, TopicGroup } from '../../../scripts/notes-writer-probe/groups.ts'
import { distinctiveContentLemmas } from '../../../scripts/notes-writer-probe/arm-g.ts'
import type { MeetingNotesContent, NoteItem, NoteSourceRange } from '../../shared/types'

export const TICKET_RE = /\bDD[- ]?\d{3,5}\b/gi
export const WRITER_QUANTITY_RE =
  /\b(?:\d+\s+starts?|(?:six|6)\s+cancels?|\d+(?:\.\d+){1,3})\b/gi
const SPOKEN_DIGIT =
  'zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen'
const WINDOWS_MEMORY_SIZE_RE = /\b\d+(?:\.\d+)?\s*(?:gb|gib|mb|mib|tb|tib)\b/gi
const WINDOWS_SPOKEN_MEMORY_RE = new RegExp(
  `\\b(?:${SPOKEN_DIGIT}|\\d+)\\s+(?:gb|gib|gig|gigs|gigabytes?|mb|mib|tb|tib)\\b`,
  'gi'
)
const WINDOWS_SPOKEN_VERSION_RE = new RegExp(
  `\\b(?:${SPOKEN_DIGIT})(?:(?:\\s+dot\\s+|\\s+|-)(?:${SPOKEN_DIGIT})){2,}\\b`,
  'gi'
)
const WINDOWS_SPOKEN_COUNT_RE = new RegExp(
  `\\b(?:${SPOKEN_DIGIT}|\\d+)\\s+(?:starts?|cancels?|cancellations?)\\b`,
  'gi'
)

const GENERIC_GROUP_NAMES = new Set([
  'technical architecture',
  'technical changes',
  'technical deployment',
  'technical behavior',
  'technical issues',
  'technical planning',
  'pricing & costs',
  'pricing and costs',
  'release planning',
  'project planning',
  'development prioritization',
  'visual design',
  'information',
  'discussion',
  'status updates',
  'decisions',
  'action items',
  'notes',
  'other topics'
])

const AGREEMENT_ASSERTION = /\b(agreed|decided|decision|finalized|approved|unsupported)\b/i

export function normalizeTicketId(ticket: string): string {
  return ticket.replace(/[- ]/g, '').toUpperCase()
}

export function ticketsInText(text: string): string[] {
  const seen = new Set<string>()
  const ids: string[] = []
  for (const match of text.matchAll(new RegExp(TICKET_RE.source, TICKET_RE.flags))) {
    const id = normalizeTicketId(match[0])
    if (seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

export function writerQuantitiesInText(
  text: string,
  platform: NodeJS.Platform = process.platform
): string[] {
  const seen = new Set<string>()
  const values: string[] = []
  const patterns = [WRITER_QUANTITY_RE]
  if (platform === 'win32') {
    patterns.push(
      WINDOWS_MEMORY_SIZE_RE,
      WINDOWS_SPOKEN_MEMORY_RE,
      WINDOWS_SPOKEN_VERSION_RE,
      WINDOWS_SPOKEN_COUNT_RE
    )
  }
  for (const pattern of patterns) {
    for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
      const key = match[0].toLowerCase().replace(/\s+/g, ' ')
      if (seen.has(key)) continue
      seen.add(key)
      values.push(match[0].replace(/\s+/g, ' '))
    }
  }
  return values
}

export function isGenericGroupName(name: string): boolean {
  const trimmed = name.trim().toLowerCase()
  if (GENERIC_GROUP_NAMES.has(trimmed)) return true
  return /^technical\b/.test(trimmed)
}

export function entitiesPreserved(input: string, output: string): boolean {
  const tickets = ticketsInText(input)
  const outputTickets = new Set(ticketsInText(output))
  if (!tickets.every((ticket) => outputTickets.has(ticket))) return false
  const quantities = writerQuantitiesInText(input)
  const outputLower = output.toLowerCase()
  return quantities.every((quantity) => outputLower.includes(quantity.toLowerCase()))
}

function itemId(prefix: string, text: string): string {
  return `${prefix}-${createHash('sha256').update(text).digest('hex').slice(0, 16)}`
}

function flattenNotes(content: MeetingNotesContent): string {
  const parts: string[] = []
  if (content.overview?.text) parts.push(content.overview.text)
  for (const item of content.keyTakeaways) parts.push(`${item.title ?? ''} ${item.text}`)
  for (const section of content.sections) {
    parts.push(section.title)
    for (const item of [...section.keyPoints, ...section.supportingDetails]) {
      parts.push(`${item.title ?? ''} ${item.text}`)
    }
  }
  for (const item of content.nextSteps) parts.push(`${item.title ?? ''} ${item.text}`)
  return parts.join('\n')
}

function catalogLemmas(row: CatalogItem): Set<string> {
  return distinctiveContentLemmas(`${row.titleLine} ${row.fullText}`)
}

function groupTitle(members: readonly CatalogItem[]): string {
  const titled = members
    .map((row) => row.titleLine.trim())
    .filter((title) => title.length > 0 && !isGenericGroupName(title))
    .sort((left, right) => left.length - right.length)
  const raw = titled[0] ?? members[0]?.titleLine.trim() ?? 'Notes'
  return raw.replace(/[.]+$/u, '').slice(0, 72)
}

export function groupsFromCatalog(catalog: readonly CatalogItem[]): TopicGroup[] {
  if (catalog.length === 0) return []

  const byTicket = new Map<string, CatalogItem[]>()
  const unassigned: CatalogItem[] = []
  for (const row of catalog) {
    const tickets = ticketsInText(`${row.titleLine} ${row.fullText}`)
    if (tickets.length === 1) {
      const list = byTicket.get(tickets[0]) ?? []
      list.push(row)
      byTicket.set(tickets[0], list)
    } else {
      unassigned.push(row)
    }
  }

  const groups: TopicGroup[] = []
  const used = new Set<string>()
  for (const [ticket, members] of byTicket) {
    for (const row of members) used.add(row.id)
    groups.push({ name: members.length === 1 ? groupTitle(members) : ticket, ids: members.map((row) => row.id) })
  }

  const remaining = catalog.filter((row) => !used.has(row.id))
  for (const seed of remaining) {
    if (used.has(seed.id)) continue
    const seedLemmas = catalogLemmas(seed)
    const members = [seed]
    used.add(seed.id)
    if (seedLemmas.size >= 2) {
      for (const candidate of remaining) {
        if (used.has(candidate.id)) continue
        const shared = [...catalogLemmas(candidate)].filter((lemma) => seedLemmas.has(lemma)).length
        if (shared >= 2) {
          members.push(candidate)
          used.add(candidate.id)
        }
      }
    }
    groups.push({ name: groupTitle(members), ids: members.map((row) => row.id) })
  }

  return groups.slice(0, 8)
}

export function chooseScanGroups(
  llmGroups: readonly TopicGroup[] | null,
  writerGroups: readonly TopicGroup[],
  catalog: readonly CatalogItem[]
): { groups: TopicGroup[]; groupingFallback: boolean; usedSpecificCatalog: boolean } {
  const llmUsable =
    llmGroups != null &&
    llmGroups.length >= 2 &&
    llmGroups.every((group) => !isGenericGroupName(group.name))
  if (llmUsable && llmGroups) {
    return { groups: [...llmGroups], groupingFallback: false, usedSpecificCatalog: false }
  }

  const specific = groupsFromCatalog(catalog)
  const specificUsable =
    specific.length >= 2 && specific.some((group) => !isGenericGroupName(group.name))
  if (specificUsable) {
    return { groups: specific, groupingFallback: false, usedSpecificCatalog: true }
  }

  const writerSpecific = writerGroups.filter((group) => !isGenericGroupName(group.name))
  if (writerSpecific.length >= 2) {
    return { groups: writerSpecific, groupingFallback: false, usedSpecificCatalog: false }
  }

  if (writerGroups.length > 0) {
    return { groups: [...writerGroups], groupingFallback: false, usedSpecificCatalog: false }
  }

  return { groups: specific.length > 0 ? specific : [], groupingFallback: true, usedSpecificCatalog: false }
}

function makeDetail(
  text: string,
  topic: string,
  sources: readonly NoteSourceRange[]
): NoteItem {
  return {
    id: itemId('detail', `\n${text}`),
    title: null,
    topic,
    owner: null,
    deadline: null,
    text,
    sources: sources.map((source) => ({ ...source })),
    provenance: 'generated',
    completed: false
  }
}

function bestSectionIndex(content: MeetingNotesContent, needle: string): number {
  if (content.sections.length === 0) return -1
  const lemmas = distinctiveContentLemmas(needle)
  let best = 0
  let bestScore = -1
  for (const [index, section] of content.sections.entries()) {
    const hay = [
      section.title,
      ...section.keyPoints.map((item) => `${item.title ?? ''} ${item.text}`),
      ...section.supportingDetails.map((item) => item.text)
    ].join(' ')
    const hayLemmas = distinctiveContentLemmas(hay)
    let score = 0
    for (const lemma of lemmas) {
      if (hayLemmas.has(lemma)) score += 1
    }
    if (score > bestScore) {
      bestScore = score
      best = index
    }
  }
  return best
}

function appendDetail(
  content: MeetingNotesContent,
  text: string,
  sources: readonly NoteSourceRange[]
): MeetingNotesContent {
  if (content.sections.length === 0) return content
  const index = bestSectionIndex(content, text)
  const section = content.sections[index]
  if (!section) return content
  const item = makeDetail(text, section.title, sources)
  return {
    ...content,
    sections: content.sections.map((row, rowIndex) =>
      rowIndex === index
        ? { ...row, supportingDetails: [...row.supportingDetails, item] }
        : row
    )
  }
}

export function preserveWriterEntities(
  content: MeetingNotesContent,
  catalog: readonly CatalogItem[]
): MeetingNotesContent {
  let working = content
  let flattened = flattenNotes(working)
  const seenTickets = new Set(ticketsInText(flattened))

  for (const row of catalog) {
    const blob = `${row.titleLine}\n${row.fullText}`
    const sources =
      row.item.sources.length > 0 ? row.item.sources : [{ startMs: 0, endMs: 0 }]
    for (const ticket of ticketsInText(blob)) {
      if (seenTickets.has(ticket)) continue
      working = appendDetail(working, `${ticket} — ${row.titleLine || row.fullText.slice(0, 160)}`, sources)
      seenTickets.add(ticket)
      flattened = flattenNotes(working)
    }
    for (const quantity of writerQuantitiesInText(blob)) {
      if (flattenNotes(working).toLowerCase().includes(quantity.toLowerCase())) continue
      working = appendDetail(working, `${row.titleLine || quantity}: ${quantity}`, sources)
    }
  }
  return working
}

export function appendTranscriptTickets(
  content: MeetingNotesContent,
  rows: readonly { text: string; startMs: number; endMs: number }[]
): MeetingNotesContent {
  let working = content
  const seen = new Set(ticketsInText(flattenNotes(working)))
  for (const row of rows) {
    for (const ticket of ticketsInText(row.text)) {
      if (seen.has(ticket)) continue
      const snippet = row.text.trim().replace(/\s+/g, ' ').slice(0, 160)
      working = appendDetail(working, `${ticket} — ${snippet}`, [{ startMs: row.startMs, endMs: row.endMs }])
      seen.add(ticket)
    }
  }
  return working
}

export function appendTranscriptQuantities(
  content: MeetingNotesContent,
  rows: readonly { text: string; startMs: number; endMs: number }[],
  platform: NodeJS.Platform = process.platform
): MeetingNotesContent {
  if (platform !== 'win32') return content
  let working = content
  for (const row of rows) {
    const quantities = writerQuantitiesInText(row.text, platform)
    if (quantities.length === 0) continue
    const flattened = flattenNotes(working).toLowerCase()
    const missing = quantities.filter((quantity) => !flattened.includes(quantity.toLowerCase()))
    if (missing.length === 0) continue
    const snippet = row.text.trim().replace(/\s+/g, ' ').slice(0, 160)
    working = appendDetail(working, snippet, [{ startMs: row.startMs, endMs: row.endMs }])
  }
  return working
}

export function dropAssertiveTakeaways(content: MeetingNotesContent): MeetingNotesContent {
  return {
    ...content,
    keyTakeaways: content.keyTakeaways.filter(
      (item) => !AGREEMENT_ASSERTION.test(`${item.title ?? ''} ${item.text}`)
    )
  }
}
