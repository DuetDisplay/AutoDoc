import { createHash } from 'crypto'
import type { MeetingNotesContent, NoteItem, NoteSourceRange, NoteTextBlock } from '../../shared/types'

export interface NotesOverviewGenerateRequest {
  prompt: string
  num_ctx: number
  num_predict: number
  temperature: number
  /** Ollama structured-output schema; grammar-forces valid JSON from small models. */
  format?: unknown
}

export type NotesOverviewGenerateFn = (request: NotesOverviewGenerateRequest) => Promise<string>

const OVERVIEW_RESPONSE_FORMAT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    overview: { type: 'string' },
    keyTakeaways: { type: 'array', items: { type: 'string' }, maxItems: 4 }
  },
  required: ['overview', 'keyTakeaways']
} as const

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
  /** Why the model output was rejected, one entry per failed attempt. Empty on success. */
  failureReasons: string[]
}

interface OverviewAttempt {
  parsed: { overview: string; keyTakeaways: string[] } | null
  failure: string | null
}

async function requestOverview(
  markdown: string,
  generate: NotesOverviewGenerateFn,
  temperature: number,
  numCtx: number
): Promise<OverviewAttempt> {
  let raw: string
  try {
    raw = await generate({
      prompt: `${OVERVIEW_PROMPT}${markdown.trim()}`,
      num_ctx: numCtx,
      num_predict: 400,
      temperature,
      format: OVERVIEW_RESPONSE_FORMAT
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { parsed: null, failure: `generate failed: ${message}` }
  }
  const parsed = parseOverviewPayload(raw)
  if (!parsed) {
    return { parsed: null, failure: `unparseable response: ${raw.trim().slice(0, 160)}` }
  }
  return { parsed, failure: null }
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
  const usable = (parsed: { overview: string; keyTakeaways: string[] } | null): boolean => {
    const overview = parsed?.overview
    return (
      typeof overview === 'string' &&
      overview.length > 0 &&
      !overviewLooksLikeHeadingList(overview, headings)
    )
  }

  const failureReasons: string[] = []
  const noteRejection = (
    attempt: OverviewAttempt,
    label: string
  ): void => {
    if (attempt.failure) {
      failureReasons.push(`${label}: ${attempt.failure}`)
    } else if (!attempt.parsed?.overview) {
      failureReasons.push(`${label}: response had no overview text`)
    } else if (!usable(attempt.parsed)) {
      failureReasons.push(`${label}: overview restated section headings`)
    }
  }

  const first = await requestOverview(markdown, generate, 0.2, numCtx)
  let parsed = first.parsed
  if (!usable(parsed)) {
    noteRejection(first, 'attempt 1')
    const retry = await requestOverview(markdown, generate, 0.35, numCtx)
    if (usable(retry.parsed) || (!parsed?.overview && retry.parsed?.overview)) {
      parsed = retry.parsed
    } else {
      noteRejection(retry, 'attempt 2')
    }
  }
  if (!parsed?.overview) {
    return {
      overview: null,
      keyTakeaways: (parsed?.keyTakeaways ?? []).map((text) => takeaway(text, fallbackSources)),
      usedModel: false,
      failureReasons
    }
  }
  return {
    overview: block(parsed.overview, fallbackSources),
    keyTakeaways: parsed.keyTakeaways.map((text) => takeaway(text, fallbackSources)),
    usedModel: true,
    failureReasons
  }
}
