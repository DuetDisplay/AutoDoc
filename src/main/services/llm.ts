import type { MeetingSegments, Segment, SegmentCategory } from '../../shared/types'
import { logAutodocEvent } from './autodoc-log'
import { captureMessage } from './sentry-reporter'

export interface LLMProvider {
  summarize(
    meetingId: string,
    transcript: string,
    onProgress?: (percent: number) => void,
    durationMinutes?: number
  ): Promise<MeetingSegments>
  checkConnection(): Promise<boolean>
  abortActiveRequests?(reason?: string): void
}

const MAX_RETRIES = 2
export const STANDARD_CONTEXT_TOKENS = 32768 // Request 32K context from Ollama
export const WINDOWS_CONTEXT_TOKENS = 8192
export const LOW_MEMORY_CONTEXT_TOKENS = 4096
const CHUNK_CHARS = 4000 // ~1K tokens per chunk — keeps output quality high with 8B models
const STREAM_TIMEOUT_MS = 120_000 // Abort if no token received for 2 minutes
const REQUEST_TIMEOUT_MS = 300_000 // 5 minute timeout for entire request
const MAX_OUTPUT_TOKENS = 8192 // Safety cap — model should stop naturally when JSON is complete
const LOW_MEMORY_FREE_GIB_THRESHOLD = 8
const LOW_MEMORY_TOTAL_GIB_THRESHOLD = 14
const MAX_UNIQUE_TOPICS = 6
const TOPIC_MERGE_THRESHOLD = 0.52
const TOPIC_SINGLETON_MERGE_THRESHOLD = 0.28
const IS_TEST_RUNTIME = process.env.NODE_ENV === 'test' || process.env.AUTODOC_TEST_MODE === '1'
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

HOW TO PICK TOPICS: Before writing items, identify the 3-5 major subjects discussed in this meeting. Use those as your only topic values. Every item must map to one of them.

GOOD topics (broad, each grouping many items):
- "Pricing & Costs" — groups: setup fees, per-device costs, update charges, discount tiers, billing terms
- "Technical Architecture" — groups: infrastructure, deployment, security, integrations, performance
- "Project Timeline" — groups: milestones, deadlines, dependencies, launch date, phases

BAD topics (too specific, essentially restating the item title):
- "Image Pricing", "Image Creation", "Image Updates", "Chrome Browser" — these should ALL be under ONE topic like "Device Imaging"
- "Q1 Revenue", "Q2 Forecast", "Budget Cuts" — these should ALL be under "Financial Planning"

TIMESTAMPS — The transcript includes timestamps like [00:12] or [01:05:30] at the start of each line. For EVERY item, you MUST set "sourceStartMs" and "sourceEndMs" to the timestamps in milliseconds from the transcript lines the item is based on. Convert: [02:30] = 150000, [01:05:30] = 3930000. Use the timestamp of the first relevant line for sourceStartMs and the last relevant line for sourceEndMs. Every item must have non-zero timestamps.

Respond with ONLY valid JSON (no markdown, no explanation):
{
  "decisions": [{ "topic": "broad theme", "title": "clear summary", "content": "concise explanation of what was decided and why", "assignee": null, "deadline": null, "sourceStartMs": 12000, "sourceEndMs": 45000 }],
  "action_items": [{ "topic": "broad theme", "title": "specific task", "content": "what needs to happen, who owns it, and by when", "assignee": "person or null", "deadline": "deadline or null", "sourceStartMs": 12000, "sourceEndMs": 45000 }],
  "information": [{ "topic": "broad theme", "title": "what was shared", "content": "synthesized summary with key details and numbers", "assignee": null, "deadline": null, "sourceStartMs": 12000, "sourceEndMs": 45000 }],
  "discussion": [{ "topic": "broad theme", "title": "topic debated", "content": "summary of positions, arguments, and outcome if any", "assignee": null, "deadline": null, "sourceStartMs": 12000, "sourceEndMs": 45000 }],
  "status_updates": [{ "topic": "broad theme", "title": "what was reported", "content": "current state, blockers, and next steps", "assignee": null, "deadline": null, "sourceStartMs": 12000, "sourceEndMs": 45000 }]
}

