import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { NOTES_WRITER_PROGRESS_END } from '../../shared/constants'
import type {
  MeetingSegments,
  Segment,
  SegmentCategory,
  SegmentationActivity
} from '../../shared/types'
import { logAutodocEvent } from './autodoc-log'
import { captureMessage } from './sentry-reporter'

export interface LLMProvider {
  summarize(
    meetingId: string,
    transcript: string,
    onProgress?: (percent: number) => void,
    durationMinutes?: number,
    onActivity?: (activity: SegmentationActivity | null) => void
  ): Promise<MeetingSegments>
  checkConnection(): Promise<boolean>
  abortActiveRequests?(reason?: string): void
  getModel?(): string
  setModel?(model: string): void
  setLowMemoryMode?(enabled: boolean): void
  /** Cap the writer context so the model plus KV cache fits a small-VRAM GPU. */
  setVramConstrainedContext?(enabled: boolean, profile?: 'windows-vulkan' | 'windows-cpu'): void
  releaseResources?(meetingId?: string): Promise<void>
  /** Decode speed of the most recent Ollama call, if it reported metrics. */
  getLastEvalTokPerSec?(): number | null
  /** Writer-wide decode tok/s, weighted by eval duration. Prefer this for scan policy. */
  getWriterWeightedEvalTokPerSec?(): number | null
  /** Writer chunks skipped after an irreparable parse error in the last summarize(). */
  getLastWriterSkips?(): WriterChunkSkip[]
  /** Raw completion for scan-layer restyle/compress. Must not use the notes JSON schema. */
  completePrompt?(
    prompt: string,
    options: {
      num_ctx: number
      num_predict: number
      temperature: number
      seed: number
      stop?: readonly string[]
      format?: unknown
    }
  ): Promise<string>
}

const MAX_RETRIES = 2
const WRITER_PARSE_RETRY_LIMIT = 1
const RETRY_TEMPERATURE = 0.15
const WRITER_REPEAT_PENALTY = 1.05
const WRITER_RAW_LOG_CHARS = 400
export const WRITER_PARSE_ERROR_CODE = 'NOTES_WRITER_PARSE_ERROR'
export const STANDARD_CONTEXT_TOKENS = 32768 // Request 32K context from Ollama
export const WINDOWS_CONTEXT_TOKENS = 8192
export const LOW_MEMORY_CONTEXT_TOKENS = 4096
export const MAC_CONTEXT_TOKENS = LOW_MEMORY_CONTEXT_TOKENS
const CHUNK_CHARS = 4000 // ~1K tokens per chunk — keeps output quality high with 8B models
export const WINDOWS_CHUNK_CHARS = 8000
const STREAM_TIMEOUT_MS = 120_000 // Abort if no token is received for 2 minutes
const SLOW_STREAM_ACTIVITY_DELAY_MS = 60_000
const REQUEST_TIMEOUT_MS = 1_200_000 // Last-resort runaway guard; stream inactivity is already bounded by STREAM_TIMEOUT_MS and output length by num_predict.
const MAX_OUTPUT_TOKENS = 8192 // Safety cap — model should stop naturally when JSON is complete
// Healthy chunks produce well under 1K tokens; runaway generations otherwise ramble
// to the cap at ~9 tok/s on CPU inference (4096 tokens ≈ 7.5 min stuck at 99%).
// 2048 bounds that tail while leaving generous headroom, and parseResponse already
// repairs JSON truncated by the num_predict cap.
export const WINDOWS_MAX_OUTPUT_TOKENS = 2048
/** Tight tuples stay well under this; 2048 let one chunk burn minutes on CPU. */
export const WINDOWS_TIGHT_MAX_OUTPUT_TOKENS = 768
const LOW_MEMORY_FREE_GIB_THRESHOLD = 8
const LOW_MEMORY_TOTAL_GIB_THRESHOLD = 14
const MAX_UNIQUE_TOPICS = 6
const TOPIC_MERGE_THRESHOLD = 0.52
const TOPIC_SINGLETON_MERGE_THRESHOLD = 0.28
const IS_TEST_RUNTIME = process.env.NODE_ENV === 'test' || process.env.AUTODOC_TEST_MODE === '1'

function parseDevPositiveInt(raw: string | undefined): number | undefined {
  if (raw == null || raw === '') return undefined
  if (!/^[1-9]\d*$/.test(raw.trim())) return undefined
  return Number(raw.trim())
}

/** Dev-only. Unset keeps production writer context unchanged. */
export function getDevNotesNumCtxOverride(): number | undefined {
  const value = parseDevPositiveInt(process.env.AUTODOC_TEST_NOTES_NUM_CTX)
  if (value == null || value < 2048 || value > 16384) return undefined
  return value
}

/** Dev-only. Unset keeps production 4000-char chunks. */
export function getDevNotesChunkCharsOverride(): number | undefined {
  const value = parseDevPositiveInt(process.env.AUTODOC_TEST_NOTES_CHUNK_CHARS)
  if (value == null || value < 1000 || value > 20000) return undefined
  return value
}

/** Line-pack transcript chunks. Optionally fold a short leftover into the previous call. */
export function packTranscriptChunks(
  transcript: string,
  chunkChars: number,
  absorbShortTail = false
): string[] {
  if (transcript.length <= chunkChars) return [transcript]

  const lines = transcript.split('\n')
  const chunks: string[] = []
  let current = ''

  for (const line of lines) {
    if (current.length + line.length + 1 > chunkChars && current.length > 0) {
      chunks.push(current)
      current = ''
    }
    current += current ? `\n${line}` : line
  }
  if (current) chunks.push(current)

  if (absorbShortTail && chunks.length >= 2) {
    const last = chunks[chunks.length - 1]
    if (last.length < Math.floor(chunkChars / 2)) {
      chunks[chunks.length - 2] += `\n${last}`
      chunks.pop()
    }
  }

  return chunks
}

export interface NotesWriterTranscriptRow {
  startMs: number
  speaker?: string | null
  text: string
}

export function formatNotesWriterTimestamp(startMs: number): string {
  const totalSec = Math.floor(Math.max(0, startMs) / 1000)
  const hours = Math.floor(totalSec / 3600)
  const minutes = Math.floor((totalSec % 3600) / 60)
  const seconds = totalSec % 60
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

/** Kept for tests. Speaker-omit densified chunks and dropped 4.3.5; do not enable. */
export function shouldOmitWindowsTightSpeakerLabels(
  _platform: NodeJS.Platform = process.platform
): boolean {
  return false
}

const WRITER_BACKCHANNEL_ONLY =
  /^(yeah|yep|yup|ok|okay|um+|uh+|mhm+|mm-?hm|hmm+|right|sure|thanks|thank you|got it|gotcha|alright|yes|no)[.!?,]*$/i
const WRITER_SPOKEN_QUANTITY =
  /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|hundred)\b/i

export function isNotesWriterBackchannelOnly(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return true
  if (/\d/.test(trimmed)) return false
  if (WRITER_SPOKEN_QUANTITY.test(trimmed)) return false
  return WRITER_BACKCHANNEL_ONLY.test(trimmed)
}

/** Windows tight ack-strip. Off after v12: fixture saved 21s, meeting 2 lost 1.4 min to 768 runaways. */
export function shouldStripWindowsTightBackchannel(
  _platform: NodeJS.Platform = process.platform
): boolean {
  return false
}

export function formatNotesWriterTranscript(
  rows: readonly NotesWriterTranscriptRow[],
  omitSpeaker = shouldOmitWindowsTightSpeakerLabels()
): string {
  const stripBackchannel = shouldStripWindowsTightBackchannel()
  return rows
    .filter((row) => !stripBackchannel || !isNotesWriterBackchannelOnly(row.text ?? ''))
    .map((row) => {
      const timestamp = formatNotesWriterTimestamp(row.startMs)
      const text = row.text ?? ''
      const speaker = row.speaker?.trim()
      if (!omitSpeaker && speaker) {
        return `[${timestamp}] [${speaker}] ${text}`
      }
      return `[${timestamp}] ${text}`
    })
    .join('\n')
}

function isNotesEvalInstrumentationEnabled(): boolean {
  return (
    process.env.AUTODOC_TEST_NOTES_CPU === '1' ||
    getDevNotesNumCtxOverride() != null ||
    process.env.AUTODOC_TEST_RETRY_NOTES_MEETING_ID != null ||
    isCompactWriterEnabled()
  )
}

/** Dev-only. Short-key writer JSON. Unset keeps production wire format. */
export function isCompactWriterEnabled(): boolean {
  return process.env.AUTODOC_TEST_NOTES_COMPACT === '1'
}

/** Windows notes writer (tight v7 + v14). macOS stays on the shared V2 prompt. */
export function isTightWriterEnabled(
  platform: NodeJS.Platform = process.platform
): boolean {
  if (process.env.AUTODOC_TEST_NOTES_TIGHT === '0') return false
  return platform === 'win32'
}

/** Dev-only. Override the notes model after the processing profile picks one. */
export function getDevNotesModelOverride(): string | undefined {
  const value = process.env.AUTODOC_TEST_NOTES_MODEL?.trim()
  return value ? value : undefined
}

/** Dev-only. Unset leaves Ollama's default num_batch. */
export function getDevNotesNumBatchOverride(): number | undefined {
  const value = parseDevPositiveInt(process.env.AUTODOC_TEST_NOTES_NUM_BATCH)
  if (value == null || value < 8 || value > 2048) return undefined
  return value
}

/** Dev-only. Unset leaves production thread policy (no num_thread). */
export function getDevNotesNumThreadOverride(): number | undefined {
  const value = parseDevPositiveInt(process.env.AUTODOC_TEST_NOTES_NUM_THREAD)
  if (value == null || value < 1 || value > 64) return undefined
  return value
}

/** Dev-only. After the first writer chunk, send a short continuation system prompt. */
export function isShortWriterPromptEnabled(): boolean {
  return process.env.AUTODOC_TEST_NOTES_SHORT_PROMPT === '1'
}

/** Dev-only. Skip scan restyle + compress entirely. */
export function isDevNotesSkipScanRewritesEnabled(): boolean {
  return process.env.AUTODOC_TEST_NOTES_SKIP_SCAN_REWRITES === '1'
}

/** Windows tight path: preserve/append already keep quantities, so skip restyle+compress. */
export function shouldSkipWindowsTightScanRewrites(
  platform: NodeJS.Platform = process.platform
): boolean {
  return isTightWriterEnabled(platform)
}

/** Windows tight JSON-grammar omit. Off after v18: chunk 1 emitted unparseable JSON and was skipped. */
export function shouldOmitWindowsTightResponseFormat(
  _platform: NodeJS.Platform = process.platform
): boolean {
  return false
}

/** Windows tight short-tail absorb. Off after v19: 10 chunks, but chunk 1 hit 768 and last window 100s. */
export function shouldAbsorbWindowsTightShortTail(
  _platform: NodeJS.Platform = process.platform
): boolean {
  return false
}

export function writerProgressPercent(
  chunkIndex: number,
  chunkFraction: number,
  chunkCount: number
): number {
  if (chunkCount <= 0) return 0
  const fraction = Math.min(1, Math.max(0, (chunkIndex + chunkFraction) / chunkCount))
  return Math.min(NOTES_WRITER_PROGRESS_END, Math.round(fraction * NOTES_WRITER_PROGRESS_END))
}
const NOTES_RESPONSE_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    topic: { type: 'string' },
    title: { type: 'string' },
    content: { type: 'string' },
    // Optional: Windows Ollama structured outputs grammar-forbid any key not listed
    // here (additionalProperties: false). parseResponse already reads both fields.
    assignee: { type: 'string' },
    deadline: { type: 'string' },
    sourceStartMs: { type: 'number' },
    sourceEndMs: { type: 'number' }
  },
  required: ['topic', 'title', 'content', 'sourceStartMs', 'sourceEndMs']
} as const

const NOTES_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    decisions: { type: 'array', items: NOTES_RESPONSE_ITEM_SCHEMA },
    action_items: { type: 'array', items: NOTES_RESPONSE_ITEM_SCHEMA },
    information: { type: 'array', items: NOTES_RESPONSE_ITEM_SCHEMA },
    discussion: { type: 'array', items: NOTES_RESPONSE_ITEM_SCHEMA },
    status_updates: { type: 'array', items: NOTES_RESPONSE_ITEM_SCHEMA }
  },
  required: ['decisions', 'action_items', 'information', 'discussion', 'status_updates']
} as const
const TOPIC_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'current',
  'discussion',
  'for',
  'from',
  'how',
  'in',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'reported',
  'review',
  'shared',
  'status',
  'team',
  'that',
  'the',
  'their',
  'them',
  'there',
  'these',
  'this',
  'to',
  'update',
  'updates',
  'was',
  'were',
  'what',
  'with'
])

const SPOKEN_COMPOUND_QUANTITIES: Record<string, string> = {
  'twenty[\\s-]+one': '21',
  'twenty[\\s-]+two': '22',
  'twenty[\\s-]+three': '23',
  'twenty[\\s-]+four': '24',
  'twenty[\\s-]+five': '25',
  'twenty[\\s-]+six': '26',
  'twenty[\\s-]+seven': '27',
  'twenty[\\s-]+eight': '28',
  'twenty[\\s-]+nine': '29'
}

const SPOKEN_QUANTITY_WORDS: Record<string, string> = {
  zero: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  ten: '10',
  eleven: '11',
  twelve: '12',
  thirteen: '13',
  fourteen: '14',
  fifteen: '15',
  sixteen: '16',
  seventeen: '17',
  eighteen: '18',
  nineteen: '19',
  twenty: '20',
  thirty: '30',
  forty: '40',
  fifty: '50',
  sixty: '60',
  hundred: '100'
}

const NOTES_WRITER_SHORT_CONTINUATION = `Continue extracting notes from this next transcript section. Use the same JSON schema and timestamp rules as the first chunk. Timestamps are milliseconds: [00:22]=22000, [17:41]=1061000. At most 6 new items. Empty arrays for weak or repeated content.`

