import type { MeetingSegments, SegmentCategory } from '../../shared/types'

export interface LLMProvider {
  summarize(meetingId: string, transcript: string, onProgress?: (percent: number) => void, durationMinutes?: number): Promise<MeetingSegments>
  checkConnection(): Promise<boolean>
}

const MAX_RETRIES = 2
const TARGET_CONTEXT_TOKENS = 32768 // Request 32K context from Ollama
const CHUNK_CHARS = 4000 // ~1K tokens per chunk — keep small so output fits within token cap
const STREAM_TIMEOUT_MS = 120_000 // Abort if no token received for 2 minutes
const REQUEST_TIMEOUT_MS = 300_000 // 5 minute timeout for entire request
const MAX_OUTPUT_TOKENS = 8192 // Safety cap — model should stop naturally when JSON is complete

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
        ? `\n\nThis is part ${i + 1} of ${chunks.length} of the meeting. Extract only the noteworthy items from THIS section (expect 2-5 items from this part). Be concise. ${itemGuidance}`
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
            // Asymptotic progress: approaches 0.99 but never reaches it, so it never appears stuck
            const ratio = chunkTokens / avgTokensPerChunk
            const chunkFraction = ratio <= 1 ? ratio * 0.8 : 0.8 + 0.19 * (1 - 1 / (1 + (ratio - 1)))
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
        let streamTimer: ReturnType<typeof setTimeout> | undefined
        const streamTimeout = new Promise<never>((_, reject) => {
          streamTimer = setTimeout(() => reject(new Error(`Ollama stream timed out after ${STREAM_TIMEOUT_MS / 1000}s with no data`)), STREAM_TIMEOUT_MS)
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
      },
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
      if (escape) { escape = false; continue }
      if (ch === '\\' && inString) { escape = true; continue }
      if (ch === '"') { inString = !inString; continue }
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

  private parseResponse(meetingId: string, raw: string, existing?: MeetingSegments): MeetingSegments {
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
