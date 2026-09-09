import { createHash } from 'crypto'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import type { MeetingNotesContent, NoteItem, NoteSourceRange, NoteTextBlock } from '../../shared/types'
import { isNeedsReviewTopic } from '../../shared/notes-presentation'
import {
  checkQuantityGrounding,
  extractQuantityMentions,
  quantityMentionsEquivalent,
  type QuantityMention
} from './notes-quantity-canonicalizer'

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

const OVERVIEW_ONLY_PROMPT = `Summarize the finished meeting notes below for a busy reader.
Return ONLY JSON with this shape:
{"overview":"concise meeting summary"}
Rules:
- Prefer one or a few sentences; write more only when needed to cover the meeting's main subjects
- Cover the meeting's main areas, important outcomes, and unresolved conditions
- Do not let one number or decision stand in for the whole meeting
- Use only facts that appear in the notes
- Keep each number bound to the same limit, count, or comparison named in the notes
- If one note names two numbers, keep both roles; do not drop one and treat the other as the whole constraint
- Preserve tentative versus confirmed status and conditional wording
- Do not turn should, may, consider, or going to into a completed decision or existing state
- Do not invent owners, dates, relationships, or decisions
- Do not list section headings
- Do not copy two bullets verbatim as the overview
- No markdown

NOTES:
`

const OVERVIEW_CAPACITY =
  /\b(?:limit|capped|cap|maximum|max(?:imum)?|allows?|allowing|up to)\b/iu
