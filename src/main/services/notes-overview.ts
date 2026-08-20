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
- State conclusions and outcomes from the bullets, not a list of section headings
- Do not write an overview that only restates the ## titles
- No markdown

NOTES:
`

export function notesHeadingsFromMarkdown(markdown: string): string[] {
  return [...markdown.matchAll(/^##\s+(.+?)\s*$/gm)]
    .map((match) => match[1].trim())
    .filter(
      (title) => title.length > 0 && !/^next steps$/i.test(title) && !/^decisions$/i.test(title)
    )
}

export function overviewLooksLikeHeadingList(
  overview: string,
  headings: readonly string[]
): boolean {
  const text = overview.trim()
  if (/^This meeting (covered|focused on)\b/i.test(text)) return true
  const substantial = headings.map((title) => title.trim()).filter((title) => title.length >= 16)
  if (substantial.length < 2) return false
  const haystack = text.toLowerCase()
  const hits = substantial.filter((title) => haystack.includes(title.toLowerCase())).length
  return hits >= Math.ceil(substantial.length * 0.6)
}

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

export interface NotesOverviewResult extends Pick<MeetingNotesContent, 'overview' | 'keyTakeaways'> {
  usedModel: boolean
}

async function requestOverview(
  markdown: string,
  generate: NotesOverviewGenerateFn,
  temperature: number,
  numCtx: number
): Promise<{ overview: string; keyTakeaways: string[] } | null> {
  try {
    const raw = await generate({
      prompt: `${OVERVIEW_PROMPT}${markdown.trim()}`,
      num_ctx: numCtx,
      num_predict: 400,
      temperature
    })
    return parseOverviewPayload(raw)
  } catch {
    return null
  }
}

export async function generateNotesOverview(
  markdown: string,
  generate: NotesOverviewGenerateFn,
  sources: readonly NoteSourceRange[],
  options?: { numCtx?: number }
): Promise<NotesOverviewResult> {
  const numCtx = options?.numCtx && options.numCtx > 0 ? options.numCtx : 4096
  const fallbackSources = sources.length > 0 ? sources : [{ startMs: 0, endMs: 0 }]
  const headings = notesHeadingsFromMarkdown(markdown)
  const usable = (
    parsed: { overview: string; keyTakeaways: string[] } | null
  ): parsed is { overview: string; keyTakeaways: string[] } => {
    const overview = parsed?.overview
    return Boolean(overview) && !overviewLooksLikeHeadingList(overview, headings)
  }

  let parsed = await requestOverview(markdown, generate, 0.2, numCtx)
  if (!usable(parsed)) {
    const retry = await requestOverview(markdown, generate, 0.35, numCtx)
    if (usable(retry) || (!parsed?.overview && retry?.overview)) {
      parsed = retry
    }
  }
  if (!parsed?.overview) {
    return {
      overview: null,
      keyTakeaways: (parsed?.keyTakeaways ?? []).map((text) => takeaway(text, fallbackSources)),
      usedModel: false
    }
  }
  return {
    overview: block(parsed.overview, fallbackSources),
    keyTakeaways: parsed.keyTakeaways.map((text) => takeaway(text, fallbackSources)),
    usedModel: true
  }
}