const NOTES_WRITER_SHORT_CONTINUATION_COMPACT = `Continue extracting notes from this next transcript section. Same compact JSON keys (d/a/i/x/u, t/h/c/o/l/s/e). s and e are milliseconds: [00:22]=22000, [17:41]=1061000. Never write 1741 or 17410000. At most 6 new items. Empty arrays for weak or repeated content.`

const NOTES_WRITER_TIMESTAMPS = `TIMESTAMPS — The transcript includes timestamps like [00:12] or [01:05:30] at the start of each line. For EVERY item, you MUST set "sourceStartMs" and "sourceEndMs" to the timestamps in milliseconds from the transcript lines the item is based on. Convert: [00:22] = 22000, [02:30] = 150000, [17:41] = 1061000, [01:05:30] = 3930000. Use the timestamp of the first relevant line for sourceStartMs and the last relevant line for sourceEndMs. Every item must have non-zero timestamps.`

const NOTES_WRITER_COMPACT_TIMESTAMPS = `TIMESTAMPS — The transcript includes timestamps like [00:12] or [01:05:30] at the start of each line. s and e are those same times in milliseconds. Convert: [00:22] = 22000, [02:30] = 150000, [17:41] = 1061000, [01:05:30] = 3930000. Never write 1741, 17410000, or 17:41 as 17410000. Use the first relevant line for s and the last for e. Every item must have non-zero s and e.`

const SYSTEM_PROMPT = `You are a thorough meeting notes assistant. Your job is to capture everything of value from the transcript. People rely on these notes to remember what happened.

FILTERING — Skip content that is NOT part of the actual meeting:
- Background audio, music, videos playing before/after the meeting
- Casual greetings, small talk, "can you hear me?", technical setup chatter
- Filler conversation while waiting for people to join
- Content clearly from a different source (e.g. a YouTube video, podcast, or news broadcast playing in the background)
- Isolated outro boilerplate or subtitle artifacts like "thank you" or "Subtitles by the Amara.org community"
- Any text that could plausibly be caused by silence, noise, or transcription error rather than a real meeting statement
Only extract notes from the actual substantive meeting discussion.

GROUNDING — This is critical:
- NEVER invent facts, decisions, prices, metrics, deadlines, or action items.
- NEVER infer a decision or commitment unless the transcript explicitly supports it.
- If a number, percentage, dollar amount, date, or proper noun is not present in the transcript, do not include it.
- If the transcript is empty, silent, low-signal, ambiguous, or mostly boilerplate, return empty arrays for every category.
- When evidence is weak, omit the item. Missing a note is better than hallucinating one.

Extract and categorize into these 5 categories:

1. **decisions** — Any decision made, even small ones. Include who decided and the reasoning.
2. **action_items** — Every task, follow-up, or commitment mentioned. Include who owns it and any deadline.
3. **information** — Facts, numbers, data, updates, context shared. Capture specific details (names, figures, dates, URLs).
4. **discussion** — Debates, disagreements, open questions, alternatives considered, pros/cons discussed.
5. **status_updates** — Progress reports, blockers, what's done, what's in progress, what's next.

Guidelines:
- Extract every distinct point — aim for roughly 1 item per minute of meeting across all categories.
- Write CONCISE, CLEAR SUMMARIES — never paste raw quotes from the transcript. Synthesize what was said into polished notes that someone can scan quickly.
- Keep each "content" field to 1-2 sentences. Be brief and direct — capture the key point, not every detail.
- The "content" field should read like a well-written meeting note, not a transcript excerpt. Remove filler words (um, like, you know), false starts, and conversational artifacts.
- ACCURACY: Preserve exact numbers, dates, dollar amounts, percentages, and proper nouns. Do NOT paraphrase quantities — if someone says "$50 per year", write "$50 per year", not "$50 per month".
- Each item should capture the full context so someone who wasn't in the meeting understands it.
- If someone says "I'll do X by Friday", that's an action item with an assignee and deadline.
- When in doubt about which category, include it in the most relevant one.
- Always use proper sentence capitalization for titles and content.

GROUPING — This is critical. Every item MUST have a "topic" field that acts as a CHAPTER HEADING for the meeting. Topics must be VERY broad — think of them as the 3-5 major subjects the meeting covered, like an agenda or table of contents.

STRICT RULES:
- A meeting should have AT MOST 3-6 unique topics total across ALL categories.
- Each topic should group 3-10+ items under it.
- If a topic only has 1-2 items, it is TOO SPECIFIC — merge it into a broader topic.
- Items about the same general area MUST share the EXACT same topic string.

HOW TO PICK TOPICS: Before writing items, name the 3-5 subjects this meeting actually covered — the same way someone would title agenda sections. Invent the names from the transcript. Never reuse a canned taxonomy (do not write "Technical Architecture", "Technical Changes", "Pricing & Costs", "Release Planning", or "Project Planning" unless those words are the real subject).

GOOD topics (named from the conversation):
- "Windows Tickets" — groups USB/IT exceptions, RDP errors, and keyboard-layout bugs from the same support pass
- "Feature Flag Audit" — groups a LaunchDarkly replacement, reverted flags, and blast radius
- "Relay Monitoring" — groups uptime, dashboards, and weekend alerts

BAD topics:
- Fixed department labels that could apply to any meeting: "Technical Architecture", "Pricing & Costs", "Project Planning"
- One heading per item: "Image Pricing", "Image Creation", "Chrome Browser" — merge those under the real subject, e.g. "Device Imaging"

${NOTES_WRITER_TIMESTAMPS}

Respond with ONLY valid JSON (no markdown, no explanation):
{
  "decisions": [{ "topic": "broad theme", "title": "clear summary", "content": "concise explanation of what was decided and why", "assignee": null, "deadline": null, "sourceStartMs": 12000, "sourceEndMs": 45000 }],
  "action_items": [{ "topic": "broad theme", "title": "specific task", "content": "what needs to happen, who owns it, and by when", "assignee": "person or null", "deadline": "deadline or null", "sourceStartMs": 12000, "sourceEndMs": 45000 }],
  "information": [{ "topic": "broad theme", "title": "what was shared", "content": "synthesized summary with key details and numbers", "assignee": null, "deadline": null, "sourceStartMs": 12000, "sourceEndMs": 45000 }],
  "discussion": [{ "topic": "broad theme", "title": "topic debated", "content": "summary of positions, arguments, and outcome if any", "assignee": null, "deadline": null, "sourceStartMs": 12000, "sourceEndMs": 45000 }],
  "status_updates": [{ "topic": "broad theme", "title": "what was reported", "content": "current state, blockers, and next steps", "assignee": null, "deadline": null, "sourceStartMs": 12000, "sourceEndMs": 45000 }]
}

If a category has no items, use an empty array. Every item MUST have topic, title, and content fields.`

const NOTES_WRITER_JSON_CONTRACT = `Respond with ONLY valid JSON (no markdown, no explanation):
{
  "decisions": [{ "topic": "broad theme", "title": "clear summary", "content": "concise explanation of what was decided and why", "assignee": null, "deadline": null, "sourceStartMs": 12000, "sourceEndMs": 45000 }],
  "action_items": [{ "topic": "broad theme", "title": "specific task", "content": "what needs to happen, who owns it, and by when", "assignee": "person or null", "deadline": "deadline or null", "sourceStartMs": 12000, "sourceEndMs": 45000 }],
  "information": [{ "topic": "broad theme", "title": "what was shared", "content": "synthesized summary with key details and numbers", "assignee": null, "deadline": null, "sourceStartMs": 12000, "sourceEndMs": 45000 }],
  "discussion": [{ "topic": "broad theme", "title": "topic debated", "content": "summary of positions, arguments, and outcome if any", "assignee": null, "deadline": null, "sourceStartMs": 12000, "sourceEndMs": 45000 }],
  "status_updates": [{ "topic": "broad theme", "title": "what was reported", "content": "current state, blockers, and next steps", "assignee": null, "deadline": null, "sourceStartMs": 12000, "sourceEndMs": 45000 }]
}

If a category has no items, use an empty array. Every item MUST have topic, title, and content fields.`

const NOTES_WRITER_COMPACT_JSON_CONTRACT = `Respond with ONLY valid JSON. Use short keys. Omit null or empty fields.
Categories: d=decisions a=action_items i=information x=discussion u=status_updates
Item keys: t=topic h=title c=content o=assignee l=deadline s=sourceStartMs e=sourceEndMs
s and e are milliseconds: [00:22]=22000 [02:30]=150000 [17:41]=1061000. Do not write clock digits like 1741 or 17410000.
{
  "d": [{"t":"theme","h":"summary","c":"concise explanation of what was decided and why","s":12000,"e":45000}],
  "a": [{"t":"theme","h":"task","c":"what needs to happen, who owns it, and by when","o":"name","l":"Friday","s":150000,"e":175000}],
  "i": [{"t":"theme","h":"what was shared","c":"synthesized summary with key details and numbers","s":22000,"e":28000}],
  "x": [{"t":"theme","h":"topic debated","c":"summary of positions, arguments, and outcome if any","s":1061000,"e":1086000}],
  "u": [{"t":"theme","h":"what was reported","c":"current state, blockers, and next steps","s":55000,"e":64000}]
}
Every item needs t, h, c, s, e. Keep the same prose quality and facts; only the JSON keys change. If a category has no items, use an empty array.`

const SYSTEM_PROMPT_TIGHT = `You extract meeting notes as compact JSON tuples. Invent nothing. Skip greetings, setup chatter, background audio, and filler.

Categories: d=decisions a=action_items i=information x=discussion u=status_updates
Each item is [title, content, s, e] or [title, content, s, e, owner, deadline].
s and e are milliseconds from THIS section's transcript clocks: [00:22]=22000, [02:30]=150000, [17:41]=1061000. Never write 1741 or 17410000.

Each category key appears once, with a colon. Omit empty categories. At most 6 items.

Rules:
- Content is one sentence. Keep exact numbers, names, versions, and dates.
- One fact in one category. Do not clone the same point into d, i, and x.
- Titles must be specific. Never use "task", "what was shared", "topic debated", or "what was reported".

{"i":[["specific title","One sentence from this section.",s,e]],"a":[["specific task","One sentence saying who does what.",s,e,"Name"]]}`

const TIGHT_NOTES_PROMPT_SUFFIX = `
- Target roughly 40-55 total final items for a normal-length product huddle.
- Prefer one strong item over overlapping decision, information, and discussion about the same point.
- Copy product names, versions, and domain words exactly as spoken.
- Keep decisions selective; over-reporting decisions is worse than omitting weak ones.`

const COMPACT_CATEGORY_KEYS: Record<string, string> = {
  d: 'decisions',
  decisions: 'decisions',
  a: 'action_items',
  action_items: 'action_items',
  i: 'information',
  information: 'information',
  x: 'discussion',
  discussion: 'discussion',
  u: 'status_updates',
  status_updates: 'status_updates'
}

export type WriterDropReason =
  | 'unknown_category'
  | 'category_not_array'
  | 'unexpandable_item'
  | 'missing_title'
  | 'missing_content'
  | 'duplicate_title'
  | 'ungrounded'

export interface WriterDrop {
  reason: WriterDropReason
  category?: string
  detail?: string
}

export interface WriterExpandResult {
  expanded: Record<string, RawSegment[]>
  rawItemCount: number
  expandedItemCount: number
  drops: WriterDrop[]
}

export function computeWriterWeightedEvalTokPerSec(
  samples: ReadonlyArray<{ evalCount?: number; evalDurationMs?: number }>
): number | null {
  let tokens = 0
  let durationMs = 0
  for (const sample of samples) {
    if (sample.evalCount == null || sample.evalDurationMs == null || sample.evalDurationMs <= 0) {
      continue
    }
    tokens += sample.evalCount
    durationMs += sample.evalDurationMs
  }
  if (durationMs <= 0) return null
  return Math.round((tokens / durationMs) * 1000 * 10) / 10
}

function decodeClockDigitsToMs(digits: number): number | null {
  if (!Number.isInteger(digits) || digits < 0) return null
  if (digits < 60) return digits * 1000
  if (digits <= 5959) {
    const minutes = Math.floor(digits / 100)
    const seconds = digits % 100
    if (seconds >= 60) return null
    return (minutes * 60 + seconds) * 1000
  }
  if (digits <= 235959) {
    const hours = Math.floor(digits / 10000)
    const minutes = Math.floor(digits / 100) % 100
    const seconds = digits % 100
    if (minutes >= 60 || seconds >= 60) return null
    return (hours * 3600 + minutes * 60 + seconds) * 1000
  }
  return null
}

function coerceWriterTimestampValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
      const parsed = Number(trimmed)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return undefined
}

/** Clock reading hidden in trailing zeros, e.g. 17:41 → 1741000 or 141500 → 14:15. */
export function alternateClockTimestampMs(value: unknown, durationMs?: number): number | null {
  const coerced = coerceWriterTimestampValue(value)
  const raw = coerced != null ? Math.round(coerced) : 0
  if (raw <= 0) return null
  const maxMs = durationMs != null && durationMs > 0 ? durationMs : Number.POSITIVE_INFINITY
  let stripped = raw
  while (stripped >= 10 && stripped % 10 === 0) {
    stripped = Math.round(stripped / 10)
    const decoded = decodeClockDigitsToMs(stripped)
    if (decoded != null && decoded > 0 && decoded <= maxMs && decoded !== raw) {
      return decoded
    }
  }
  return null
}

const PROSE_CLOCK_RE = /\[?(\d{1,2}):(\d{2})(?::(\d{2}))?\]?/g

/** Pull [mm:ss] / mm:ss clocks out of tight-writer prose when s/e were omitted. */
export function extractProseClockMs(text: string): number[] {
  const clocks: number[] = []
  for (const match of text.matchAll(PROSE_CLOCK_RE)) {
    const first = Number(match[1])
    const second = Number(match[2])
    const third = match[3] != null ? Number(match[3]) : null
    if (third != null) {
      if (second >= 60 || third >= 60) continue
      clocks.push((first * 3600 + second * 60 + third) * 1000)
      continue
    }
    if (second >= 60) continue
    clocks.push((first * 60 + second) * 1000)
  }
  return clocks
}

