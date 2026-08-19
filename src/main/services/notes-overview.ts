import { createHash } from 'crypto'
import type { MeetingNotesContent, NoteItem, NoteSourceRange, NoteTextBlock } from '../../shared/types'

export interface NotesOverviewGenerateRequest {
  prompt: string
  num_ctx: number
  num_predict: number
  temperature: number
}

export type NotesOverviewGenerateFn = (request: NotesOverviewGenerateRequest) => Promise<string>

const OVERVIEW_PROMPT = `Summarize the finished meeting notes below for a busy reader.
Return ONLY JSON with this shape:
{"overview":"one or two short sentences","keyTakeaways":["short takeaway","short takeaway"]}
Rules:
- 1 to 4 keyTakeaways
- Use only facts that appear in the notes
- Do not invent owners, dates, or decisions
- No markdown

NOTES:
`

function parseOverviewPayload(raw: string): { overview: string; keyTakeaways: string[] } | null {
  const stripped = raw.trim()
  const start = stripped.indexOf('{')
  const end = stripped.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(stripped.slice(start, end + 1)) as {
      overview?: unknown
      keyTakeaways?: unknown
    }
    const overview = typeof parsed.overview === 'string' ? parsed.overview.trim() : ''
    const takeaways = Array.isArray(parsed.keyTakeaways)
      ? parsed.keyTakeaways
          .filter((row): row is string => typeof row === 'string')
          .map((row) => row.trim())
          .filter((row) => row.length > 0)
          .slice(0, 4)
      : []
    if (!overview && takeaways.length === 0) return null
    return { overview, keyTakeaways: takeaways }
  } catch {
    return null
  }
}

function block(text: string, sources: readonly NoteSourceRange[]): NoteTextBlock {
  return {
    text,
    sources: sources.map((source) => ({ ...source })),
    provenance: 'generated'
  }
}

function takeaway(text: string, sources: readonly NoteSourceRange[]): NoteItem {
  return {
    id: `takeaway-${createHash('sha256').update(text).digest('hex').slice(0, 16)}`,
    title: text,
    topic: null,
    owner: null,
    deadline: null,
    text,
    sources: sources.map((source) => ({ ...source })),
    provenance: 'generated',
    completed: false
  }
}

export async function generateNotesOverview(
  markdown: string,
  generate: NotesOverviewGenerateFn,
  sources: readonly NoteSourceRange[]
): Promise<Pick<MeetingNotesContent, 'overview' | 'keyTakeaways'>> {
  const fallbackSources = sources.length > 0 ? sources : [{ startMs: 0, endMs: 0 }]
  const raw = await generate({
    prompt: `${OVERVIEW_PROMPT}${markdown.trim()}`,
    num_ctx: 4096,
    num_predict: 400,
    temperature: 0.2
  })
  const parsed = parseOverviewPayload(raw)
  if (!parsed) {
    return { overview: null, keyTakeaways: [] }
  }
  return {
    overview: parsed.overview ? block(parsed.overview, fallbackSources) : null,
    keyTakeaways: parsed.keyTakeaways.map((text) => takeaway(text, fallbackSources))
  }
}