const OVERVIEW_TENTATIVE =
  /\b(?:should|may|might|could|consider(?:ing)?|uncertain|unclear|going to|leaning|appears?|maybe|possibly|i(?:'m| am)? going to)\b/iu
const OVERVIEW_FIRM =
  /\b(?:will|must|decided|approved|confirmed|confirms|is set|has been)\b/iu
const OVERVIEW_INTENT =
  /\b(?:i(?:'m| am)? going to|going to change|plan(?:ning)? to)\b/iu
const OVERVIEW_FUTURE_OR_INTENT =
  /\b(?:will|going to|plan(?:ned|s|ning)?|next steps?|should|may|might|could)\b/iu
const OVERVIEW_TOKEN = /[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu
const OVERVIEW_TOKEN_STOP = new Set([
  'about',
  'after',
  'also',
  'and',
  'are',
  'been',
  'for',
  'from',
  'have',
  'into',
  'more',
  'only',
  'over',
  'some',
  'than',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'was',
  'were',
  'with',
  'would'
])

function overviewClauses(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|(?<=;)\s+|,\s+/u)
    .map((clause) => clause.replace(/\s+/gu, ' ').trim())
    .filter((clause) => clause.length > 0)
}

function catalogBulletLines(markdown: string): string[] {
  return markdown
    .split('\n')
    .map((line) => line.replace(/^#+\s+/, '').replace(/^[-*]\s+/, '').trim())
    .filter((line) => line.length > 0)
}

function catalogEvidenceClauses(markdown: string): string[] {
  return catalogBulletLines(markdown).flatMap((line) => overviewClauses(line))
}

function quantityHasCapacityBinding(text: string, mention: QuantityMention): boolean {
  const others = extractQuantityMentions(text).filter((row) => row.start !== mention.start)
  const previous = others.filter((row) => row.end <= mention.start).sort((left, right) => right.end - left.end)[0]
  const next = others.filter((row) => row.start >= mention.end).sort((left, right) => left.start - right.start)[0]
  const start = previous ? previous.end : Math.max(0, mention.start - 40)
  const end = next ? next.start : Math.min(text.length, mention.end + 40)
  return OVERVIEW_CAPACITY.test(text.slice(start, end))
}

function overviewTokens(text: string): string[] {
  return (text.toLocaleLowerCase().match(OVERVIEW_TOKEN) ?? []).filter(
    (token) => token.length >= 3 && !OVERVIEW_TOKEN_STOP.has(token)
  )
}

function quantityAppearsInCatalog(mention: QuantityMention, catalog: string): boolean {
  const haystack = catalog.toLocaleLowerCase()
  const needles = [mention.raw.replace(/,$/u, ''), ...mention.aliases]
  return needles.some((needle) => needle && haystack.includes(needle.toLocaleLowerCase()))
}

export type OverviewCatalogConflict =
  | 'invented-quantity'
  | 'quantity-constraint-mismatch'
  | 'modality-promotion'
  | 'intent-as-state'

/** Rejects overview wording the finished notes cannot support. */
export function overviewConflictsWithCatalog(
  overview: string,
  catalog: string
): OverviewCatalogConflict | null {
  try {
    const grounding = checkQuantityGrounding(overview, catalog)
    if (
      grounding.unsupported.some(
        (mention) =>
          mention.kind !== 'version' && !quantityAppearsInCatalog(mention, catalog)
      )
    ) {
      return 'invented-quantity'
    }
  } catch {
    // Quantity parsing is best-effort; a parser miss must not fail notes.
  }

  try {
  const evidence = catalogEvidenceClauses(catalog)
  for (const clause of overviewClauses(overview)) {
    if (OVERVIEW_CAPACITY.test(clause)) {
      for (const mention of extractQuantityMentions(clause)) {
        if (!quantityHasCapacityBinding(clause, mention)) continue
        const support = evidence.filter((row) =>
          extractQuantityMentions(row).some((candidate) =>
            quantityMentionsEquivalent(mention, candidate)
          )
        )
        if (
          support.length > 0 &&
          !support.some((row) =>
            extractQuantityMentions(row).some(
              (candidate) =>
                quantityMentionsEquivalent(mention, candidate) &&
                quantityHasCapacityBinding(row, candidate)
            )
          )
        ) {
          return 'quantity-constraint-mismatch'
        }
      }
    }

    if (OVERVIEW_FIRM.test(clause) && !OVERVIEW_TENTATIVE.test(clause)) {
      for (const mention of extractQuantityMentions(clause)) {
        const support = evidence.filter((row) =>
          extractQuantityMentions(row).some((candidate) =>
            quantityMentionsEquivalent(mention, candidate)
          )
        )
        if (
          support.length > 0 &&
          support.every((row) => OVERVIEW_TENTATIVE.test(row)) &&
          !support.some((row) => OVERVIEW_FIRM.test(row))
        ) {
          return 'modality-promotion'
        }
      }
    }
  }

  const overviewText = overview.toLocaleLowerCase()
  for (const row of catalogBulletLines(catalog)) {
    if (!OVERVIEW_INTENT.test(row)) continue
    const wanted = [...new Set(overviewTokens(row))].filter(
      (token) => !/^(?:going|change|support|works?|that)$/u.test(token)
    )
    const hits = wanted.filter((token) =>
      new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\b`, 'u').test(overviewText)
    )
    if (hits.length < 3) continue
    const indexes = hits
      .map((token) => overviewText.search(new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\b`, 'u')))
      .filter((index) => index >= 0)
    if (indexes.length === 0) continue
    const start = Math.max(0, Math.min(...indexes) - 24)
    const end = Math.min(overview.length, Math.max(...indexes) + 24)
    const span = overview.slice(start, end)
    if (!OVERVIEW_FUTURE_OR_INTENT.test(span)) return 'intent-as-state'
  }

  return null
  } catch {
    return null
  }
}

const OVERVIEW_ONLY_FORMAT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    overview: { type: 'string' }
  },
  required: ['overview']
} as const

function noteItemLines(items: readonly NoteItem[]): string[] {
  return items
    .filter((item) => !isNeedsReviewTopic(item.topic) && item.text.trim())
    .map((item) => `- ${item.text.replace(/\s+/gu, ' ').trim()}`)
}

/** Compact notes dump for the overview-only call. Omits the copied highlight overview. */
export function notesCatalogMarkdown(content: MeetingNotesContent): string {
  const lines: string[] = []
  const takeaways = noteItemLines(content.keyTakeaways)
  if (takeaways.length) lines.push('## Key Takeaways', ...takeaways, '')
  for (const section of content.sections) {
    if (isNeedsReviewTopic(section.title)) continue
    const bullets = noteItemLines([...section.keyPoints, ...section.supportingDetails])
    if (bullets.length === 0) continue
    const heading = section.title.trim()
    if (heading) lines.push(`## ${heading}`)
    lines.push(...bullets, '')
  }
  const decisions = noteItemLines(content.decisions)
  if (decisions.length) lines.push('## Decisions', ...decisions, '')
  const nextSteps = noteItemLines(content.nextSteps)
  if (nextSteps.length) lines.push('## Next Steps', ...nextSteps, '')
  return lines.join('\n').trim()
}

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
  numCtx: number,
  overviewOnly: boolean
): Promise<OverviewAttempt> {
  let raw: string
  try {
    raw = await generate({
      prompt: `${overviewOnly ? OVERVIEW_ONLY_PROMPT : OVERVIEW_PROMPT}${markdown.trim()}`,
      num_ctx: numCtx,
      num_predict: overviewOnly ? 256 : 400,
      temperature,
      format: overviewOnly ? OVERVIEW_ONLY_FORMAT : OVERVIEW_RESPONSE_FORMAT
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
  options?: { numCtx?: number; overviewOnly?: boolean; meetingId?: string }
): Promise<NotesOverviewResult> {
  const startedAt = Date.now()
  const overviewOnly = options?.overviewOnly === true
  const numCtx = options?.numCtx && options.numCtx > 0 ? options.numCtx : 4096
  const fallbackSources = sources.length > 0 ? sources : [{ startMs: 0, endMs: 0 }]
  const headings = notesHeadingsFromMarkdown(markdown)
  const catalogConflict = (overview: string): OverviewCatalogConflict | null =>
    overviewConflictsWithCatalog(overview, markdown)
  const usable = (parsed: { overview: string; keyTakeaways: string[] } | null): boolean => {
    const overview = parsed?.overview
    return (
      typeof overview === 'string' &&
      overview.length > 0 &&
      !overviewLooksLikeHeadingList(overview, headings) &&
      catalogConflict(overview) === null
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
    } else if (overviewLooksLikeHeadingList(attempt.parsed.overview, headings)) {
      failureReasons.push(`${label}: overview restated section headings`)
    } else {
      const conflict = catalogConflict(attempt.parsed.overview)
      if (conflict) failureReasons.push(`${label}: overview ${conflict.replace(/-/gu, ' ')}`)
    }
  }

  const first = await requestOverview(markdown, generate, 0.2, numCtx, overviewOnly)
  let parsed = first.parsed
  if (!usable(parsed)) {
    noteRejection(first, 'attempt 1')
    const retry = await requestOverview(markdown, generate, 0.35, numCtx, overviewOnly)
    if (usable(retry.parsed)) {
      parsed = retry.parsed
    } else {
      noteRejection(retry, 'attempt 2')
      if (!parsed) parsed = retry.parsed
    }
  }
  // A nonempty response can still fail the quality check on both attempts.
  // Do not resurrect that rejected overview as a successful model result.
  const accepted = usable(parsed) ? parsed : null
  const result: NotesOverviewResult = !accepted
    ? {
        overview: null,
        keyTakeaways: overviewOnly
          ? []
          : (parsed?.keyTakeaways ?? []).map((text) => takeaway(text, fallbackSources)),
        usedModel: false,
        failureReasons
      }
    : {
        overview: block(accepted.overview, fallbackSources),
        keyTakeaways: overviewOnly
          ? []
          : accepted.keyTakeaways.map((text) => takeaway(text, fallbackSources)),
        usedModel: true,
        failureReasons
      }
  const captureDir = process.env.AUTODOC_TEST_NOTES_CAPTURE_DIR
  if (captureDir && options?.meetingId) {
    await mkdir(captureDir, { recursive: true })
    await writeFile(
      join(captureDir, `overview-${options.meetingId}.json`),
      JSON.stringify(
        {
          elapsedMs: Date.now() - startedAt,
          overviewOnly,
          usedModel: result.usedModel,
          overview: result.overview?.text ?? null,
          failureReasons
        },
        null,
        2
      )
    )
  }
  return result
}
