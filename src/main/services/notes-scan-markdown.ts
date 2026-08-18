import { createHash } from 'crypto'
import type { MeetingNotesContent, NoteItem, NoteSection, NoteSourceRange } from '../../shared/types'

export interface ScanMarkdownParseOptions {
  fallbackSources: readonly NoteSourceRange[]
}

function itemId(prefix: string, text: string): string {
  return `${prefix}-${createHash('sha256').update(text).digest('hex').slice(0, 16)}`
}

function makeItem(
  prefix: string,
  text: string,
  extras: Partial<Pick<NoteItem, 'title' | 'topic' | 'owner' | 'deadline'>>,
  sources: readonly NoteSourceRange[]
): NoteItem {
  return {
    id: itemId(prefix, `${extras.title ?? ''}\n${text}`),
    title: extras.title ?? null,
    topic: extras.topic ?? null,
    owner: extras.owner ?? null,
    deadline: extras.deadline ?? null,
    text,
    sources: sources.map((source) => ({ ...source })),
    provenance: 'generated'
  }
}

function parseNextStep(line: string): { title: string; owner: string | null } | null {
  const match = /^\*\s+\*\*(.+?)\*\*(?:\s+\(([^)]+)\))?/.exec(line.trim())
  if (!match) return null
  const title = match[1].trim()
  const owner = match[2]?.trim() || null
  return { title, owner }
}

export function parseScanMarkdown(
  markdown: string,
  options: ScanMarkdownParseOptions
): MeetingNotesContent {
  const sources =
    options.fallbackSources.length > 0 ? [...options.fallbackSources] : [{ startMs: 0, endMs: 0 }]
  const sections: NoteSection[] = []
  const nextSteps: NoteItem[] = []
  let current: {
    title: string
    keyPoints: NoteItem[]
    supportingDetails: NoteItem[]
  } | null = null
  let mode: 'body' | 'nextSteps' = 'body'

  const flush = (): void => {
    if (!current) return
    if (current.keyPoints.length === 0 && current.supportingDetails.length === 0) {
      current = null
      return
    }
    sections.push({
      id: itemId('section', current.title),
      title: current.title,
      summary: null,
      keyPoints: current.keyPoints,
      supportingDetails: current.supportingDetails
    })
    current = null
  }

  for (const raw of markdown.split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(raw)
    if (heading) {
      const title = heading[2].trim()
      if (heading[1].length === 1) continue
      if (/^next steps$/iu.test(title)) {
        flush()
        mode = 'nextSteps'
        continue
      }
      if (/^decisions$/iu.test(title)) {
        flush()
        mode = 'body'
        continue
      }
      flush()
      mode = 'body'
      current = { title, keyPoints: [], supportingDetails: [] }
      continue
    }

    if (mode === 'nextSteps') {
      const next = parseNextStep(raw)
      if (next) {
        nextSteps.push(
          makeItem('next', next.title, { title: next.title, owner: next.owner }, sources)
        )
      }
      continue
    }

    const nested = /^\s+[-*]\s+(.*)$/.exec(raw)
    const child = /^[-*]\s+(.*)$/.exec(raw)
    if (nested) {
      if (!current) {
        current = { title: 'Notes', keyPoints: [], supportingDetails: [] }
      }
      current.supportingDetails.push(
        makeItem('detail', nested[1].trim(), { topic: current.title }, sources)
      )
      continue
    }
    if (child) {
      if (!current) {
        current = { title: 'Notes', keyPoints: [], supportingDetails: [] }
      }
      current.keyPoints.push(
        makeItem('point', child[1].trim(), { topic: current.title, title: child[1].trim() }, sources)
      )
    }
  }
  flush()

  return {
    overview: null,
    keyTakeaways: [],
    sections,
    decisions: [],
    nextSteps
  }
}

export function meetingSpanSources(
  rows: readonly { startMs: number; endMs: number }[]
): NoteSourceRange[] {
  if (rows.length === 0) return [{ startMs: 0, endMs: 0 }]
  let startMs = rows[0].startMs
  let endMs = rows[0].endMs
  for (const row of rows) {
    startMs = Math.min(startMs, row.startMs)
    endMs = Math.max(endMs, row.endMs)
  }
  return [{ startMs, endMs: Math.max(endMs, startMs) }]
}
