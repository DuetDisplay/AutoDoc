import type { MeetingInventoryEntry } from './chat-retrieval'
import type { MeetingIndexHit } from './meeting-index'
import { normalizeRecordingSearchText } from './recording-title'
import { calculateValidatedEvidence } from './ask-ai-calculations'

// Ollama's native chat template places this fixed catalog alongside the system
// message before request-specific evidence/history; never put it in a user turn.
export const ASK_AI_WRITER_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'calculate',
      description:
        'Exact arithmetic. Copy each literal from current evidence or the question, including its unit. sum/mean: all values; difference: first minus second; ratio: first/second; percentage: first/second*100; percentage_change: (new-baseline)/abs(baseline)*100; percentage_amount: amount*rate/100. Never invent an operand.',
      parameters: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: [
              'sum',
              'difference',
              'ratio',
              'percentage',
              'mean',
              'percentage_change',
              'percentage_amount'
            ]
          },
          values: {
            type: 'array',
            minItems: 2,
            maxItems: 16,
            items: { anyOf: [{ type: 'string' }, { type: 'number' }] }
          }
        },
        required: ['operation', 'values'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'count_recordings',
      description:
        'Count saved audio recordings from the full library (or attached meeting scope), not calendar events or evidence samples. Optionally list matches. Use filters copied/resolved from the request; keyword searches full notes/transcripts. State the returned filter in your answer.',
      parameters: {
        type: 'object',
        properties: {
          filter: {
            type: 'object',
            properties: {
              from: {
                type: 'string',
                description: 'Inclusive local YYYY-MM-DD recording date, or empty.'
              },
              through: {
                type: 'string',
                description: 'Inclusive local YYYY-MM-DD recording date, or empty.'
              },
              title: { type: 'string', description: 'All title terms, or empty.' },
              participant: { type: 'string', description: 'All participant terms, or empty.' },
              keyword: {
                type: 'string',
                description: 'All keyword terms in notes/transcripts, or empty.'
              },
              list: {
                type: 'boolean',
                description: 'True when titles or a list are requested; false for count only.'
              }
            },
            required: ['list'],
            additionalProperties: false
          }
        },
        required: ['filter'],
        additionalProperties: false
      }
    }
  }
] as const

export const ASK_AI_WRITER_TOOL_INSTRUCTIONS =
  'Use calculate for new arithmetic, never mental calculations. Use count_recordings for saved-recording counts/lists; passages are incomplete samples. State the count filter used, including date boundaries and keyword/title/participant criteria. A tool error is not evidence: explain or ask for clarification, never invent a result. At most one batch of tools is available; after results answer without further tool calls.'

/** AD-202: without "State the count filter used …". The app already shows the filter of a
 * real count_recordings call, and the instruction made the writer describe filters it never
 * applied. */
export const ASK_AI_WRITER_TOOL_INSTRUCTIONS_AD202 =
  'Use calculate for new arithmetic, never mental calculations. Use count_recordings for saved-recording counts/lists; passages are incomplete samples. A tool error is not evidence: explain or ask for clarification, never invent a result. At most one batch of tools is available; after results answer without further tool calls.'

export interface WriterToolCall {
  id?: string
  function: { name: string; arguments: unknown }
}
export interface WriterToolContext {
  evidence: string
  inventory: () => Promise<MeetingInventoryEntry[]>
  query: (keyword: string) => Promise<MeetingIndexHit[]>
  scopedMeetingIds?: string[]
}
function dateBoundary(value: unknown, through: boolean): number {
  if (value === undefined || value === '') return through ? Infinity : -Infinity
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw Error('Invalid recording-date filter')
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day)
    throw Error('Invalid recording-date filter')
  if (through) date.setDate(date.getDate() + 1)
  return date.getTime()
}
function termsMatch(value: string, query: string): boolean {
  const normalized = normalizeRecordingSearchText(value)
  return normalizeRecordingSearchText(query)
    .split(' ')
    .filter(Boolean)
    .every((term) => normalized.includes(term))
}
export type ValidatedWriterToolCall =
  | { tool: 'calculate'; result: Record<string, unknown> }
  | { tool: 'count_recordings'; filter: Record<string, unknown>; from: number; through: number }
/** Throws when the call is not a well-formed invocation of a declared tool. */
export function validateWriterToolCall(
  call: WriterToolCall,
  evidence: string
): ValidatedWriterToolCall {
  const args = call.function.arguments
  if (!args || typeof args !== 'object' || Array.isArray(args))
    throw Error('Tool arguments must be an object')
  const input = args as Record<string, unknown>
  if (call.function.name === 'calculate')
    return {
      tool: 'calculate',
      result: calculateValidatedEvidence(input.operation, input.values, evidence)
    }
  if (call.function.name !== 'count_recordings') throw Error('Unknown tool')
  if (!input.filter || typeof input.filter !== 'object' || Array.isArray(input.filter))
    throw Error('Supply a recording filter object')
  const filter = input.filter as Record<string, unknown>
  if (
    Object.keys(filter).some(
      (key) => !['from', 'through', 'title', 'participant', 'keyword', 'list'].includes(key)
    )
  )
    throw Error('Unknown recording filter')
  for (const key of ['from', 'through', 'title', 'participant', 'keyword'])
    if (
      filter[key] !== undefined &&
      (typeof filter[key] !== 'string' || (filter[key] as string).length > 300)
    )
      throw Error('Invalid recording filter')
  if (filter.list !== undefined && typeof filter.list !== 'boolean')
    throw Error('Invalid list option')
  const from = dateBoundary(filter.from, false),
    through = dateBoundary(filter.through, true)
  if (from >= through) throw Error('Invalid recording-date range')
  return { tool: 'count_recordings', filter, from, through }
}