If a category has no items, use an empty array. Every item MUST have topic, title, and content fields.`

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

interface TopicGroup {
  segments: Segment[]
  labelCounts: Map<string, number>
}

type OllamaContextProfile = 'standard' | 'windows-balanced' | 'low-memory'

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

  constructor(baseUrl: string, model: string, options: OllamaProviderOptions = {}) {
    this.baseUrl = baseUrl
    this.model = model
    this.onTelemetry = options.onTelemetry
    this.setInitialContextProfile()
  }

  setModel(model: string): void {
    this.model = model
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

  private setInitialContextProfile(): void {
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
    // Scale: ~1 item per minute, min 5, no max
    const minItems = Math.max(5, Math.round(estMinutes * 0.8))
    const maxItems = Math.round(estMinutes * 1.5)
    return `This is roughly a ${estMinutes}-minute meeting. Aim for ${minItems}-${maxItems} items total across all categories — approximately 1 item per minute of meeting.`
  }

  async summarize(
    meetingId: string,
    transcript: string,
    onProgress?: (percent: number) => void,
    durationMinutes?: number
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

    const merged: MeetingSegments = {
      decisions: [],
      actionItems: [],
      information: [],
      discussion: [],
      statusUpdates: []
    }

    let avgTokensPerChunk = 2000
    let totalTokensSoFar = 0

    for (let i = 0; i < chunks.length; i++) {
      const chunkTranscriptLines = this.parseTranscriptLines(chunks[i])
      const chunkItemMin = Math.max(2, Math.round((estMinutes * 0.8) / chunks.length))
      const chunkItemMax = Math.max(5, Math.round((estMinutes * 1.5) / chunks.length))
      const knownTopics = this.extractKnownTopics(merged)
      const chunkLabel =
        chunks.length > 1
          ? `\n\nThis is part ${i + 1} of ${chunks.length} of the meeting. Extract only the noteworthy items from THIS section (expect ${chunkItemMin}-${chunkItemMax} items from this part). Be concise. ${itemGuidance}${knownTopics.length > 0 ? ` Reuse these exact topic strings whenever they fit instead of inventing a new one: ${knownTopics.join('; ')}.` : ''}`
          : `\n\n${itemGuidance}`

      let lastError: Error | null = null
      let chunkResult: MeetingSegments | null = null
      let chunkTokens = 0

      let attempt = 0
      while (attempt <= MAX_RETRIES) {
        chunkTokens = 0
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
          const raw = await this.callOllama(chunks[i] + chunkLabel, this.contextTokens, () => {
            chunkTokens++
            // Asymptotic progress: approaches 0.99 but never reaches it, so it never appears stuck
            const ratio = chunkTokens / avgTokensPerChunk
            const chunkFraction =
              ratio <= 1 ? ratio * 0.8 : 0.8 + 0.19 * (1 - 1 / (1 + (ratio - 1)))
            const percent = Math.min(99, Math.round(((i + chunkFraction) / chunks.length) * 100))
            onProgress?.(percent)
          })
          console.log(`Chunk ${i + 1}/${chunks.length} complete (${chunkTokens} tokens)`)
          chunkResult = this.parseResponse(
            meetingId,
            raw,
            merged,
            durationMs,
            transcriptTimestamps,
            chunkTranscriptLines
          )
          break
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err))
          console.error(`Chunk ${i + 1}/${chunks.length} failed:`, lastError.message)
          if (lastError.message === 'SEGMENTATION_PREEMPTED') {
            throw lastError
          }
          if (
            this.isInsufficientSystemMemoryError(lastError.message) &&
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
          if (attempt < MAX_RETRIES) {
            attempt++
            continue
          }
          attempt++
        }
      }

      if (!chunkResult) {
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

      const percent = Math.min(99, Math.round(((i + 1) / chunks.length) * 100))
      onProgress?.(percent)
    }

    this.normalizeMergedTopics(merged)
    if (lowMemoryFallbackActivated) {
      this.recordLowMemoryFallbackEvent('ollama_low_memory_fallback_succeeded', meetingId, null, {
        chunkCount: chunks.length,
        transcriptChars: transcript.length,
        durationMinutes: estMinutes
      })
    }
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
    if (transcript.length <= CHUNK_CHARS) return [transcript]

    const lines = transcript.split('\n')
    const chunks: string[] = []
    let current = ''

    for (const line of lines) {
      if (current.length + line.length + 1 > CHUNK_CHARS && current.length > 0) {
        chunks.push(current)
        current = ''
      }
      current += (current ? '\n' : '') + line
    }
    if (current) chunks.push(current)

    return chunks
  }

  private async callOllama(
    transcript: string,
    contextTokens: number,
    onToken?: () => void
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

    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: `Here is the meeting transcript:\n\n${transcript}` }
          ],
          stream: true,
          format: 'json',
          options: {
            num_ctx: contextTokens,
            num_predict: MAX_OUTPUT_TOKENS,
            temperature: 0,
            repeat_penalty: 1.3
          }
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
        const streamTimeout = new Promise<never>((_, reject) => {
          streamTimer = setTimeout(
            () =>
              reject(
                new Error(`Ollama stream timed out after ${STREAM_TIMEOUT_MS / 1000}s with no data`)
              ),
            STREAM_TIMEOUT_MS
          )
        })
        let readResult: ReadableStreamReadResult<Uint8Array>
        try {
          readResult = await Promise.race([reader.read(), streamTimeout])
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
              message?: { content?: string }
              error?: string
              done?: boolean
            }
            if (data.error) throw new Error(`Ollama error: ${data.error}`)
            if (data.message?.content) {
              content += data.message.content
              onToken?.()
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
          const data = JSON.parse(buffer) as { message?: { content?: string }; error?: string }
          if (data.error) throw new Error(`Ollama error: ${data.error}`)
          if (data.message?.content) {
            content += data.message.content
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
    const strategies = [
      // Strategy 1: cut at last complete array item "},"
      () => {
        const idx = raw.lastIndexOf('},')
        if (idx === -1) return null
        return this.closeJSON(raw.slice(0, idx + 1))
      },
      // Strategy 2: cut at last complete array "]"
      () => {
        const idx = raw.lastIndexOf(']')
        if (idx === -1) return null
        return this.closeJSON(raw.slice(0, idx + 1))
      },
      // Strategy 3: cut at last complete key-value with empty array
      () => {
        const idx = raw.lastIndexOf('[]')
        if (idx === -1) return null
        return this.closeJSON(raw.slice(0, idx + 2))
      }
    ]

    for (const strategy of strategies) {
      const cut = strategy()
      if (!cut) continue
      try {
        return JSON.parse(cut)
      } catch {
        continue
      }
    }

    return null
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
    let parsed: Record<string, RawSegment[]>
    try {
      parsed = JSON.parse(raw)
    } catch {
      // Attempt to repair truncated JSON (from num_predict cap)
      const repaired = this.repairTruncatedJSON(raw)
      if (repaired) {
        parsed = repaired
        console.warn('Repaired truncated JSON from Ollama (some items may have been dropped)')
      } else {
        throw new Error(`Invalid JSON from Ollama: ${raw.slice(0, 200)}`)
      }
    }

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
        if (!item.title || !item.content) continue
        const titleKey = String(item.title).toLowerCase().trim()
        // Skip duplicates (same title within this chunk or across chunks)
        if (seenTitles.has(titleKey) || existingTitles.has(titleKey)) continue
        const sourceStartMs = this.snapTimestamp(
          item.sourceStartMs,
          durationMs,
          scopedTranscriptTimestamps
        )
        const sourceEndMs = this.snapTimestamp(
          item.sourceEndMs,
          durationMs,
          scopedTranscriptTimestamps
        )
        if (!this.isGroundedItem(item, sourceStartMs, sourceEndMs, transcriptLines)) continue
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
          sourceStartMs,
          sourceEndMs
        })
        index++
      }
    }

    return result
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
    return (text.match(/[$€£]?\d+(?:[.,]\d+)?%?/g) ?? []).map((token) => token.toLowerCase())
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
    let ms = typeof value === 'number' ? value : 0
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
