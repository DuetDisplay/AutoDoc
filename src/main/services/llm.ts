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
  setModel?(model: string): void
  setLowMemoryMode?(enabled: boolean): void
  releaseResources?(meetingId?: string): Promise<void>
}

const MAX_RETRIES = 2
export const STANDARD_CONTEXT_TOKENS = 32768 // Request 32K context from Ollama
export const WINDOWS_CONTEXT_TOKENS = 8192
export const LOW_MEMORY_CONTEXT_TOKENS = 4096
export const MAC_CONTEXT_TOKENS = LOW_MEMORY_CONTEXT_TOKENS
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
const PRICING_TOPIC_SIGNAL =
  /\b(pric(?:e|es|ing)|costs?|revenue|billing|currency|currencies|moneti[sz]ation|subscription|subscriptions?|paid|paywall|dollars?|usd|\$)\b/i
const MAC_TOPIC_FAMILIES: Array<{ topic: string; pattern: RegExp }> = [
  {
    topic: 'Pricing & Costs',
    pattern:
      /\b(pric(?:e|es|ing)|costs?|revenue|billing|currency|currencies|moneti[sz]ation|subscription|subscriptions?|paid|paywall|dollars?|usd|\$|ad|ads|campaign|conversion|tracking|attribution|user value|metric|analytics|data|rate|rates|split|baseline|vlp|encoder|cancellations?)\b/i
  },
  {
    topic: 'Release Planning',
    pattern:
      /\b(release|qa|test|testing|build|rollout|ship|timing|today|tomorrow|panic|ready|readiness)\b/i
  },
  {
    topic: 'Technical Deployment',
    pattern:
      /\b(deploy|deployment|config|periscope|service|services|integration|integrate|channel|editor|intercom)\b/i
  },
  {
    topic: 'Technical Architecture',
    pattern:
      /\b(api|virtual display|native|interface|platform|capabilities|architecture|windows|mac|ios|desktop|hover|stylus|mouse|touch|scaling|viewer|device)\b/i
  },
  {
    topic: 'Technical Behavior',
    pattern:
      /\b(scroll|scrolling|behavior|behaviour|local computer|remote|mirror|reversed|natural|complaint|complaints|latency|performance|android|apple)\b/i
  },
  {
    topic: 'Technical Changes',
    pattern:
      /\b(retina|resolution|setting|settings|feature flag|feature flags|local discovery|feature|bug|bugs|issue|issues|implementation|implement|modify|modification|down.?sampling|pixelation|code|pr)\b/i
  },
  {
    topic: 'Project Planning',
    pattern:
      /\b(documentation|docs|prioritize|priority|plan|planning|follow.?up|estimate|ownership|assign|task|refactor|discussion)\b/i
  }
]
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

