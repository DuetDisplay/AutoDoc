import type { MeetingSegments, SegmentCategory } from '../../shared/types'

export interface LLMProvider {
  summarize(meetingId: string, transcript: string, onProgress?: (percent: number) => void, durationMinutes?: number): Promise<MeetingSegments>
  checkConnection(): Promise<boolean>
}

const MAX_RETRIES = 2
const TARGET_CONTEXT_TOKENS = 32768 // Request 32K context from Ollama
const CHUNK_CHARS = 6000 // ~1.5K tokens per chunk — small enough for thorough extraction
const STREAM_TIMEOUT_MS = 120_000 // Abort if no token received for 2 minutes
const REQUEST_TIMEOUT_MS = 300_000 // 5 minute timeout for entire request
const MAX_OUTPUT_TOKENS = 8192 // Cap generation length to prevent infinite loops

const SYSTEM_PROMPT = `You are a thorough meeting notes assistant. Your job is to capture everything of value from the transcript. People rely on these notes to remember what happened.

FILTERING — Skip content that is NOT part of the actual meeting:
- Background audio, music, videos playing before/after the meeting
- Casual greetings, small talk, "can you hear me?", technical setup chatter
- Filler conversation while waiting for people to join
- Content clearly from a different source (e.g. a YouTube video, podcast, or news broadcast playing in the background)
Only extract notes from the actual substantive meeting discussion.

Extract and categorize into these 5 categories:

1. **decisions** — Any decision made, even small ones. Include who decided and the reasoning.
2. **action_items** — Every task, follow-up, or commitment mentioned. Include who owns it and any deadline.
3. **information** — Facts, numbers, data, updates, context shared. Capture specific details (names, figures, dates, URLs).
4. **discussion** — Debates, disagreements, open questions, alternatives considered, pros/cons discussed.
5. **status_updates** — Progress reports, blockers, what's done, what's in progress, what's next.

Guidelines:
- Extract every distinct point — aim for roughly 1 item per minute of meeting across all categories.
- Each item should capture the full context so someone who wasn't in the meeting understands it.
- ACCURACY IS CRITICAL: Use the exact words, numbers, and timeframes from the transcript. Do NOT paraphrase numbers, dates, or quantities — quote them directly. If someone says "per year", write "per year", not "per month".
- Include specific names, numbers, dates, and technical details — don't generalize or round.
- If someone says "I'll do X by Friday", that's an action item with an assignee and deadline.
- If someone shares a metric or fact, that's information — capture the exact number as stated.
- When in doubt about which category, include it in the most relevant one.
- When in doubt about a detail, use the EXACT phrasing from the transcript rather than rewording it.
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

TIMESTAMPS — The transcript includes timestamps like [00:12] or [01:05:30] at the start of each line. For each item, set "sourceStartMs" and "sourceEndMs" to the approximate start and end timestamps in milliseconds. Convert the timestamp format to milliseconds (e.g., [02:30] = 150000ms, [01:05:30] = 3930000ms). If unsure, use 0.

Respond with ONLY valid JSON (no markdown, no explanation):
{
  "decisions": [{ "topic": "broad theme", "title": "clear summary", "content": "full context with names and reasoning", "assignee": null, "deadline": null, "sourceStartMs": 12000, "sourceEndMs": 45000 }],
  "action_items": [{ "topic": "broad theme", "title": "specific task", "content": "full detail of what needs to happen", "assignee": "person or null", "deadline": "deadline or null", "sourceStartMs": 12000, "sourceEndMs": 45000 }],
  "information": [{ "topic": "broad theme", "title": "what was shared", "content": "exact details, numbers, and context", "assignee": null, "deadline": null, "sourceStartMs": 12000, "sourceEndMs": 45000 }],
  "discussion": [{ "topic": "broad theme", "title": "topic debated", "content": "positions taken, arguments made, outcome if any", "assignee": null, "deadline": null, "sourceStartMs": 12000, "sourceEndMs": 45000 }],
  "status_updates": [{ "topic": "broad theme", "title": "what was reported", "content": "current state, blockers, next steps", "assignee": null, "deadline": null, "sourceStartMs": 12000, "sourceEndMs": 45000 }]
}

If a category has no items, use an empty array. Every item MUST have topic, title, and content fields.`

interface OllamaResponse {
  message?: { content?: string }
  error?: string
}

interface RawSegment {
  topic?: string
  title?: string
  content?: string
  assignee?: string | null
  deadline?: string | null
  sourceStartMs?: number
  sourceEndMs?: number
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

const CATEGORY_MAP: Record<string, SegmentCategory> = {
  decisions: 'decision',
  action_items: 'action_item',
  information: 'information',
  discussion: 'discussion',
  status_updates: 'status_update',
}

export class OllamaProvider implements LLMProvider {
  private baseUrl: string
  private model: string