/** Rewrite compact writer timestamps that overflow the meeting, e.g. 17:41 → 17410000. */
export function salvageWriterTimestampMs(value: unknown, durationMs?: number): number {
  const coerced = coerceWriterTimestampValue(value)
  const raw = coerced != null ? Math.round(coerced) : 0
  if (raw <= 0) return 0
  const maxMs = durationMs != null && durationMs > 0 ? durationMs : Number.POSITIVE_INFINITY
  if (raw <= maxMs) return raw

  const clockHits = new Set<number>()
  let stripped = raw
  while (stripped >= 10 && stripped % 10 === 0) {
    stripped = Math.round(stripped / 10)
    const decoded = decodeClockDigitsToMs(stripped)
    if (decoded != null && decoded <= maxMs) clockHits.add(decoded)
  }
  if (clockHits.size > 0) return Math.max(...clockHits)

  let scaled = raw
  while (scaled > maxMs && scaled >= 10) {
    scaled = Math.round(scaled / 10)
  }
  if (scaled <= maxMs) return scaled
  return maxMs === Number.POSITIVE_INFINITY ? raw : maxMs
}

const WRITER_CATEGORY_JSON_KEYS = [
  'd',
  'a',
  'i',
  'x',
  'u',
  'decisions',
  'action_items',
  'information',
  'discussion',
  'status_updates'
] as const

function matchJsonBracket(raw: string, openIdx: number): number {
  let depth = 0
  let inString = false
  let escape = false
  for (let i = openIdx; i < raw.length; i++) {
    const ch = raw[i]
    if (inString) {
      if (escape) {
        escape = false
        continue
      }
      if (ch === '\\') {
        escape = true
        continue
      }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '[') depth += 1
    else if (ch === ']') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/** Count finished tight tuples in a possibly truncated writer payload. */
export function countCompleteTightWriterItems(raw: string): number {
  let count = 0
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '[') continue
    const end = matchJsonBracket(raw, i)
    if (end < 0) continue
    try {
      const parsed = JSON.parse(raw.slice(i, end + 1)) as unknown
      if (
        Array.isArray(parsed) &&
        parsed.length >= 2 &&
        typeof parsed[0] === 'string' &&
        typeof parsed[1] === 'string'
      ) {
        count += 1
        i = end
      }
    } catch {
      // Keep scanning; later tuples may still be complete.
    }
  }
  return count
}

const WINDOWS_TIGHT_STREAM_ITEM_CAP = 6

/** Win32 tight: stop decode once the 6-item cap is already on the wire. */
export function shouldStopWindowsTightWriterStream(
  raw: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  return (
    isTightWriterEnabled(platform) &&
    countCompleteTightWriterItems(raw) >= WINDOWS_TIGHT_STREAM_ITEM_CAP
  )
}

/** Merge duplicate category keys and tolerate a missing colon after d/a/i/x/u. */
export function extractWriterCategoryObject(raw: string): Record<string, unknown> | null {
  const merged: Record<string, unknown[]> = {}
  let found = false
  for (const key of WRITER_CATEGORY_JSON_KEYS) {
    const needle = `"${key}"`
    let searchFrom = 0
    while (searchFrom < raw.length) {
      const keyIdx = raw.indexOf(needle, searchFrom)
      if (keyIdx < 0) break
      const afterKey = keyIdx + needle.length
      // Avoid matching `"d"` inside a longer quoted word; the next char must be
      // whitespace, colon, or comma.
      const boundary = raw[afterKey]
      if (boundary && /[A-Za-z0-9_]/.test(boundary)) {
        searchFrom = afterKey
        continue
      }
      let i = afterKey
      while (i < raw.length && /\s/.test(raw[i])) i += 1
      if (raw[i] === ':' || raw[i] === ',') {
        i += 1
        while (i < raw.length && /\s/.test(raw[i])) i += 1
      }
      if (raw[i] !== '[') {
        searchFrom = afterKey
        continue
      }
      const end = matchJsonBracket(raw, i)
      if (end < 0) break
      try {
        const parsed = JSON.parse(raw.slice(i, end + 1))
        if (Array.isArray(parsed)) {
          found = true
          merged[key] = [...(merged[key] ?? []), ...parsed]
        }
      } catch {
        // Skip this occurrence; later keys may still parse.
      }
      searchFrom = end + 1
    }
  }
  return found ? merged : null
}

export function parseWriterJsonRecord(raw: string): Record<string, unknown> | null {
  const extracted = extractWriterCategoryObject(raw)
  const extractedHasItems =
    extracted != null &&
    Object.values(extracted).some((value) => Array.isArray(value) && value.length > 0)
  if (extractedHasItems) return extracted
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function flattenWriterItem(item: unknown): unknown {
  if (!Array.isArray(item)) return item
  if (item.length === 1 && Array.isArray(item[0])) return flattenWriterItem(item[0])
  return item
}

export function inspectCompactWriterPayload(
  parsed: Record<string, unknown>
): WriterExpandResult {
  const expanded: Record<string, RawSegment[]> = {}
  const drops: WriterDrop[] = []
  let rawItemCount = 0
  let expandedItemCount = 0
  for (const [rawKey, value] of Object.entries(parsed)) {
    const dest = COMPACT_CATEGORY_KEYS[rawKey]
    if (!dest) {
      drops.push({ reason: 'unknown_category', detail: rawKey })
      continue
    }
    if (!Array.isArray(value)) {
      drops.push({ reason: 'category_not_array', category: dest, detail: rawKey })
      continue
    }
    rawItemCount += value.length
    const items: RawSegment[] = []
    const queue = [...value]
    while (queue.length > 0) {
      const next = queue.shift()
      if (typeof next === 'number') continue
      let item: unknown = flattenWriterItem(next)
      if (
        Array.isArray(item) &&
        item.length === 2 &&
        typeof queue[0] === 'number' &&
        typeof queue[1] === 'number'
      ) {
        item = [...item, queue.shift(), queue.shift()]
      }
      const expandedItem = expandCompactWriterItem(item)
      if (expandedItem == null) {
        drops.push({ reason: 'unexpandable_item', category: dest })
        continue
      }
      items.push(expandedItem)
      expandedItemCount += 1
    }
    expanded[dest] = [...(expanded[dest] ?? []), ...items]
  }
  return { expanded, rawItemCount, expandedItemCount, drops }
}

export function expandCompactWriterPayload(
  parsed: Record<string, unknown>
): Record<string, RawSegment[]> {
  return inspectCompactWriterPayload(parsed).expanded
}

function expandCompactWriterItem(item: unknown): RawSegment | null {
  if (Array.isArray(item)) {
    if (item.length < 2) return null
    if (
      item.length === 2 &&
      typeof item[0] === 'string' &&
      item[0].trim() !== '' &&
      typeof item[1] === 'string' &&
      item[1].trim() !== ''
    ) {
      return {
        title: item[0],
        content: item[1]
      }
    }
    if (item.length < 3) return null
    if (
      item.length === 3 &&
      typeof item[0] === 'string' &&
      typeof item[1] === 'string' &&
      coerceWriterTimestampValue(item[2]) != null
    ) {
      const stamp = coerceWriterTimestampValue(item[2])
      return {
        title: item[0],
        content: item[1],
        sourceStartMs: stamp,
        sourceEndMs: stamp
      }
    }
    // Tight tuples put timestamps in slots 2/3: [title, content, s, e, owner?, deadline?]
    const tightStart = coerceWriterTimestampValue(item[2])
    const tightEnd = coerceWriterTimestampValue(item[3])
    if (item.length >= 4 && tightStart != null && tightEnd != null) {
      return {
        title: item[0] == null ? undefined : String(item[0]),
        content: item[1] == null ? undefined : String(item[1]),
        sourceStartMs: tightStart,
        sourceEndMs: tightEnd,
        assignee: item[4] == null || item[4] === '' ? null : String(item[4]),
        deadline: item[5] == null || item[5] === '' ? null : String(item[5])
      }
    }
    return {
      topic: item[0] == null ? undefined : String(item[0]),
      title: item[1] == null ? undefined : String(item[1]),
      content: item[2] == null ? undefined : String(item[2]),
      assignee: item[3] == null ? null : String(item[3]),
      deadline: item[4] == null ? null : String(item[4]),
      sourceStartMs: coerceWriterTimestampValue(item[5]),
      sourceEndMs: coerceWriterTimestampValue(item[6])
    }
  }
  if (item == null || typeof item !== 'object') return null
  const row = item as Record<string, unknown>
  return {
    topic: pickCompactString(row, 'topic', 't'),
    title: pickCompactString(row, 'title', 'h'),
    content: pickCompactString(row, 'content', 'c'),
    assignee: pickCompactString(row, 'assignee', 'o'),
    deadline: pickCompactString(row, 'deadline', 'l'),
    sourceStartMs: pickCompactNumber(row, 'sourceStartMs', 's'),
    sourceEndMs: pickCompactNumber(row, 'sourceEndMs', 'e')
  }
}

function pickCompactString(
  row: Record<string, unknown>,
  longKey: string,
  shortKey: string
): string | undefined {
  const value = row[longKey] ?? row[shortKey]
  if (value == null || value === '') return undefined
  return String(value)
}

function pickCompactNumber(
  row: Record<string, unknown>,
  longKey: string,
  shortKey: string
): number | undefined {
  const value = row[longKey] ?? row[shortKey]
  return coerceWriterTimestampValue(value)
}

const MAC_NOTES_PROMPT_SUFFIX = `

MAC QUALITY TUNING OVERRIDE:
- Match the baseline AutoDoc note style: useful, complete, and scan-friendly, but not exhaustive.
- Target roughly 40-55 total final items for a normal-length product or engineering huddle.
- A topic is a broad chapter heading for the meeting, not a restatement of one item title.
- Reuse broad topic labels across chunks and categories whenever they fit.
- Do not create a new topic for a single feature, status update, person update, bug, customer complaint, or implementation detail unless it is truly a major new subject.
- Avoid near-duplicate topic labels. For example, do not split release-related notes across both "Release Timing" and "Release Plan".
- Topic names must come from this meeting's material. Do not map items onto a fixed list of department headings.
- Decisions require an explicit choice, approval, rejection, or agreed direction. Do not classify general discussion, concern, or preference as a decision.
- Action items require a clear next step, owner, request, or follow-up. Do not turn vague possibilities into tasks.
- Copy product names, feature names, and domain words exactly as spoken in the transcript; never substitute a similar-sounding word (the transcript word is correct even if unusual).
- Prefer one strong item over separate overlapping decision, information, and discussion items about the same underlying point.
- If a point is already captured as a decision, only add context as information when it includes a distinct durable fact someone would search for later.
- Keep the "decisions" category especially selective; over-reporting decisions is worse than omitting weak ones.
- Prefer empty arrays over weak, repeated, speculative, or low-signal notes.`

interface RawSegment {
  topic?: string
  title?: string
  content?: string
  assignee?: string | null
  deadline?: string | null
  sourceStartMs?: number
  sourceEndMs?: number
}

interface TranscriptLine {
  startMs: number
  text: string
}

interface SourceRange {
  startMs: number
  endMs: number
}

interface TopicGroup {
  segments: Segment[]
  labelCounts: Map<string, number>
}

type OllamaContextProfile =
  | 'standard'
  | 'windows-balanced'
  | 'mac-balanced'
  | 'low-memory'
  | 'windows-vulkan'
  | 'windows-cpu'

export function isTransientOllamaRuntimeError(message: string): boolean {
  return (
    message.includes('fetch failed') ||
    message.includes('This operation was aborted') ||
    message.includes('aborted due to timeout') ||
    message === 'The operation was aborted' ||
    message.includes('llama-server process has terminated') ||
    message.includes('model runner has unexpectedly stopped') ||
    message.includes('0xe06d7363')
  )
}

export interface WriterChunkSkip {
  chunkIndex: number
  attempts: number
  rawHead: string
  rawTail: string
}

export function sliceWriterRawEnds(raw: string): { rawHead: string; rawTail: string } {
  return {
    rawHead: raw.slice(0, WRITER_RAW_LOG_CHARS),
    rawTail: raw.slice(-WRITER_RAW_LOG_CHARS)
  }
}

export class WriterParseError extends Error {
  readonly code = WRITER_PARSE_ERROR_CODE
  readonly rawHead: string
  readonly rawTail: string

  constructor(raw: string) {
    const ends = sliceWriterRawEnds(raw)
    super('Invalid JSON from Ollama')
    this.name = 'WriterParseError'
    this.rawHead = ends.rawHead
    this.rawTail = ends.rawTail
  }
}

export function isWriterParseError(error: unknown): error is WriterParseError {
  if (error instanceof WriterParseError) return true
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === WRITER_PARSE_ERROR_CODE
  )
}

export interface OllamaCallMetrics {
  totalDurationMs?: number
  loadDurationMs?: number
  promptEvalCount?: number
  promptEvalDurationMs?: number
  evalCount?: number
  evalDurationMs?: number
  evalTokPerSec?: number
  doneReason?: string
}

export interface OllamaBenchmarkOptions {
  numGpu?: number
  numThread?: number
  onCallComplete?: (metrics: OllamaCallMetrics) => void | Promise<void>
}

export type OllamaProviderTelemetryEventName =
  | 'ollama_low_memory_fallback_triggered'
  | 'ollama_low_memory_fallback_succeeded'
  | 'ollama_low_memory_fallback_failed'

export interface OllamaProviderTelemetryEvent {
  meetingId: string
  event: OllamaProviderTelemetryEventName
  properties: Record<string, unknown>
}

interface OllamaProviderOptions {
  onTelemetry?: (event: OllamaProviderTelemetryEvent) => void
  /**
   * Called before each Ollama request so the runner can be recycled when its
   * memory growth has degraded decode speed (fresh runner respawns on the next
   * request). Must be cheap and must never throw.
   */
  maybeRecycleRunner?: (meetingId?: string) => void | Promise<void>
  recoverRuntimeOnce?: () => Promise<void>
  /** Dev/eval only. Must never throw. Used to record runner PID/RSS per writer call. */
  snapshotRunners?: () => Array<{ pid: number; rssMiB: number | null; numCtx: number | null }>
}

