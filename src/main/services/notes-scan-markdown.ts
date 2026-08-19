import { createHash } from 'crypto'
import type { MeetingNotesContent, NoteItem, NoteSection, NoteSourceRange } from '../../shared/types'

export interface ScanMarkdownParseOptions {
  fallbackSources: readonly NoteSourceRange[]
}

function itemId(prefix: string, text: string): string {
  return `${prefix}-${createHash('sha256').update(text).digest('hex').slice(0, 16)}`
}

const PERSON_OWNER_STOPLIST = new Set([
  'determine',
  'english',
  'spanish',
  'review',
  'update',
  'updates',
  'team',
  'teams',
  'all',
  'everyone',
  'anyone',
  'tbd',
  'todo',
  'pending',
  'later',
  'backlog',
  'next',
  'engineering',
  'design',
  'ops',
  'sales',
  'support',
  'marketing',
  'follow',
  'followup',
  'assess',
  'adjusted',
  'adjust',
  'switch',
  'finish',
  'finished',
  'evaluate',
  'investigate',
  'implement',
  'improve',
  'create',
  'establish',
  'enable',
  'adopt',
  'add',
  'fix',
  'research',
  'consider',
  'confirm',
  'schedule',
  'monitor',
  'deploy',
  'ship',
  'build',
  'test',
  'verify',
  'draft',
  'define',
  'decide',
  'align',
  'plan',
  'track',
  'escalate',
  'notify',
  'document',
  'deadline',
  'asap',
  'today',
  'tomorrow',
  'week',
  'month',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
  'yeah',
  'yes',
  'no',
  'okay',
  'ok',
  'sure',
  'right',
  'thanks',
  'hello',
  'hey',
  'cool',
  'well',
  'um',
  'uh',
  'hmm',
  'me',
  'them',
  'us',
  'we',
  'they',
  'him',
  'her',
  'speaker',
  'user',
  'others'
])

const PERSON_OWNER_TOKEN = /^\p{Lu}\p{Ll}*(?:['’-]\p{Lu}\p{Ll}+)*$/u

export function isPlausiblePersonOwner(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed || /[,0-9/&]/.test(trimmed)) return false
  const tokens = trimmed.split(/\s+/)
  if (tokens.length < 1 || tokens.length > 3) return false
  return tokens.every((token) => {
    if (token.length < 2 || token.length > 20) return false
    if (!PERSON_OWNER_TOKEN.test(token)) return false
    return !PERSON_OWNER_STOPLIST.has(token.toLowerCase())
  })
}

function makeItem(
  prefix: string,
  text: string,
  extras: Partial<Pick<NoteItem, 'title' | 'topic' | 'owner' | 'deadline'>>,
  sources: readonly NoteSourceRange[]
): NoteItem {
  const owner = extras.owner ?? null
  return {
    id: itemId(prefix, `${extras.title ?? ''}\n${text}`),
    title: extras.title ?? null,
    topic: extras.topic ?? null,
    owner: owner && isPlausiblePersonOwner(owner) ? owner : null,
    deadline: extras.deadline ?? null,
    text,
    sources: sources.map((source) => ({ ...source })),
    provenance: 'generated',
    completed: false
  }
}

function parseNextStep(line: string): { title: string; owner: string | null } | null {
  const match = /^\*\s+\*\*(.+?)\*\*(?:\s+\(([^)]+)\))?/.exec(line.trim())
  if (!match) return null
  const title = match[1].trim()
  const captured = match[2]?.trim() || null
  const owner = captured && isPlausiblePersonOwner(captured) ? captured : null
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