  constructor(baseUrl: string, model: string) {
    this.baseUrl = baseUrl
    this.model = model
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
        signal: AbortSignal.timeout(3000),
      })
      return res.ok
    } catch {
      return false
    }
  }

  private estimateItemCount(durationMinutes: number): string {
    const estMinutes = Math.max(5, Math.round(durationMinutes))
    // Scale: ~1 item per minute, min 5, no max
    const minItems = Math.max(5, Math.round(estMinutes * 0.8))
    const maxItems = Math.round(estMinutes * 1.5)
    return `This is roughly a ${estMinutes}-minute meeting. Aim for ${minItems}-${maxItems} items total across all categories — approximately 1 item per minute of meeting.`
  }

  async summarize(meetingId: string, transcript: string, onProgress?: (percent: number) => void, durationMinutes?: number): Promise<MeetingSegments> {
    const chunks = this.chunkTranscript(transcript)
    const estMinutes = durationMinutes ?? Math.max(5, Math.round(transcript.length / 750))
    const itemGuidance = this.estimateItemCount(estMinutes)
    console.log(`Processing transcript in ${chunks.length} chunk(s) (${transcript.length} chars total). ${itemGuidance}`)

    const merged: MeetingSegments = {
      decisions: [],
      actionItems: [],
      information: [],
      discussion: [],
      statusUpdates: [],
    }

    let avgTokensPerChunk = 2000
    let totalTokensSoFar = 0

    for (let i = 0; i < chunks.length; i++) {
      const chunkLabel = chunks.length > 1
        ? `\n\nThis is part ${i + 1} of ${chunks.length} of the meeting. Extract ALL noteworthy items from this section. ${itemGuidance}`
        : `\n\n${itemGuidance}`

      let lastError: Error | null = null
      let chunkResult: MeetingSegments | null = null
      let chunkTokens = 0

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        chunkTokens = 0
        try {
          if (attempt > 0) console.log(`Chunk ${i + 1}/${chunks.length} retry ${attempt}/${MAX_RETRIES}`)
          else console.log(`Processing chunk ${i + 1}/${chunks.length} (${chunks[i].length} chars)...`)
          const raw = await this.callOllama(chunks[i] + chunkLabel, () => {
            chunkTokens++
            const chunkFraction = Math.min(chunkTokens / avgTokensPerChunk, 0.95)
            const percent = Math.min(99, Math.round(((i + chunkFraction) / chunks.length) * 100))
            onProgress?.(percent)
          })
          console.log(`Chunk ${i + 1}/${chunks.length} complete (${chunkTokens} tokens)`)
          chunkResult = this.parseResponse(meetingId, raw, merged)
          break
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err))
          console.error(`Chunk ${i + 1}/${chunks.length} failed:`, lastError.message)
          if (attempt < MAX_RETRIES) continue
        }
      }

      if (!chunkResult) {
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

    return merged
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

  private async callOllama(transcript: string, onToken?: () => void): Promise<string> {
    const controller = new AbortController()
    const requestTimer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: `Here is the meeting transcript:\n\n${transcript}` },
          ],
          stream: true,
          format: 'json',
          options: {
            num_ctx: TARGET_CONTEXT_TOKENS,
            num_predict: MAX_OUTPUT_TOKENS,
            temperature: 0,
            repeat_penalty: 1.3,
          },
        }),
        signal: controller.signal,
      })
    } catch (err) {
      clearTimeout(requestTimer)
      throw err
    }

    if (!res.ok) {
      clearTimeout(requestTimer)
      const text = await res.text().catch(() => '')
      throw new Error(`Ollama returned ${res.status}: ${text.slice(0, 200)}`)
    }

    if (!res.body) {
      clearTimeout(requestTimer)
      throw new Error('Ollama returned no response body')
    }

    let content = ''
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const streamTimeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Ollama stream timed out after ${STREAM_TIMEOUT_MS / 1000}s with no data`)), STREAM_TIMEOUT_MS)
        )
        const { done, value } = await Promise.race([reader.read(), streamTimeout])
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const data = JSON.parse(line) as { message?: { content?: string }; error?: string; done?: boolean }
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
    }

    if (!content) {
      throw new Error('Ollama returned empty response')
    }

    return content
  }

  private parseResponse(meetingId: string, raw: string, existing?: MeetingSegments): MeetingSegments {
    let parsed: Record<string, RawSegment[]>
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error(`Invalid JSON from Ollama: ${raw.slice(0, 200)}`)
    }

    const result: MeetingSegments = {
      decisions: [],
      actionItems: [],
      information: [],
      discussion: [],
      statusUpdates: [],
    }

    const fieldMap: Record<string, keyof MeetingSegments> = {
      decisions: 'decisions',
      action_items: 'actionItems',
      information: 'information',
      discussion: 'discussion',
      status_updates: 'statusUpdates',
    }

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
          sourceStartMs: typeof item.sourceStartMs === 'number' ? item.sourceStartMs : 0,
          sourceEndMs: typeof item.sourceEndMs === 'number' ? item.sourceEndMs : 0,
        })
        index++
      }
    }

    return result
  }
}