const MAC_NOTES_PROMPT_SUFFIX = `

MAC QUALITY TUNING OVERRIDE:
- Match the baseline AutoDoc note style: useful, complete, and scan-friendly, but not exhaustive.
- Target roughly 40-55 total final items for a normal-length product or engineering huddle.
- A topic is a broad chapter heading for the meeting, not a restatement of one item title.
- Reuse broad topic labels across chunks and categories whenever they fit.
- Do not create a new topic for a single feature, status update, person update, bug, customer complaint, or implementation detail unless it is truly a major new subject.
- Avoid near-duplicate topic labels. For example, do not split release-related notes across both "Release Timing" and "Release Plan".
- Do not use "Pricing & Costs" unless the underlying item is actually about price, cost, revenue, billing, currency, or monetization.
- Decisions require an explicit choice, approval, rejection, or agreed direction. Do not classify general discussion, concern, or preference as a decision.
- Action items require a clear next step, owner, request, or follow-up. Do not turn vague possibilities into tasks.
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

type OllamaContextProfile = 'standard' | 'windows-balanced' | 'mac-balanced' | 'low-memory'

interface OllamaCallMetrics {
  totalDurationMs?: number
  loadDurationMs?: number
  promptEvalCount?: number
  promptEvalDurationMs?: number
  evalCount?: number
  evalDurationMs?: number
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
  private lastOllamaCallMetrics: OllamaCallMetrics | null = null

  constructor(baseUrl: string, model: string, options: OllamaProviderOptions = {}) {
    this.baseUrl = baseUrl
    this.model = model
    this.onTelemetry = options.onTelemetry
    this.setInitialContextProfile()
  }

  setModel(model: string): void {
    this.model = model
  }

  setLowMemoryMode(enabled: boolean): void {
    if (enabled) {
      this.contextProfile = 'low-memory'
      this.contextTokens = LOW_MEMORY_CONTEXT_TOKENS
      return
    }

    if (process.platform === 'win32') {
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
    if (process.platform === 'darwin') {
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
    logAutodocEvent({
      area: 'segmentation',
      message: 'notes llm summarize started',
      meetingId,
      context: {
        model: this.model,
        contextProfile: this.contextProfile,
        contextTokens: this.contextTokens,
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

    for (let i = 0; i < chunks.length; i++) {
      const chunkTranscriptLines = this.parseTranscriptLines(chunks[i])
      const knownTopics = this.extractKnownTopics(merged)
      const chunkLabel = this.buildChunkLabel(i, chunks.length, itemGuidance, knownTopics)

      let lastError: Error | null = null
      let chunkResult: MeetingSegments | null = null
      let chunkTokens = 0

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
              ollamaMetrics: this.lastOllamaCallMetrics
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
              error: lastError.message
            }
          })
          if (lastError.message === 'SEGMENTATION_PREEMPTED') {
            throw lastError
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
    this.consolidateMacTopicFamilies(merged)
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
        itemCount: this.flattenSegments(merged).length
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
    const chunkChars = this.getChunkChars()
    if (transcript.length <= chunkChars) return [transcript]

    const lines = transcript.split('\n')
    const chunks: string[] = []
    let current = ''

    for (const line of lines) {
      if (current.length + line.length + 1 > chunkChars && current.length > 0) {
        chunks.push(current)
        current = ''
      }
      current += (current ? '\n' : '') + line
    }
    if (current) chunks.push(current)

    return chunks
  }

  private getChunkChars(): number {
    return CHUNK_CHARS
  }

  private getSystemPrompt(): string {
    if (process.platform === 'darwin') {
      return `${SYSTEM_PROMPT}${MAC_NOTES_PROMPT_SUFFIX}`
    }

    return SYSTEM_PROMPT
  }

  private buildChunkLabel(
    chunkIndex: number,
    chunkCount: number,
    itemGuidance: string,
    knownTopics: string[]
  ): string {
    const knownTopicGuidance =
      knownTopics.length > 0
        ? ` Reuse these exact topic strings whenever they fit instead of inventing a new one: ${knownTopics.join('; ')}.`
        : ''

    if (chunkCount <= 1) {
      return `\n\n${itemGuidance}${knownTopicGuidance}`
    }

    if (process.platform === 'darwin') {
      return `\n\nThis is part ${chunkIndex + 1} of ${chunkCount} of the meeting. Extract only the strongest NEW notes from this section, at most 6 total items across all categories. Use broad reusable topic headings, not per-item headings. Do not create a new topic unless this section introduces a genuinely new major subject. Empty arrays are preferred for repeated or weak content.${knownTopicGuidance}`
    }

    return `\n\nThis is part ${chunkIndex + 1} of ${chunkCount} of the meeting. Extract only the noteworthy items from THIS section. Be concise. ${itemGuidance}${knownTopicGuidance}`
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

    const requestStartedAt = Date.now()
    this.lastOllamaCallMetrics = null

    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: this.getSystemPrompt() },
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
              this.lastOllamaCallMetrics = this.normalizeOllamaMetrics(data, requestStartedAt)
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
          }
          if (data.done) {
            this.lastOllamaCallMetrics = this.normalizeOllamaMetrics(data, requestStartedAt)
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
    },
    requestStartedAt: number
  ): OllamaCallMetrics {
    const nsToMs = (value?: number): number | undefined =>
      typeof value === 'number' ? Math.round(value / 1_000_000) : undefined

    return {
      totalDurationMs: nsToMs(data.total_duration) ?? Date.now() - requestStartedAt,
      loadDurationMs: nsToMs(data.load_duration),
      promptEvalCount: data.prompt_eval_count,
      promptEvalDurationMs: nsToMs(data.prompt_eval_duration),
      evalCount: data.eval_count,
      evalDurationMs: nsToMs(data.eval_duration)
    }
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
        const sourceRange = this.resolveSourceRange(
          item,
          durationMs,
          scopedTranscriptTimestamps,
          transcriptLines
        )
        if (!this.isGroundedItem(item, sourceRange.startMs, sourceRange.endMs, transcriptLines)) {
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

  private consolidateMacTopicFamilies(segments: MeetingSegments): void {
    if (process.platform !== 'darwin') return

    for (const segment of this.flattenSegments(segments)) {
      const topic = this.inferMacTopicFamily(segment)
      if (topic) {
        segment.topic = topic
      }
    }
  }

  private inferMacTopicFamily(segment: Segment): string | null {
    const text = `${segment.title} ${segment.content}`
    for (const family of MAC_TOPIC_FAMILIES) {
      if (family.pattern.test(text)) {
        return family.topic
      }
    }

    return segment.topic
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
      if (process.platform === 'darwin') {
        const aUnsupported = this.isUnsupportedMacTopicCandidate(a[0], group)
        const bUnsupported = this.isUnsupportedMacTopicCandidate(b[0], group)
        if (aUnsupported !== bUnsupported) return aUnsupported ? 1 : -1
      }

      if (b[1] !== a[1]) return b[1] - a[1]

      const aWords = this.tokenizeTopic(a[0]).length
      const bWords = this.tokenizeTopic(b[0]).length
      if (aWords !== bWords) return aWords - bWords

      if (a[0].length !== b[0].length) return a[0].length - b[0].length
      return a[0].localeCompare(b[0])
    })

    return candidates[0]?.[0] ?? 'General'
  }

  private isUnsupportedMacTopicCandidate(topic: string, group: TopicGroup): boolean {
    if (this.normalizeTopicText(topic) !== 'pricing costs') {
      return false
    }

    const supportedItems = group.segments.filter((segment) =>
      PRICING_TOPIC_SIGNAL.test(`${segment.title} ${segment.content}`)
    ).length
    const supportRatio = supportedItems / Math.max(1, group.segments.length)
    return supportRatio < 0.35
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

  private resolveSourceRange(
    item: RawSegment,
    durationMs?: number,
    transcriptTimestamps?: number[],
    transcriptLines: TranscriptLine[] = []
  ): SourceRange {
    const sourceStartMs = this.snapTimestamp(item.sourceStartMs, durationMs, transcriptTimestamps)
    const sourceEndMs = this.snapTimestamp(item.sourceEndMs, durationMs, transcriptTimestamps)
    const fallbackRange =
      process.platform === 'darwin'
        ? {
            startMs: Math.min(sourceStartMs, sourceEndMs),
            endMs: Math.max(sourceStartMs, sourceEndMs)
          }
        : { startMs: sourceStartMs, endMs: sourceEndMs }

    if (process.platform !== 'darwin' || transcriptLines.length === 0) return fallbackRange

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