const LOW_SIGNAL_NOTE_PATTERNS = [
  /\bsubtitles by (the )?amara\.org community\b/i,
  /\bamara\.org community\b/i,
  /\bthank you\b/i
]

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

const CATEGORY_MAP: Record<string, SegmentCategory> = {
  decisions: 'decision',
  action_items: 'action_item',
  information: 'information',
  discussion: 'discussion',
  status_updates: 'status_update'
}

export class OllamaProvider implements LLMProvider {
  private baseUrl: string
  private model: string
  private activeControllers = new Set<AbortController>()
  private contextProfile: OllamaContextProfile = 'standard'
  private contextTokens = STANDARD_CONTEXT_TOKENS
  private onTelemetry?: (event: OllamaProviderTelemetryEvent) => void
  private maybeRecycleRunner?: (meetingId?: string) => void | Promise<void>
  private recoverRuntimeOnce?: () => Promise<void>
  private snapshotRunners?: () => Array<{
    pid: number
    rssMiB: number | null
    numCtx: number | null
  }>
  private lastOllamaCallMetrics: OllamaCallMetrics | null = null
  private writerEvalSamples: Array<{ evalCount?: number; evalDurationMs?: number }> = []
  private lastWriterSkips: WriterChunkSkip[] = []
  private lastWriterParseDrops: WriterDrop[] = []
  private benchmarkNumGpu: number | undefined
  private benchmarkNumThread: number | undefined
  private benchmarkOnCallComplete?: (metrics: OllamaCallMetrics) => void | Promise<void>
  private writerContinuation = false

  getLastEvalTokPerSec(): number | null {
    return this.lastOllamaCallMetrics?.evalTokPerSec ?? null
  }

  getWriterWeightedEvalTokPerSec(): number | null {
    return computeWriterWeightedEvalTokPerSec(this.writerEvalSamples)
  }

  getLastOllamaCallMetrics(): OllamaCallMetrics | null {
    return this.lastOllamaCallMetrics
  }

  getLastWriterSkips(): WriterChunkSkip[] {
    return this.lastWriterSkips.slice()
  }

  /** Eval-only. Unset keeps production request bodies byte-identical. */
  setBenchmarkOptions(options: OllamaBenchmarkOptions | null): void {
    this.benchmarkNumGpu = options?.numGpu
    this.benchmarkNumThread = options?.numThread
    this.benchmarkOnCallComplete = options?.onCallComplete
  }

  constructor(baseUrl: string, model: string, options: OllamaProviderOptions = {}) {
    this.baseUrl = baseUrl
    this.model = model
    this.onTelemetry = options.onTelemetry
    this.maybeRecycleRunner = options.maybeRecycleRunner
    this.recoverRuntimeOnce = options.recoverRuntimeOnce
    this.snapshotRunners = options.snapshotRunners
    this.setInitialContextProfile()
  }

  setModel(model: string): void {
    this.model = model
  }