const DECLARED_TOOL_NAMES: readonly string[] = ASK_AI_WRITER_TOOLS.map((tool) => tool.function.name)

// Reads a complete JSON string literal at `index`, or null when it is malformed or unterminated.
function readJsonString(text: string, index: number): { value: string; end: number } | null {
  if (text[index] !== '"') return null
  for (let i = index + 1; i < text.length; i++) {
    if (text[i] === '\\') i++
    else if (text[i] === '"') {
      try {
        return { value: JSON.parse(text.slice(index, i + 1)) as string, end: i + 1 }
      } catch {
        return null
      }
    }
  }
  return null
}

/**
 * Classifies model text that looks like a textual function call. `call` is a parseable call to a
 * declared tool (still to be validated), `named` is text that names a declared tool but cannot be
 * used, and null is anything else, which callers display unchanged.
 */
export function parseWriterToolText(
  text: string
): { kind: 'call'; call: WriterToolCall } | { kind: 'named'; name: string } | null {
  let body = text.trim()
  if (body.startsWith('<tool_call>')) body = body.slice('<tool_call>'.length).trim()
  if (body.endsWith('</tool_call>')) body = body.slice(0, -'</tool_call>'.length).trim()
  if (!body.startsWith('{')) return null
  try {
    const parsed = JSON.parse(body) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const object = parsed as Record<string, unknown>
    if (typeof object.name !== 'string' || !DECLARED_TOOL_NAMES.includes(object.name)) return null
    const args = object.parameters ?? object.arguments
    return args === undefined
      ? { kind: 'named', name: object.name }
      : { kind: 'call', call: { function: { name: object.name, arguments: args } } }
  } catch {
    // Truncated or malformed: fall back to reading just the leading "name" member.
  }
  let i = 1
  const skip = (): void => {
    while (/\s/.test(body[i] ?? '')) i++
  }
  skip()
  const key = readJsonString(body, i)
  if (key?.value !== 'name') return null
  i = key.end
  skip()
  if (body[i++] !== ':') return null
  skip()
  const value = readJsonString(body, i)
  return value && DECLARED_TOOL_NAMES.includes(value.value)
    ? { kind: 'named', name: value.value }
    : null
}

export async function executeWriterTool(
  call: WriterToolCall,
  context: WriterToolContext
): Promise<Record<string, unknown>> {
  try {
    const validated = validateWriterToolCall(call, context.evidence)
    if (validated.tool === 'calculate') return validated.result
    const { filter, from, through } = validated
    const inventory = await context.inventory()
    const keywordIds = filter.keyword
      ? new Set((await context.query(filter.keyword as string)).map((m) => m.meetingId))
      : null
    const matches = inventory
      .filter(
        (m) =>
          (!context.scopedMeetingIds?.length || context.scopedMeetingIds.includes(m.id)) &&
          m.date >= from &&
          m.date < through &&
          (!filter.title || termsMatch(m.title, filter.title as string)) &&
          (!filter.participant ||
            termsMatch(m.participants.join(' '), filter.participant as string)) &&
          (!keywordIds || keywordIds.has(m.id))
      )
      .sort((a, b) => b.date - a.date || a.id.localeCompare(b.id))
    const clauses = [
      filter.from && `on or after ${filter.from}`,
      filter.through && `on or before ${filter.through}`,
      filter.title && `with all title terms ${JSON.stringify(filter.title)}`,
      filter.participant && `with participant terms ${JSON.stringify(filter.participant)}`,
      filter.keyword &&
        `whose notes or transcript contain all keyword terms ${JSON.stringify(filter.keyword)}`
    ].filter(Boolean)
    const filterDescription = `${context.scopedMeetingIds?.length ? 'attached saved recordings' : 'all saved recordings'}${clauses.length ? ' ' + clauses.join(', ') : ' (no filters)'}`
    return {
      count: matches.length,
      filter,
      filterDescription,
      ...(filter.list
        ? {
            recordings: matches.slice(0, 10).map((m) => ({
              meetingId: m.id,
              title: m.title,
              date: `${new Date(m.date).getFullYear()}-${String(new Date(m.date).getMonth() + 1).padStart(2, '0')}-${String(new Date(m.date).getDate()).padStart(2, '0')}`
            })),
            listed: Math.min(10, matches.length),
            truncated: matches.length > 10
          }
        : {})
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Tool failed' }
  }
}