  async completePrompt(
    prompt: string,
    options: {
      num_ctx: number
      num_predict: number
      temperature: number
      seed: number
      stop?: readonly string[]
      format?: unknown
    }
  ): Promise<string> {
    await this.maybeRecycleRunner?.()
    try {
      return await this.generatePrompt(prompt, options)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!this.recoverRuntimeOnce || !isTransientOllamaRuntimeError(message)) {
        throw error
      }
      await this.recoverRuntimeOnce()
      return await this.generatePrompt(prompt, options)
    }
  }

  private async generatePrompt(
    prompt: string,
    options: {
      num_ctx: number
      num_predict: number
      temperature: number
      seed: number
      stop?: readonly string[]
      format?: unknown
    }
  ): Promise<string> {
    const controller = new AbortController()
    const requestTimer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    this.activeControllers.add(controller)
    const requestStartedAt = Date.now()
    this.lastOllamaCallMetrics = null
    try {
      const res = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          prompt,
          stream: true,
          format: options.format,
          options: this.mergeOllamaRequestOptions({
            num_ctx: options.num_ctx,
            num_predict: options.num_predict,
            temperature: options.temperature,
            seed: options.seed,
            stop: options.stop ? [...options.stop] : undefined
          })
        }),
        signal: controller.signal
      })
      if (!res.ok) {
        throw new Error(`Ollama generate failed: ${res.status}`)
      }
      if (!res.body) {
        throw new Error('Ollama generate returned no response body')
      }
      return await this.readGenerateStream(res.body, controller, requestStartedAt)
    } finally {
      clearTimeout(requestTimer)
      this.activeControllers.delete(controller)
    }
  }

  setLowMemoryMode(enabled: boolean): void {
    if (enabled) {
      this.contextProfile = 'low-memory'
      this.contextTokens = LOW_MEMORY_CONTEXT_TOKENS
      return
    }

    if (process.platform === 'win32') {
      // Same hardware gate as setInitialContextProfile — do not clobber low-memory
      // hosts when callers pass false (e.g. Windows notes path in segmentation).
      const memory = this.getHostMemorySnapshot()
      const shouldUseLowMemory =
        (memory.freeGiB != null && memory.freeGiB < LOW_MEMORY_FREE_GIB_THRESHOLD) ||
        (memory.totalGiB != null && memory.totalGiB < LOW_MEMORY_TOTAL_GIB_THRESHOLD)

      if (shouldUseLowMemory) {
        this.contextProfile = 'low-memory'
        this.contextTokens = LOW_MEMORY_CONTEXT_TOKENS
        return
      }

      this.contextProfile = 'windows-balanced'
      this.contextTokens = WINDOWS_CONTEXT_TOKENS
      return
    }

    if (process.platform === 'darwin') {
      this.contextProfile = 'mac-balanced'
      this.contextTokens = MAC_CONTEXT_TOKENS
      return
    }

    this.contextProfile = 'standard'
    this.contextTokens = STANDARD_CONTEXT_TOKENS
  }

  setVramConstrainedContext(
    enabled: boolean,
    profile: 'windows-vulkan' | 'windows-cpu' = 'windows-vulkan'
  ): void {
    if (!enabled) {
      if (this.contextProfile === 'windows-vulkan' || this.contextProfile === 'windows-cpu') {
        this.setLowMemoryMode(false)
      }
      return
    }
    if (process.platform === 'darwin') return
    if (this.contextProfile === 'low-memory') return
    // Writer chunks are ~1K tokens. 4K matches macOS and keeps the KV cache
    // small enough for 4 GB Vulkan cards and Windows CPU RSS.
    this.contextProfile = profile
    this.contextTokens = getDevNotesNumCtxOverride() ?? LOW_MEMORY_CONTEXT_TOKENS
  }

  getModel(): string {
    return this.model
  }

  async checkConnection(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(3000)
      })
      return res.ok
    } catch {
      return false
    }
  }

  abortActiveRequests(reason = 'SEGMENTATION_PREEMPTED'): void {
    for (const controller of this.activeControllers) {
      controller.abort(reason)
    }
    this.activeControllers.clear()
  }

  async releaseResources(meetingId?: string): Promise<void> {
    try {
      const res = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          keep_alive: 0
        }),
        signal: AbortSignal.timeout(5_000)
      })

      logAutodocEvent({
        area: 'segmentation',
        message: res.ok ? 'ollama model unload requested' : 'ollama model unload request failed',
        meetingId,
        context: {
          model: this.model,
          status: res.status
        },
        level: res.ok ? 'info' : 'warn'
      })
    } catch (error) {
      logAutodocEvent({
        area: 'segmentation',
        message: 'ollama model unload request failed',
        meetingId,
        context: {
          model: this.model,
          error: error instanceof Error ? error.message : String(error)
        },
        level: 'warn'
      })
    }
  }

  private setInitialContextProfile(): void {
    if (process.platform === 'darwin') {
      this.contextProfile = 'mac-balanced'
      this.contextTokens = MAC_CONTEXT_TOKENS
      return
    }

    if (process.platform !== 'win32') {
      return
    }

    const memory = this.getHostMemorySnapshot()
    const shouldStartLowMemory =
      (memory.freeGiB != null && memory.freeGiB < LOW_MEMORY_FREE_GIB_THRESHOLD) ||
      (memory.totalGiB != null && memory.totalGiB < LOW_MEMORY_TOTAL_GIB_THRESHOLD)

    if (shouldStartLowMemory) {
      this.contextProfile = 'low-memory'
      this.contextTokens = LOW_MEMORY_CONTEXT_TOKENS
      return
    }

    this.contextProfile = 'windows-balanced'
    this.contextTokens = WINDOWS_CONTEXT_TOKENS
  }

  private estimateItemCount(durationMinutes: number): string {
    const estMinutes = Math.max(5, Math.round(durationMinutes))
    if (this.usesSharedNotesWriter()) {
      return `This is roughly a ${estMinutes}-minute meeting. Target a focused final note set around 40-55 total items across all categories. Prefer fewer, higher-signal notes over exhaustive extraction.`
    }

    // Scale: ~1 item per minute, min 5, no max
    const minItems = Math.max(5, Math.round(estMinutes * 0.8))
    const maxItems = Math.round(estMinutes * 1.5)
    return `This is roughly a ${estMinutes}-minute meeting. Aim for ${minItems}-${maxItems} items total across all categories — approximately 1 item per minute of meeting.`
  }

  async summarize(
    meetingId: string,
    transcript: string,
    onProgress?: (percent: number) => void,
    durationMinutes?: number,
    onActivity?: (activity: SegmentationActivity | null) => void
  ): Promise<MeetingSegments> {
    let currentActivity: SegmentationActivity | null = null
    const reportActivity =
      process.platform === 'win32' && onActivity
        ? (activity: SegmentationActivity | null): void => {
            if (activity === currentActivity) return
            currentActivity = activity
            try {
              onActivity(activity)
            } catch {
              // UI activity reporting must never affect notes generation.
            }
          }
        : undefined

    try {
      return await this.summarizeInternal(
        meetingId,
        transcript,
        onProgress,
        durationMinutes,
        reportActivity
      )
    } finally {
      reportActivity?.(null)
    }
  }

  private async summarizeInternal(
    meetingId: string,
    transcript: string,
    onProgress?: (percent: number) => void,
    durationMinutes?: number,
    reportActivity?: (activity: SegmentationActivity | null) => void
  ): Promise<MeetingSegments> {
    const chunks = this.chunkTranscript(transcript)
    const estMinutes = durationMinutes ?? Math.max(5, Math.round(transcript.length / 750))
    const durationMs = estMinutes * 60 * 1000
    const transcriptTimestamps = this.extractTimestampsMs(transcript)
    const itemGuidance = this.estimateItemCount(estMinutes)
    let lowMemoryFallbackActivated = false
    console.log(
      `Processing transcript in ${chunks.length} chunk(s) (${transcript.length} chars total) ` +
        `with ${this.contextProfile} Ollama context (${this.contextTokens} tokens). ${itemGuidance}`
    )
    logAutodocEvent({
      area: 'segmentation',
      message: 'notes llm summarize started',
      meetingId,
      context: {
        model: this.model,
        contextProfile: this.contextProfile,
        contextTokens: this.contextTokens,
        numCtxOverride: getDevNotesNumCtxOverride() ?? null,
        compactWriter: isCompactWriterEnabled(),
        tightWriter: isTightWriterEnabled(),
        chunkChars: this.getChunkChars(),
        chunkCount: chunks.length,
        transcriptChars: transcript.length,
        durationMinutes: estMinutes
      }
    })

    const merged: MeetingSegments = {
      decisions: [],
      actionItems: [],
      information: [],
      discussion: [],
      statusUpdates: []
    }

    let avgTokensPerChunk = 2000
    let totalTokensSoFar = 0
    let recoveredRuntime = false
    this.lastWriterSkips = []
    this.writerEvalSamples = []
    this.lastWriterParseDrops = []

    for (let i = 0; i < chunks.length; i++) {
      this.writerContinuation = i > 0
      const chunkTranscriptLines = this.parseTranscriptLines(chunks[i])
      const knownTopics = this.extractKnownTopics(merged)
      const chunkLabel = this.buildChunkLabel(i, chunks.length, itemGuidance, knownTopics)

      let lastError: Error | null = null
      let chunkResult: MeetingSegments | null = null
      let chunkTokens = 0
      let parseRetriesUsed = 0
      let chunkSkipped = false

      let attempt = 0
      while (attempt <= MAX_RETRIES) {
        chunkTokens = 0
        const attemptStartedAt = Date.now()
        try {
          if (attempt > 0) {
            console.log(
              `Chunk ${i + 1}/${chunks.length} retry ${attempt}/${MAX_RETRIES} (${this.contextProfile} context)`
            )
          } else {
            console.log(
              `Processing chunk ${i + 1}/${chunks.length} (${chunks[i].length} chars, ${this.contextProfile} context)...`
            )
          }
          await this.maybeRecycleRunner?.(meetingId)
          const raw = await this.callOllama(
            chunks[i] + chunkLabel,
            this.contextTokens,
            attempt,
            () => {
              reportActivity?.(null)
              chunkTokens++
              // Asymptotic progress: approaches 0.99 but never reaches it, so it never appears stuck
              const ratio = chunkTokens / avgTokensPerChunk
              const chunkFraction =
                ratio <= 1 ? ratio * 0.8 : 0.8 + 0.19 * (1 - 1 / (1 + (ratio - 1)))
              onProgress?.(writerProgressPercent(i, chunkFraction, chunks.length))
            },
            reportActivity ? () => reportActivity('waiting-for-local-ai') : undefined
          )
          console.log(`Chunk ${i + 1}/${chunks.length} complete (${chunkTokens} tokens)`)
          const parsedChunk = this.parseResponseWithStats(
            meetingId,
            raw,
            merged,
            durationMs,
            transcriptTimestamps,
            chunkTranscriptLines
          )
          chunkResult = parsedChunk.segments
          this.lastWriterParseDrops.push(...parsedChunk.drops)
          if (this.lastOllamaCallMetrics) {
            this.writerEvalSamples.push({
              evalCount: this.lastOllamaCallMetrics.evalCount,
              evalDurationMs: this.lastOllamaCallMetrics.evalDurationMs
            })
          }
          await this.captureWriterChunk(meetingId, i + 1, raw, parsedChunk)
          logAutodocEvent({
            area: 'segmentation',
            message: 'notes llm chunk completed',
            meetingId,
            context: {
              model: this.model,
              contextProfile: this.contextProfile,
              contextTokens: this.contextTokens,
              chunkIndex: i + 1,
              chunkCount: chunks.length,
              chunkChars: chunks[i].length,
              attempt,
              elapsedMs: Date.now() - attemptStartedAt,
              tokenCount: chunkTokens,
              ollamaMetrics: this.lastOllamaCallMetrics,
              writerParse: {
                rawItemCount: parsedChunk.rawItemCount,
                expandedItemCount: parsedChunk.expandedItemCount,
                acceptedItemCount: parsedChunk.acceptedItemCount,
                drops: parsedChunk.drops
              },
              ...(isNotesEvalInstrumentationEnabled()
                ? { runners: this.safeSnapshotRunners() }
                : {})
            }
          })
          break
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err))
          console.error(`Chunk ${i + 1}/${chunks.length} failed:`, lastError.message)
          logAutodocEvent({
            area: 'segmentation',
            message: 'notes llm chunk failed',
            meetingId,
            level: 'warn',
            context: {
              model: this.model,
              contextProfile: this.contextProfile,
              contextTokens: this.contextTokens,
              chunkIndex: i + 1,
              chunkCount: chunks.length,
              chunkChars: chunks[i].length,
              attempt,
              elapsedMs: Date.now() - attemptStartedAt,
              tokenCount: chunkTokens,
              error: lastError.message,
              ollamaMetrics: this.lastOllamaCallMetrics,
              ...(isWriterParseError(lastError)
                ? { rawHead: lastError.rawHead, rawTail: lastError.rawTail }
                : {})
            }
          })
          if (lastError.message === 'SEGMENTATION_PREEMPTED') {
            throw lastError
          }
          if (
            !recoveredRuntime &&
            this.recoverRuntimeOnce &&
            isTransientOllamaRuntimeError(lastError.message)
          ) {
            recoveredRuntime = true
            await this.recoverRuntimeOnce()
            continue
          }
          if (
            this.shouldEnableLowMemoryFallback(lastError.message) &&
            this.contextTokens > LOW_MEMORY_CONTEXT_TOKENS
          ) {
            lowMemoryFallbackActivated = true
            this.enableLowMemoryContext(meetingId, lastError, {
              chunkIndex: i + 1,
              chunkCount: chunks.length,
              transcriptChars: transcript.length,
              durationMinutes: estMinutes
            })
            continue
          }
          if (isWriterParseError(lastError)) {
            if (parseRetriesUsed < WRITER_PARSE_RETRY_LIMIT) {
              parseRetriesUsed++
              attempt++
              continue
            }
            const skip: WriterChunkSkip = {
              chunkIndex: i + 1,
              attempts: parseRetriesUsed + 1,
              rawHead: lastError.rawHead,
              rawTail: lastError.rawTail
            }
            this.lastWriterSkips.push(skip)
            logAutodocEvent({
              area: 'segmentation',
              message: 'notes llm chunk skipped',
              meetingId,
              level: 'warn',
              context: {
                model: this.model,
                contextProfile: this.contextProfile,
                contextTokens: this.contextTokens,
                chunkIndex: i + 1,
                chunkCount: chunks.length,
                chunkChars: chunks[i].length,
                tokenCount: chunkTokens,
                rawHead: lastError.rawHead,
                rawTail: lastError.rawTail,
                ollamaMetrics: this.lastOllamaCallMetrics
              }
            })
            chunkSkipped = true
            break
          }
          if (attempt < MAX_RETRIES) {
            attempt++
            continue
          }
          attempt++
        }
      }

      if (!chunkResult) {
        if (chunkSkipped) {
          onProgress?.(writerProgressPercent(i, 1, chunks.length))
          continue
        }
        if (lowMemoryFallbackActivated) {
          this.recordLowMemoryFallbackEvent(
            'ollama_low_memory_fallback_failed',
            meetingId,
            lastError,
            {
              chunkIndex: i + 1,
              chunkCount: chunks.length,
              transcriptChars: transcript.length,
              durationMinutes: estMinutes
            }
          )
        }
        throw lastError ?? new Error(`LLM summarization failed on chunk ${i + 1}/${chunks.length}`)
      }

      totalTokensSoFar += chunkTokens
      avgTokensPerChunk = Math.round(totalTokensSoFar / (i + 1))

      merged.decisions.push(...chunkResult.decisions)
      merged.actionItems.push(...chunkResult.actionItems)
      merged.information.push(...chunkResult.information)
      merged.discussion.push(...chunkResult.discussion)
      merged.statusUpdates.push(...chunkResult.statusUpdates)

      onProgress?.(writerProgressPercent(i, 1, chunks.length))
    }

    this.normalizeMergedTopics(merged)
    this.dedupeNearDuplicateItems(merged)
    if (lowMemoryFallbackActivated) {
      this.recordLowMemoryFallbackEvent('ollama_low_memory_fallback_succeeded', meetingId, null, {
        chunkCount: chunks.length,
        transcriptChars: transcript.length,
        durationMinutes: estMinutes
      })
    }
    logAutodocEvent({
      area: 'segmentation',
      message: 'notes llm summarize completed',
      meetingId,
      context: {
        model: this.model,
        contextProfile: this.contextProfile,
        contextTokens: this.contextTokens,
        chunkCount: chunks.length,
        transcriptChars: transcript.length,
        durationMinutes: estMinutes,
        itemCount: this.flattenSegments(merged).length,
        skippedChunkCount: this.lastWriterSkips.length,
        skippedChunkIndexes: this.lastWriterSkips.map((skip) => skip.chunkIndex),
        writerWeightedEvalTokPerSec: this.getWriterWeightedEvalTokPerSec(),
        lastEvalTokPerSec: this.getLastEvalTokPerSec(),
        writerParseDrops: this.lastWriterParseDrops
      }
    })
    return merged
  }

  private extractKnownTopics(segments: MeetingSegments): string[] {
    const seen = new Set<string>()
    const topics: string[] = []

    for (const item of this.flattenSegments(segments)) {
      const topic = item.topic?.trim()
      if (!topic) continue
      const key = this.normalizeTopicText(topic)
      if (!key || seen.has(key)) continue
      seen.add(key)
      topics.push(topic)
    }

    return topics.slice(0, MAX_UNIQUE_TOPICS)
  }

  private chunkTranscript(transcript: string): string[] {
    return packTranscriptChunks(
      transcript,
      this.getChunkChars(),
      shouldAbsorbWindowsTightShortTail()
    )
  }

  private getChunkChars(): number {
    return getDevNotesChunkCharsOverride() ?? CHUNK_CHARS
  }

  private safeSnapshotRunners(): Array<{
    pid: number
    rssMiB: number | null
    numCtx: number | null
  }> {
    try {
      return this.snapshotRunners?.() ?? []
    } catch {
      return []
    }
  }

  private getSystemPrompt(): string {
    if (isTightWriterEnabled()) {
      const omitWindowsTightSuffix =
        process.platform === 'win32' && this.writerContinuation
      return this.usesSharedNotesWriter() && !omitWindowsTightSuffix
        ? `${SYSTEM_PROMPT_TIGHT}${TIGHT_NOTES_PROMPT_SUFFIX}`
        : SYSTEM_PROMPT_TIGHT
    }
    if (this.writerContinuation && isShortWriterPromptEnabled()) {
      return isCompactWriterEnabled()
        ? NOTES_WRITER_SHORT_CONTINUATION_COMPACT
        : NOTES_WRITER_SHORT_CONTINUATION
    }
    const prompt = isCompactWriterEnabled()
      ? SYSTEM_PROMPT.replace(NOTES_WRITER_JSON_CONTRACT, NOTES_WRITER_COMPACT_JSON_CONTRACT).replace(
          NOTES_WRITER_TIMESTAMPS,
          NOTES_WRITER_COMPACT_TIMESTAMPS
        )
      : SYSTEM_PROMPT
    if (this.usesSharedNotesWriter()) {
      return `${prompt}${MAC_NOTES_PROMPT_SUFFIX}`
    }

    return prompt
  }

  private buildChunkLabel(
    chunkIndex: number,
    chunkCount: number,
    itemGuidance: string,
    knownTopics: string[]
  ): string {
    const knownTopicGuidance =
      !isTightWriterEnabled() && knownTopics.length > 0
        ? ` Reuse these exact topic strings whenever they fit instead of inventing a new one: ${knownTopics.join('; ')}.`
        : ''

    if (chunkCount <= 1) {
      return `\n\n${itemGuidance}${knownTopicGuidance}`
    }

    if (isTightWriterEnabled()) {
      return `\n\nThis is part ${chunkIndex + 1} of ${chunkCount} of the meeting. Strongest NEW notes only, at most 6 items. One fact in one category. Omit empty categories.`
    }

    if (this.usesSharedNotesWriter() && process.env.AUTODOC_TEST_NOTES_WHOLE_MEETING_BUDGET !== '1') {
      return `\n\nThis is part ${chunkIndex + 1} of ${chunkCount} of the meeting. Extract only the strongest NEW notes from this section, at most 6 total items across all categories. Use broad reusable topic headings, not per-item headings. Do not create a new topic unless this section introduces a genuinely new major subject. Empty arrays are preferred for repeated or weak content.${knownTopicGuidance}`
    }

    return `\n\nThis is part ${chunkIndex + 1} of ${chunkCount} of the meeting. Extract only the noteworthy items from THIS section. Be concise. ${itemGuidance}${knownTopicGuidance}`
  }

  private mergeOllamaRequestOptions<T extends Record<string, unknown>>(options: T): T {
    const numThread = this.benchmarkNumThread ?? getDevNotesNumThreadOverride()
    const numBatch = getDevNotesNumBatchOverride()
    if (this.benchmarkNumGpu == null && numThread == null && numBatch == null) {
      return options
    }
    return {
      ...options,
      ...(this.benchmarkNumGpu != null ? { num_gpu: this.benchmarkNumGpu } : {}),
      ...(numThread != null ? { num_thread: numThread } : {}),
      ...(numBatch != null ? { num_batch: numBatch } : {})
    }
  }

  private async recordCallMetrics(metrics: OllamaCallMetrics): Promise<void> {
    this.lastOllamaCallMetrics = metrics
    await this.benchmarkOnCallComplete?.(metrics)
  }

  private async readGenerateStream(
    body: ReadableStream<Uint8Array>,
    controller: AbortController,
    requestStartedAt: number
  ): Promise<string> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let content = ''

    try {
      while (true) {
        let streamTimer: ReturnType<typeof setTimeout> | undefined
        const streamTimeoutError = new Error(
          `Ollama stream timed out after ${STREAM_TIMEOUT_MS / 1000}s with no data`
        )
        const streamTimeout = new Promise<never>((_, reject) => {
          streamTimer = setTimeout(() => reject(streamTimeoutError), STREAM_TIMEOUT_MS)
        })
        let readResult: ReadableStreamReadResult<Uint8Array>
        try {
          readResult = await Promise.race([reader.read(), streamTimeout])
        } catch (error) {
          if (error === streamTimeoutError) {
            controller.abort(streamTimeoutError)
            await reader.cancel(streamTimeoutError).catch(() => {})
          }
          throw error
        } finally {
          clearTimeout(streamTimer)
        }
        const { done, value } = readResult
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const data = JSON.parse(line) as {
              response?: string
              error?: string
              done?: boolean
              total_duration?: number
              load_duration?: number
              prompt_eval_count?: number
              prompt_eval_duration?: number
              eval_count?: number
              eval_duration?: number
              done_reason?: string
            }
            if (data.error) throw new Error(`Ollama error: ${data.error}`)
            if (typeof data.response === 'string') content += data.response
            if (data.done) {
              await this.recordCallMetrics(this.normalizeOllamaMetrics(data, requestStartedAt))
            }
          } catch (error) {
            if (error instanceof SyntaxError) {
              console.warn('Ollama: unparseable generate line (skipped):', line.slice(0, 100))
              continue
            }
            throw error
          }
        }
      }

      if (buffer.trim()) {
        try {
          const data = JSON.parse(buffer) as {
            response?: string
            error?: string
            done?: boolean
            total_duration?: number
            load_duration?: number
            prompt_eval_count?: number
            prompt_eval_duration?: number
            eval_count?: number
            eval_duration?: number
            done_reason?: string
          }
          if (data.error) throw new Error(`Ollama error: ${data.error}`)
          if (typeof data.response === 'string') content += data.response
          if (data.done) {
            await this.recordCallMetrics(this.normalizeOllamaMetrics(data, requestStartedAt))
          }
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error
        }
      }
    } finally {
      reader.releaseLock()
    }

    return content
  }

  private async callOllama(
    transcript: string,
    contextTokens: number,
    attempt = 0,
    onToken?: () => void,
    onWaiting?: () => void
  ): Promise<string> {
    if (
      process.platform === 'win32' &&
      IS_TEST_RUNTIME &&
      process.env.AUTODOC_TEST_REAL_SETUP === '1' &&
      process.env.AUTODOC_TEST_OLLAMA_SUMMARY_MODE === 'fixed-success'
    ) {
      onToken?.()
      return JSON.stringify({
        decisions: [],
        action_items: [
          {
            topic: 'Windows setup',
            title: 'Coordinate Ollama setup',
            content: 'AutoDoc should keep notes waiting while shared Ollama setup completes.',
            assignee: null,
            deadline: null,
            sourceStartMs: 0,
            sourceEndMs: 20_000
          }
        ],
        information: [],
        discussion: [],
        status_updates: []
      })
    }

    const controller = new AbortController()
    const requestTimer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    this.activeControllers.add(controller)

    const requestStartedAt = Date.now()
    this.lastOllamaCallMetrics = null
    const systemPrompt = this.getSystemPrompt()
    const userContent = `Here is the meeting transcript:\n\n${transcript}`
    const requestOptions = this.mergeOllamaRequestOptions({
      num_ctx: contextTokens,
      num_predict: this.getMaxOutputTokens(),
      // Retries must not replay the identical request: at temperature 0 a
      // malformed completion reproduces deterministically, so every retry
      // fails the same way. A small temperature plus a per-attempt seed
      // lets retries escape while keeping first attempts untouched.
      temperature: attempt > 0 ? RETRY_TEMPERATURE : 0,
      seed: attempt > 0 ? attempt : undefined,
      repeat_penalty: WRITER_REPEAT_PENALTY
    })
    if (isNotesEvalInstrumentationEnabled()) {
      const promptHash = createHash('sha256')
        .update(systemPrompt)
        .update('\n')
        .update(userContent)
        .digest('hex')
        .slice(0, 16)
      logAutodocEvent({
        area: 'segmentation',
        message: 'notes llm chunk request',
        context: {
          model: this.model,
          contextProfile: this.contextProfile,
          contextTokens,
          promptHash,
          systemChars: systemPrompt.length,
          userChars: userContent.length,
          format: shouldOmitWindowsTightResponseFormat()
            ? 'none'
            : this.getNotesResponseFormat() === 'json'
              ? 'json'
              : 'schema',
          options: requestOptions,
          runners: this.safeSnapshotRunners()
        }
      })
    }

    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent }
          ],
          stream: true,
          ...(shouldOmitWindowsTightResponseFormat()
            ? {}
            : { format: this.getNotesResponseFormat() }),
          options: requestOptions
        }),
        signal: controller.signal
      })
    } catch (err) {
      clearTimeout(requestTimer)
      this.activeControllers.delete(controller)
      if (controller.signal.aborted && controller.signal.reason === 'SEGMENTATION_PREEMPTED') {
        throw new Error('SEGMENTATION_PREEMPTED')
      }
      throw err
    }

    if (!res.ok) {
      clearTimeout(requestTimer)
      this.activeControllers.delete(controller)
      const text = await res.text().catch(() => '')
      throw new Error(`Ollama returned ${res.status}: ${text.slice(0, 200)}`)
    }

    if (!res.body) {
      clearTimeout(requestTimer)
      this.activeControllers.delete(controller)
      throw new Error('Ollama returned no response body')
    }

    let content = ''
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        let streamTimer: ReturnType<typeof setTimeout> | undefined
        let slowActivityTimer: ReturnType<typeof setTimeout> | undefined
        const streamTimeoutError = new Error(
          `Ollama stream timed out after ${STREAM_TIMEOUT_MS / 1000}s with no data`
        )
        const streamTimeout = new Promise<never>((_, reject) => {
          streamTimer = setTimeout(() => reject(streamTimeoutError), STREAM_TIMEOUT_MS)
        })
        if (process.platform === 'win32' && onWaiting) {
          slowActivityTimer = setTimeout(() => {
            try {
              onWaiting()
            } catch {
              // UI activity reporting must never affect the stream request.
            }
          }, SLOW_STREAM_ACTIVITY_DELAY_MS)
        }
        let readResult: ReadableStreamReadResult<Uint8Array>
        try {
          readResult = await Promise.race([reader.read(), streamTimeout])
        } catch (error) {
          // On Windows, a timed-out Ollama generation can keep running and
          // block the immediate retry behind orphaned work. Abort and cancel only on
          // Windows for v1.1.1; revisit this guard if the same signature is confirmed on macOS.
          if (process.platform === 'win32' && error === streamTimeoutError) {
            controller.abort(streamTimeoutError)
            await reader.cancel(streamTimeoutError).catch(() => {})
          }
          throw error
        } finally {
          clearTimeout(streamTimer)
          clearTimeout(slowActivityTimer)
        }
        const { done, value } = readResult
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const data = JSON.parse(line) as {
              message?: { content?: string }
              error?: string
              done?: boolean
              done_reason?: string
              total_duration?: number
              load_duration?: number
              prompt_eval_count?: number
              prompt_eval_duration?: number
              eval_count?: number
              eval_duration?: number
            }
            if (data.error) throw new Error(`Ollama error: ${data.error}`)
            if (data.message?.content) {
              content += data.message.content
              onToken?.()
              if (shouldStopWindowsTightWriterStream(content)) {
                await reader.cancel().catch(() => {})
                return content
              }
            }
            if (data.done) {
              await this.recordCallMetrics(this.normalizeOllamaMetrics(data, requestStartedAt))
            }
          } catch (e) {
            if (e instanceof SyntaxError) {
              console.warn('Ollama: unparseable line (skipped):', line.slice(0, 100))
              continue
            }
            throw e
          }
        }
      }

      // Flush remaining buffer
      if (buffer.trim()) {
        try {
          const data = JSON.parse(buffer) as {
            message?: { content?: string }
            error?: string
            done?: boolean
            done_reason?: string
            total_duration?: number
            load_duration?: number
            prompt_eval_count?: number
            prompt_eval_duration?: number
            eval_count?: number
            eval_duration?: number
          }
          if (data.error) throw new Error(`Ollama error: ${data.error}`)
          if (data.message?.content) {
            content += data.message.content
            onToken?.()
          }
          if (data.done) {
            await this.recordCallMetrics(this.normalizeOllamaMetrics(data, requestStartedAt))
          }
        } catch (e) {
          if (!(e instanceof SyntaxError)) throw e
        }
      }
    } finally {
      clearTimeout(requestTimer)
      this.activeControllers.delete(controller)
    }

    if (!content) {
      throw new Error('Ollama returned empty response')
    }

    return content
  }

  private normalizeOllamaMetrics(
    data: {
      total_duration?: number
      load_duration?: number
      prompt_eval_count?: number
      prompt_eval_duration?: number
      eval_count?: number
      eval_duration?: number
      done_reason?: string
    },
    requestStartedAt: number
  ): OllamaCallMetrics {
    const nsToMs = (value?: number): number | undefined =>
      typeof value === 'number' ? Math.round(value / 1_000_000) : undefined

    const evalDurationMs = nsToMs(data.eval_duration)
    const evalCount = data.eval_count
    return {
      totalDurationMs: nsToMs(data.total_duration) ?? Date.now() - requestStartedAt,
      loadDurationMs: nsToMs(data.load_duration),
      promptEvalCount: data.prompt_eval_count,
      promptEvalDurationMs: nsToMs(data.prompt_eval_duration),
      evalCount,
      evalDurationMs,
      evalTokPerSec:
        evalCount != null && evalDurationMs != null && evalDurationMs > 0
          ? Math.round((evalCount / evalDurationMs) * 1000 * 10) / 10
          : undefined,
      doneReason: typeof data.done_reason === 'string' ? data.done_reason : undefined
    }
  }

  private usesSharedNotesWriter(): boolean {
    return process.platform === 'darwin' || process.platform === 'win32'
  }

  private getNotesResponseFormat(): 'json' | typeof NOTES_RESPONSE_SCHEMA {
    return 'json'
  }

  private getMaxOutputTokens(): number {
    if (process.platform !== 'win32') return MAX_OUTPUT_TOKENS
    if (isTightWriterEnabled()) return WINDOWS_TIGHT_MAX_OUTPUT_TOKENS
    return WINDOWS_MAX_OUTPUT_TOKENS
  }

  private enableLowMemoryContext(
    meetingId: string,
    error: Error,
    context: Record<string, unknown>
  ): void {
    this.contextProfile = 'low-memory'
    this.contextTokens = LOW_MEMORY_CONTEXT_TOKENS
    this.recordLowMemoryFallbackEvent(
      'ollama_low_memory_fallback_triggered',
      meetingId,
      error,
      context
    )
  }

  private isInsufficientSystemMemoryError(message: string): boolean {
    const normalized = message.toLowerCase()
    return (
      normalized.includes('ollama') &&
      normalized.includes('requires more system memory') &&
      normalized.includes('than is available')
    )
  }

  private isLowMemoryRunnerStopError(message: string): boolean {
    const normalized = message.toLowerCase()
    if (
      !normalized.includes('ollama returned 500') ||
      !normalized.includes('model runner has unexpectedly stopped')
    ) {
      return false
    }

    const hostMemory = this.getHostMemorySnapshot()
    return (
      (hostMemory.freeGiB != null && hostMemory.freeGiB < LOW_MEMORY_FREE_GIB_THRESHOLD) ||
      (hostMemory.totalGiB != null && hostMemory.totalGiB < LOW_MEMORY_TOTAL_GIB_THRESHOLD)
    )
  }

  private shouldEnableLowMemoryFallback(message: string): boolean {
    return this.isInsufficientSystemMemoryError(message) || this.isLowMemoryRunnerStopError(message)
  }

  private extractOllamaMemoryGiB(message: string): {
    requiredGiB: number | null
    availableGiB: number | null
  } {
    const match = message.match(
      /requires more system memory\s*\(([\d.]+)\s*GiB\)\s*than is available\s*\(([\d.]+)\s*GiB\)/i
    )
    if (!match) {
      return { requiredGiB: null, availableGiB: null }
    }

    return {
      requiredGiB: Number.parseFloat(match[1]),
      availableGiB: Number.parseFloat(match[2])
    }
  }

  private getHostMemorySnapshot(): { freeGiB: number | null; totalGiB: number | null } {
    const processWithMemory = process as NodeJS.Process & {
      getSystemMemoryInfo?: () => { free?: number; total?: number }
    }
    const info = processWithMemory.getSystemMemoryInfo?.()
    if (!info) {
      return { freeGiB: null, totalGiB: null }
    }

    return {
      freeGiB: typeof info.free === 'number' ? Number((info.free / 1024 / 1024).toFixed(2)) : null,
      totalGiB:
        typeof info.total === 'number' ? Number((info.total / 1024 / 1024).toFixed(2)) : null
    }
  }

  private recordLowMemoryFallbackEvent(
    event: OllamaProviderTelemetryEventName,
    meetingId: string,
    error: Error | null,
    context: Record<string, unknown>
  ): void {
    const ollamaMemory = error
      ? this.extractOllamaMemoryGiB(error.message)
      : { requiredGiB: null, availableGiB: null }
    const hostMemory = this.getHostMemorySnapshot()
    const properties = {
      model: this.model,
      contextProfile: this.contextProfile,
      standardContextTokens: STANDARD_CONTEXT_TOKENS,
      lowMemoryContextTokens: LOW_MEMORY_CONTEXT_TOKENS,
      ollamaRequiredSystemMemoryGiB: ollamaMemory.requiredGiB,
      ollamaAvailableSystemMemoryGiB: ollamaMemory.availableGiB,
      hostFreeMemoryGiB: hostMemory.freeGiB,
      hostTotalMemoryGiB: hostMemory.totalGiB,
      errorMessage: error?.message.slice(0, 300) ?? null,
      ...context
    }

    logAutodocEvent({
      area: 'segmentation',
      level: event === 'ollama_low_memory_fallback_triggered' ? 'warn' : 'info',
      message: event,
      meetingId,
      context: properties
    })
    captureMessage(event, {
      area: 'segmentation',
      meetingId,
      level: event === 'ollama_low_memory_fallback_failed' ? 'error' : 'warning',
      tags: {
        errorCode: 'ollama-insufficient-memory',
        contextProfile: this.contextProfile
      },
      extra: properties
    })
    this.onTelemetry?.({ meetingId, event, properties })
  }

  /**
   * Repair truncated JSON from num_predict cap.
   * Tries multiple strategies from least to most aggressive.
   */
  private repairTruncatedJSON(raw: string): Record<string, RawSegment[]> | null {
    const variants = [raw]
    const closedString = this.closeUnterminatedString(raw)
    if (closedString !== raw) variants.push(closedString)

    const strategies = [
      // Strategy 1: cut at last complete array item "},"
      (text: string) => {
        const idx = text.lastIndexOf('},')
        if (idx === -1) return null
        return this.closeJSON(text.slice(0, idx + 1))
      },
      // Strategy 2: cut at last complete array "]"
      (text: string) => {
        const idx = text.lastIndexOf(']')
        if (idx === -1) return null
        return this.closeJSON(text.slice(0, idx + 1))
      },
      // Strategy 3: cut at last complete key-value with empty array
      (text: string) => {
        const idx = text.lastIndexOf('[]')
        if (idx === -1) return null
        return this.closeJSON(text.slice(0, idx + 2))
      }
    ]

    for (const text of variants) {
      for (const strategy of strategies) {
        const cut = strategy(text)
        if (!cut) continue
        try {
          return JSON.parse(cut)
        } catch {
          continue
        }
      }
    }

    return null
  }

  /** If generation stopped inside a JSON string, close it so cut strategies can run. */
  private closeUnterminatedString(raw: string): string {
    let inString = false
    let escape = false
    for (const ch of raw) {
      if (escape) {
        escape = false
        continue
      }
      if (ch === '\\' && inString) {
        escape = true
        continue
      }
      if (ch === '"') {
        inString = !inString
      }
    }
    if (!inString) return raw
    return escape ? `${raw}\\"` : `${raw}"`
  }

  /** Count unclosed brackets/braces and append closers */
  private closeJSON(partial: string): string {
    let openBraces = 0
    let openBrackets = 0
    let inString = false
    let escape = false
    for (const ch of partial) {
      if (escape) {
        escape = false
        continue
      }
      if (ch === '\\' && inString) {
        escape = true
        continue
      }
      if (ch === '"') {
        inString = !inString
        continue
      }
      if (inString) continue
      if (ch === '{') openBraces++
      else if (ch === '}') openBraces--
      else if (ch === '[') openBrackets++
      else if (ch === ']') openBrackets--
    }
    let result = partial
    for (let i = 0; i < openBrackets; i++) result += ']'
    for (let i = 0; i < openBraces; i++) result += '}'
    return result
  }

  private parseResponse(
    meetingId: string,
    raw: string,
    existing?: MeetingSegments,
    durationMs?: number,
    transcriptTimestamps?: number[],
    transcriptLines: TranscriptLine[] = []
  ): MeetingSegments {
    return this.parseResponseWithStats(
      meetingId,
      raw,
      existing,
      durationMs,
      transcriptTimestamps,
      transcriptLines
    ).segments
  }

  private parseResponseWithStats(
    meetingId: string,
    raw: string,
    existing?: MeetingSegments,
    durationMs?: number,
    transcriptTimestamps?: number[],
    transcriptLines: TranscriptLine[] = []
  ): {
    segments: MeetingSegments
    rawItemCount: number
    expandedItemCount: number
    acceptedItemCount: number
    drops: WriterDrop[]
  } {
    let inspected: WriterExpandResult
    const record = parseWriterJsonRecord(raw)
    if (record) {
      inspected = inspectCompactWriterPayload(record)
    } else {
      const repaired = this.repairTruncatedJSON(raw)
      if (repaired) {
        inspected = inspectCompactWriterPayload(repaired)
        console.warn('Repaired truncated JSON from Ollama (some items may have been dropped)')
      } else {
        throw new WriterParseError(raw)
      }
    }

    const parsed = inspected.expanded
    const drops = [...inspected.drops]
    const result: MeetingSegments = {
      decisions: [],
      actionItems: [],
      information: [],
      discussion: [],
      statusUpdates: []
    }

    const fieldMap: Record<string, keyof MeetingSegments> = {
      decisions: 'decisions',
      action_items: 'actionItems',
      information: 'information',
      discussion: 'discussion',
      status_updates: 'statusUpdates'
    }
    const scopedTranscriptTimestamps =
      transcriptLines.length > 0
        ? transcriptLines.map((line) => line.startMs)
        : transcriptTimestamps

    for (const [rawKey, resultKey] of Object.entries(fieldMap)) {
      const items = parsed[rawKey]
      if (!Array.isArray(items)) continue

      const category = CATEGORY_MAP[rawKey]
      const existingCount = existing ? existing[resultKey].length : 0
      const existingTitles = new Set(
        existing ? existing[resultKey].map((s) => s.title.toLowerCase()) : []
      )
      const seenTitles = new Set<string>()
      let index = existingCount

      for (const item of items) {
        if (!item.title) {
          drops.push({ reason: 'missing_title', category: rawKey })
          continue
        }
        if (!item.content) {
          drops.push({ reason: 'missing_content', category: rawKey })
          continue
        }
        const titleKey = String(item.title).toLowerCase().trim()
        if (seenTitles.has(titleKey) || existingTitles.has(titleKey)) {
          drops.push({ reason: 'duplicate_title', category: rawKey, detail: String(item.title) })
          continue
        }
        const sourceRange = this.resolveGroundedSourceRange(
          item,
          durationMs,
          scopedTranscriptTimestamps,
          transcriptLines
        )
        if (!sourceRange) {
          drops.push({ reason: 'ungrounded', category: rawKey, detail: String(item.title) })
          continue
        }
        seenTitles.add(titleKey)

        result[resultKey].push({
          id: `${meetingId}-${rawKey}-${index}`,
          meetingId,
          category,
          topic: item.topic ? capitalize(String(item.topic)) : null,
          title: capitalize(String(item.title)),
          content: capitalize(String(item.content)),
          assignee: item.assignee ? String(item.assignee) : null,
          deadline: item.deadline ? String(item.deadline) : null,
          sourceStartMs: sourceRange.startMs,
          sourceEndMs: sourceRange.endMs
        })
        index++
      }
    }

    return {
      segments: result,
      rawItemCount: inspected.rawItemCount,
      expandedItemCount: inspected.expandedItemCount,
      acceptedItemCount: this.flattenSegments(result).length,
      drops
    }
  }

  private async captureWriterChunk(
    meetingId: string,
    chunkIndex: number,
    raw: string,
    parsed: {
      rawItemCount: number
      expandedItemCount: number
      acceptedItemCount: number
      drops: WriterDrop[]
    }
  ): Promise<void> {
    const captureDir = process.env.AUTODOC_TEST_NOTES_CAPTURE_DIR?.trim()
    if (!captureDir) return
    try {
      await mkdir(captureDir, { recursive: true })
      await writeFile(join(captureDir, `chunk-${chunkIndex}-raw.json`), raw, 'utf8')
      await writeFile(
        join(captureDir, `chunk-${chunkIndex}-parse.json`),
        JSON.stringify({ meetingId, chunkIndex, ...parsed }, null, 2),
        'utf8'
      )
    } catch (error) {
      logAutodocEvent({
        area: 'segmentation',
        message: 'notes writer capture failed',
        meetingId,
        level: 'warn',
        context: {
          chunkIndex,
          error: error instanceof Error ? error.message : String(error)
        }
      })
    }
  }

  private normalizeMergedTopics(segments: MeetingSegments): void {
    const items = this.flattenSegments(segments).filter((item) => item.topic?.trim())
    if (items.length === 0) return

    let groups = this.buildTopicGroups(items)
    groups = this.mergeExactAndNearDuplicateTopics(groups)
    groups = this.reduceTopicGroups(groups)

    for (const group of groups) {
      const canonical = this.pickCanonicalTopic(group)
      for (const segment of group.segments) {
        segment.topic = canonical
      }
    }
  }

  private dedupeNearDuplicateItems(_segments: MeetingSegments): void {
    // Writer-level title collapse was a Windows V1 llama workaround. The shared
    // V2 writer + scan path matches macOS and leaves near-duplicates for scan.
  }

  private flattenSegments(segments: MeetingSegments): Segment[] {
    return [
      ...segments.decisions,
      ...segments.actionItems,
      ...segments.information,
      ...segments.discussion,
      ...segments.statusUpdates
    ]
  }

  private buildTopicGroups(items: Segment[]): TopicGroup[] {
    const groups: TopicGroup[] = []
    const topicMap = new Map<string, TopicGroup>()

    for (const item of items) {
      const topic = item.topic?.trim()
      if (!topic) continue

      const key = this.normalizeTopicText(topic)
      const existing = topicMap.get(key)
      if (existing) {
        existing.segments.push(item)
        existing.labelCounts.set(topic, (existing.labelCounts.get(topic) ?? 0) + 1)
        continue
      }

      const group: TopicGroup = {
        segments: [item],
        labelCounts: new Map([[topic, 1]])
      }
      topicMap.set(key, group)
      groups.push(group)
    }

    return groups
  }

  private mergeExactAndNearDuplicateTopics(groups: TopicGroup[]): TopicGroup[] {
    let changed = true

    while (changed) {
      changed = false
      outer: for (let i = 0; i < groups.length; i++) {
        for (let j = i + 1; j < groups.length; j++) {
          if (this.getTopicGroupSimilarity(groups[i], groups[j]) < TOPIC_MERGE_THRESHOLD) {
            continue
          }

          groups[i] = this.mergeTopicGroups(groups[i], groups[j])
          groups.splice(j, 1)
          changed = true
          break outer
        }
      }
    }

    return groups
  }

  private reduceTopicGroups(groups: TopicGroup[]): TopicGroup[] {
    while (
      groups.length > MAX_UNIQUE_TOPICS ||
      groups.some((group) => group.segments.length === 1 && groups.length > 1)
    ) {
      let sourceIndex = -1

      if (groups.length > MAX_UNIQUE_TOPICS) {
        sourceIndex = this.findSmallestGroupIndex(groups)
      } else {
        sourceIndex = groups.findIndex((group) => group.segments.length === 1)
      }

      if (sourceIndex < 0) break

      let bestTargetIndex = -1
      let bestScore = -1

      for (let targetIndex = 0; targetIndex < groups.length; targetIndex++) {
        if (targetIndex === sourceIndex) continue

        const similarity = this.getTopicGroupSimilarity(groups[sourceIndex], groups[targetIndex])
        const sizeBonus = groups[targetIndex].segments.length * 0.02
        const score = similarity + sizeBonus
        if (score > bestScore) {
          bestScore = score
          bestTargetIndex = targetIndex
        }
      }

      if (bestTargetIndex < 0) break

      const mustMerge = groups.length > MAX_UNIQUE_TOPICS
      if (!mustMerge && bestScore < TOPIC_SINGLETON_MERGE_THRESHOLD) {
        break
      }

      groups[bestTargetIndex] = this.mergeTopicGroups(groups[bestTargetIndex], groups[sourceIndex])
      groups.splice(sourceIndex, 1)
    }

    return groups
  }

  private findSmallestGroupIndex(groups: TopicGroup[]): number {
    let smallestIndex = 0
    for (let i = 1; i < groups.length; i++) {
      if (groups[i].segments.length < groups[smallestIndex].segments.length) {
        smallestIndex = i
      }
    }
    return smallestIndex
  }

  private mergeTopicGroups(primary: TopicGroup, secondary: TopicGroup): TopicGroup {
    const labelCounts = new Map(primary.labelCounts)
    for (const [label, count] of secondary.labelCounts.entries()) {
      labelCounts.set(label, (labelCounts.get(label) ?? 0) + count)
    }

    return {
      segments: [...primary.segments, ...secondary.segments],
      labelCounts
    }
  }

  private pickCanonicalTopic(group: TopicGroup): string {
    const candidates = [...group.labelCounts.entries()]
    candidates.sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1]

      const aWords = this.tokenizeTopic(a[0]).length
      const bWords = this.tokenizeTopic(b[0]).length
      if (aWords !== bWords) return aWords - bWords

      if (a[0].length !== b[0].length) return a[0].length - b[0].length
      return a[0].localeCompare(b[0])
    })

    return candidates[0]?.[0] ?? 'General'
  }

  private getTopicGroupSimilarity(a: TopicGroup, b: TopicGroup): number {
    const aTopics = [...a.labelCounts.keys()]
    const bTopics = [...b.labelCounts.keys()]
    const directTopicSimilarity = Math.max(
      ...aTopics.flatMap((left) =>
        bTopics.map((right) => this.getTopicTextSimilarity(left, right))
      ),
      0
    )

    const aHeadlineTokens = this.getGroupTokens(a, false)
    const bHeadlineTokens = this.getGroupTokens(b, false)
    const aContextTokens = this.getGroupTokens(a, true)
    const bContextTokens = this.getGroupTokens(b, true)

    const headlineSimilarity = this.getTokenSetSimilarity(aHeadlineTokens, bHeadlineTokens)
    const contextSimilarity = this.getTokenSetSimilarity(aContextTokens, bContextTokens)

    return Math.max(
      directTopicSimilarity,
      headlineSimilarity,
      headlineSimilarity * 0.65 + contextSimilarity * 0.35
    )
  }

  private getGroupTokens(group: TopicGroup, includeContent: boolean): Set<string> {
    const tokens = new Set<string>()

    for (const segment of group.segments) {
      for (const token of this.tokenizeTopic(
        `${segment.topic ?? ''} ${segment.title}${includeContent ? ` ${segment.content}` : ''}`
      )) {
        tokens.add(token)
      }
    }

    return tokens
  }

  private getTopicTextSimilarity(left: string, right: string): number {
    const normalizedLeft = this.normalizeTopicText(left)
    const normalizedRight = this.normalizeTopicText(right)
    if (!normalizedLeft || !normalizedRight) return 0
    if (normalizedLeft === normalizedRight) return 1
    if (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)) {
      return 0.9
    }

    return this.getTokenSetSimilarity(
      new Set(this.tokenizeTopic(left)),
      new Set(this.tokenizeTopic(right))
    )
  }

  private getTokenSetSimilarity(left: Set<string>, right: Set<string>): number {
    if (left.size === 0 || right.size === 0) return 0

    let shared = 0
    for (const token of left) {
      if (right.has(token)) shared++
    }

    const shorterSize = Math.min(left.size, right.size)
    const unionSize = left.size + right.size - shared
    const containment = shorterSize === 0 ? 0 : shared / shorterSize
    const jaccard = unionSize === 0 ? 0 : shared / unionSize
    return Math.max(containment, jaccard)
  }

  private normalizeTopicText(text: string): string {
    return this.tokenizeTopic(text).join(' ')
  }

  private tokenizeTopic(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !TOPIC_STOP_WORDS.has(token))
  }

  private parseTranscriptLines(transcript: string): TranscriptLine[] {
    return transcript
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const match = line.match(/^\[(\d+):(\d+)(?::(\d+))?\]\s+(?:\[[^\]]+\]\s+)?(.+)$/)
        if (!match) return null
        const hours = match[3] !== undefined ? parseInt(match[1], 10) : 0
        const minutes = match[3] !== undefined ? parseInt(match[2], 10) : parseInt(match[1], 10)
        const seconds = match[3] !== undefined ? parseInt(match[3], 10) : parseInt(match[2], 10)
        return {
          startMs: (hours * 3600 + minutes * 60 + seconds) * 1000,
          text: match[4].trim()
        }
      })
      .filter((line): line is TranscriptLine => line !== null)
  }

  private resolveGroundedSourceRange(
    item: RawSegment,
    durationMs: number | undefined,
    transcriptTimestamps: number[] | undefined,
    transcriptLines: TranscriptLine[]
  ): SourceRange | null {
    const primary = this.resolveSourceRange(item, durationMs, transcriptTimestamps, transcriptLines)
    if (this.isGroundedItem(item, primary.startMs, primary.endMs, transcriptLines)) {
      return primary
    }

    if (process.platform === 'win32') {
      const attested = this.findAttestedQuantityRange(item, transcriptLines)
      if (attested) return attested
    }

    const proseClocks = extractProseClockMs(`${item.title ?? ''} ${item.content ?? ''}`)
    if (proseClocks.length > 0) {
      const proseItem = {
        ...item,
        sourceStartMs: proseClocks[0],
        sourceEndMs: proseClocks[proseClocks.length - 1]
      }
      const proseRange = this.resolveSourceRange(
        proseItem,
        durationMs,
        transcriptTimestamps,
        transcriptLines
      )
      if (this.isGroundedItem(item, proseRange.startMs, proseRange.endMs, transcriptLines)) {
        return proseRange
      }
    }

    const altStart = alternateClockTimestampMs(item.sourceStartMs, durationMs)
    const altEnd = alternateClockTimestampMs(item.sourceEndMs, durationMs)
    if (altStart == null && altEnd == null) return null

    const altItem = {
      ...item,
      sourceStartMs: altStart ?? item.sourceStartMs,
      sourceEndMs: altEnd ?? item.sourceEndMs
    }
    const alternate = this.resolveSourceRange(
      altItem,
      durationMs,
      transcriptTimestamps,
      transcriptLines
    )
    if (this.isGroundedItem(item, alternate.startMs, alternate.endMs, transcriptLines)) {
      return alternate
    }
    return null
  }

  private resolveSourceRange(
    item: RawSegment,
    durationMs?: number,
    transcriptTimestamps?: number[],
    transcriptLines: TranscriptLine[] = []
  ): SourceRange {
    const sourceStartMs = this.snapTimestamp(item.sourceStartMs, durationMs, transcriptTimestamps)
    const sourceEndMs = this.snapTimestamp(item.sourceEndMs, durationMs, transcriptTimestamps)
    const fallbackRange = this.usesSharedNotesWriter()
      ? {
          startMs: Math.min(sourceStartMs, sourceEndMs),
          endMs: Math.max(sourceStartMs, sourceEndMs)
        }
      : { startMs: sourceStartMs, endMs: sourceEndMs }

    if (!this.usesSharedNotesWriter() || transcriptLines.length === 0) return fallbackRange

    return this.findBestEvidenceRange(item, fallbackRange, transcriptLines) ?? fallbackRange
  }

  private findBestEvidenceRange(
    item: RawSegment,
    fallbackRange: SourceRange,
    transcriptLines: TranscriptLine[]
  ): SourceRange | null {
    const queryTokens = this.extractEvidenceTokens(
      `${item.title ?? ''} ${item.content ?? ''} ${item.assignee ?? ''} ${item.deadline ?? ''}`
    )
    if (queryTokens.size < 2) return null

    const fallbackScore = this.scoreEvidenceWindow(
      item,
      queryTokens,
      this.getTranscriptLinesForRange(fallbackRange, transcriptLines),
      fallbackRange,
      fallbackRange
    )
    let bestScore = 0
    let bestRange: SourceRange | null = null
    const maxWindowLines = Math.min(3, transcriptLines.length)

    for (let startIndex = 0; startIndex < transcriptLines.length; startIndex++) {
      for (let windowSize = 1; windowSize <= maxWindowLines; windowSize++) {
        const endIndex = startIndex + windowSize - 1
        if (endIndex >= transcriptLines.length) break

        const candidateRange = {
          startMs: transcriptLines[startIndex].startMs,
          endMs: transcriptLines[endIndex].startMs
        }
        const score = this.scoreEvidenceWindow(
          item,
          queryTokens,
          transcriptLines.slice(startIndex, endIndex + 1),
          candidateRange,
          fallbackRange
        )

        if (score > bestScore) {
          bestScore = score
          bestRange = candidateRange
        }
      }
    }

    if (!bestRange || bestScore < 2.8) return null
    if (fallbackScore > 0 && bestScore < fallbackScore * 1.08) return fallbackRange

    return bestRange
  }

  private getTranscriptLinesForRange(
    range: SourceRange,
    transcriptLines: TranscriptLine[]
  ): TranscriptLine[] {
    const startMs = Math.min(range.startMs, range.endMs)
    const endMs = Math.max(range.startMs, range.endMs)
    const matchingLines = transcriptLines.filter(
      (line) => line.startMs >= startMs && line.startMs <= endMs
    )
    if (matchingLines.length > 0) return matchingLines

    let closestLine = transcriptLines[0]
    let minDiff = Math.abs(transcriptLines[0].startMs - startMs)
    for (let index = 1; index < transcriptLines.length; index++) {
      const diff = Math.abs(transcriptLines[index].startMs - startMs)
      if (diff < minDiff) {
        minDiff = diff
        closestLine = transcriptLines[index]
      }
    }
    return [closestLine]
  }

  private scoreEvidenceWindow(
    item: RawSegment,
    queryTokens: Set<string>,
    transcriptLines: TranscriptLine[],
    candidateRange: SourceRange,
    fallbackRange: SourceRange
  ): number {
    if (transcriptLines.length === 0) return 0

    const windowText = transcriptLines.map((line) => line.text).join(' ')
    const windowTokens = this.extractEvidenceTokens(windowText)
    let shared = 0
    for (const token of queryTokens) {
      if (windowTokens.has(token)) shared++
    }
    if (shared === 0) return 0

    const queryCoverage = shared / queryTokens.size
    const density = windowTokens.size === 0 ? 0 : shared / windowTokens.size
    const quantityBonus = this.countSharedQuantities(
      `${item.title ?? ''} ${item.content ?? ''}`,
      windowText
    )
    const phraseBonus = this.getEvidencePhraseBonus(item, windowText)
    const candidateMidpoint = (candidateRange.startMs + candidateRange.endMs) / 2
    const fallbackMidpoint = (fallbackRange.startMs + fallbackRange.endMs) / 2
    const distancePenalty = Math.min(1.25, Math.abs(candidateMidpoint - fallbackMidpoint) / 240_000)
    const windowLengthPenalty = Math.max(0, transcriptLines.length - 1) * 0.45

    return (
      shared * 0.8 +
      queryCoverage * 4 +
      density * 2 +
      quantityBonus * 1.5 +
      phraseBonus -
      distancePenalty -
      windowLengthPenalty
    )
  }

  private extractEvidenceTokens(text: string): Set<string> {
    return new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9$%.\s]/g, ' ')
        .split(/\s+/)
        .map((token) => this.normalizeEvidenceToken(token))
        .filter((token) => token.length >= 4 && !TOPIC_STOP_WORDS.has(token))
    )
  }

  private normalizeEvidenceToken(token: string): string {
    const normalized = token.trim().replace(/^[^a-z0-9$]+|[^a-z0-9%]+$/g, '')
    if (/^\$?\d/.test(normalized)) return normalized
    if (normalized.endsWith('ing') && normalized.length > 6) return normalized.slice(0, -3)
    if (normalized.endsWith('ed') && normalized.length > 5) return normalized.slice(0, -2)
    if (normalized.endsWith('es') && normalized.length > 5) return normalized.slice(0, -2)
    if (normalized.endsWith('s') && normalized.length > 5) return normalized.slice(0, -1)
    return normalized
  }

  private countSharedQuantities(summaryText: string, windowText: string): number {
    const windowQuantities = new Set(this.extractQuantityTokens(windowText))
    return this.extractQuantityTokens(summaryText).filter((token) => windowQuantities.has(token))
      .length
  }

  private getEvidencePhraseBonus(item: RawSegment, windowText: string): number {
    const normalizedWindow = this.normalizeEvidencePhrase(windowText)
    const phrases = [item.title, item.content]
      .map((text) => this.normalizeEvidencePhrase(String(text ?? '')))
      .filter((text) => text.length >= 18)

    let bonus = 0
    for (const phrase of phrases) {
      const phraseTokens = phrase.split(/\s+/).filter(Boolean)
      for (let size = Math.min(5, phraseTokens.length); size >= 3; size--) {
        const matching = phraseTokens.some((_token, index) => {
          const candidate = phraseTokens.slice(index, index + size).join(' ')
          return candidate.split(/\s+/).length === size && normalizedWindow.includes(candidate)
        })
        if (matching) {
          bonus += size * 0.35
          break
        }
      }
    }
    return bonus
  }

  private normalizeEvidencePhrase(text: string): string {
    return Array.from(this.extractEvidenceTokens(text)).join(' ')
  }

  private isGroundedItem(
    item: RawSegment,
    sourceStartMs: number,
    sourceEndMs: number,
    transcriptLines: TranscriptLine[]
  ): boolean {
    if (transcriptLines.length === 0) return true

    const evidenceText = this.collectEvidenceText(sourceStartMs, sourceEndMs, transcriptLines)
    if (!evidenceText) return false

    const summaryText = `${String(item.title ?? '')} ${String(item.content ?? '')}`.trim()
    if (LOW_SIGNAL_NOTE_PATTERNS.some((pattern) => pattern.test(summaryText))) {
      return false
    }
    const summaryQuantities = this.extractQuantityTokens(summaryText)
    if (summaryQuantities.length > 0) {
      const evidenceQuantities = new Set(this.extractQuantityTokens(evidenceText))
      if (summaryQuantities.some((token) => !evidenceQuantities.has(token))) {
        return false
      }
    }
    return true
  }

  private findAttestedQuantityRange(
    item: RawSegment,
    transcriptLines: TranscriptLine[]
  ): SourceRange | null {
    if (transcriptLines.length === 0) return null
    const summaryQuantities = [
      ...new Set(this.extractQuantityTokens(`${item.title ?? ''} ${item.content ?? ''}`))
    ]
    if (summaryQuantities.length === 0) return null
    const transcriptQuantities = new Set(
      this.extractQuantityTokens(transcriptLines.map((line) => line.text).join(' '))
    )
    const required = summaryQuantities.filter((token) => transcriptQuantities.has(token))
    if (required.length === 0) return null

    const maxWindowLines = Math.min(6, transcriptLines.length)
    const minCoverage = Math.min(2, required.length)
    let bestRange: SourceRange | null = null
    let bestCoverage = 0
    let bestSize = Number.POSITIVE_INFINITY
    for (let startIndex = 0; startIndex < transcriptLines.length; startIndex++) {
      for (let windowSize = 1; windowSize <= maxWindowLines; windowSize++) {
        const endIndex = startIndex + windowSize - 1
        if (endIndex >= transcriptLines.length) break
        const windowText = transcriptLines
          .slice(startIndex, endIndex + 1)
          .map((line) => line.text)
          .join(' ')
        const windowQuantities = new Set(this.extractQuantityTokens(windowText))
        const coverage = required.filter((token) => windowQuantities.has(token)).length
        if (coverage < minCoverage) continue
        if (coverage < bestCoverage || (coverage === bestCoverage && windowSize >= bestSize)) {
          continue
        }
        bestCoverage = coverage
        bestSize = windowSize
        bestRange = {
          startMs: transcriptLines[startIndex].startMs,
          endMs: transcriptLines[endIndex].startMs
        }
        if (coverage === required.length) break
      }
    }
    return bestRange
  }

  private collectEvidenceText(
    sourceStartMs: number,
    sourceEndMs: number,
    transcriptLines: TranscriptLine[]
  ): string {
    if (transcriptLines.length === 0) return ''

    const startMs = Math.min(sourceStartMs, sourceEndMs)
    const endMs = Math.max(sourceStartMs, sourceEndMs)
    const matchingIndexes = transcriptLines
      .map((line, index) => (line.startMs >= startMs && line.startMs <= endMs ? index : -1))
      .filter((index) => index >= 0)

    if (matchingIndexes.length === 0) {
      let closestIndex = 0
      let minDiff = Math.abs(transcriptLines[0].startMs - startMs)
      for (let i = 1; i < transcriptLines.length; i++) {
        const diff = Math.abs(transcriptLines[i].startMs - startMs)
        if (diff < minDiff) {
          minDiff = diff
          closestIndex = i
        }
      }
      return transcriptLines
        .slice(Math.max(0, closestIndex - 1), Math.min(transcriptLines.length, closestIndex + 2))
        .map((line) => line.text)
        .join(' ')
    }

    const first = Math.max(0, matchingIndexes[0] - 1)
    const last = Math.min(transcriptLines.length, matchingIndexes[matchingIndexes.length - 1] + 2)
    return transcriptLines
      .slice(first, last)
      .map((line) => line.text)
      .join(' ')
  }
  private extractQuantityTokens(text: string): string[] {
    let lower = text.toLowerCase()
    if (process.platform === 'win32') {
      lower = lower.replace(/\bv\d+\b/g, ' ')
    }
    for (const [phrase, digit] of Object.entries(SPOKEN_COMPOUND_QUANTITIES)) {
      lower = lower.replace(new RegExp(phrase, 'g'), ` ${digit} `)
    }
    lower = lower.replace(/one\s+dot\s+one\s+dot\s+three/g, ' 1 1 3 ')
    lower = lower.replace(/one\s+dot\s+one\s+dot\s+two/g, ' 1 1 2 ')
    lower = lower.replace(/\bfour\s+three\s+five\b/g, ' 4 3 5 ')
    lower = lower.replace(/\b(\d+)\.(\d+)\.(\d+)\b/g, ' $1 $2 $3 ')
    const digits = (lower.match(/[$€£]?\d+(?:[.,]\d+)?%?/g) ?? []).map((token) => token.toLowerCase())
    const words: string[] = []
    for (const [word, digit] of Object.entries(SPOKEN_QUANTITY_WORDS)) {
      if (new RegExp(`\\b${word}\\b`).test(lower)) words.push(digit)
    }
    return [...digits, ...words]
  }

  /** Extract all timestamp positions (in ms) from transcript lines like [02:30] or [01:05:30] */
  private extractTimestampsMs(transcript: string): number[] {
    const timestamps: number[] = []
    const regex = /\[(\d+):(\d+)(?::(\d+))?\]/g
    let match
    while ((match = regex.exec(transcript)) !== null) {
      if (match[3] !== undefined) {
        // HH:MM:SS
        timestamps.push(
          (parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseInt(match[3])) * 1000
        )
      } else {
        // MM:SS
        timestamps.push((parseInt(match[1]) * 60 + parseInt(match[2])) * 1000)
      }
    }
    return timestamps
  }

  /** Snap an LLM-generated timestamp to the nearest real transcript timestamp */
  private snapTimestamp(value: unknown, maxMs?: number, transcriptTimestamps?: number[]): number {
    let ms = salvageWriterTimestampMs(value, maxMs)
    if (ms < 0) ms = 0
    if (maxMs && ms > maxMs) ms = maxMs

    if (!transcriptTimestamps || transcriptTimestamps.length === 0) return ms

    // Find the closest real timestamp
    let closest = transcriptTimestamps[0]
    let minDiff = Math.abs(ms - closest)
    for (let i = 1; i < transcriptTimestamps.length; i++) {
      const diff = Math.abs(ms - transcriptTimestamps[i])
      if (diff < minDiff) {
        minDiff = diff
        closest = transcriptTimestamps[i]
      }
    }
    return closest
  }
}
