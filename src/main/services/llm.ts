import type { MeetingSegments, SegmentCategory } from '../../shared/types'

export interface LLMProvider {
  summarize(meetingId: string, transcript: string): Promise<MeetingSegments>
  checkConnection(): Promise<boolean>
}

const MAX_RETRIES = 2
const TARGET_CONTEXT_TOKENS = 32768 // Request 32K context from Ollama
const CHUNK_CHARS = 6000 // ~1.5K tokens per chunk — small enough for thorough extraction

const SYSTEM_PROMPT = `You are a thorough meeting notes assistant. Your job is to capture EVERYTHING of value from the transcript — err on the side of including too much rather than too little. People rely on these notes to remember what happened.

Extract and categorize into these 5 categories:

1. **decisions** — Any decision made, even small ones. Include who decided and the reasoning.
2. **action_items** — Every task, follow-up, or commitment mentioned. Include who owns it and any deadline.
3. **information** — Facts, numbers, data, updates, context shared. Capture specific details (names, figures, dates, URLs).
4. **discussion** — Debates, disagreements, open questions, alternatives considered, pros/cons discussed.
5. **status_updates** — Progress reports, blockers, what's done, what's in progress, what's next.

Guidelines:
- Extract EVERY distinct point — aim for roughly 1 item per minute of meeting across all categories.
- Each item should capture the full context so someone who wasn't in the meeting understands it.
- ACCURACY IS CRITICAL: Use the exact words, numbers, and timeframes from the transcript. Do NOT paraphrase numbers, dates, or quantities — quote them directly. If someone says "per year", write "per year", not "per month".
- Include specific names, numbers, dates, and technical details — don't generalize or round.
- If someone says "I'll do X by Friday", that's an action item with an assignee and deadline.
- If someone shares a metric or fact, that's information — capture the exact number as stated.
- When in doubt about which category, include it in the most relevant one.
- When in doubt about a detail, use the EXACT phrasing from the transcript rather than rewording it.
- Always use proper sentence capitalization for titles and content. The first letter of each title and content field must be uppercase.

IMPORTANT: Group related items under a shared "topic" string. The topic is a short label (2-5 words) for the subject area, e.g. "Cybersecurity Strategy", "Q2 Hiring", "Product Launch". Items about the same subject MUST share the exact same topic string. This groups notes visually so they're easy to scan.

Respond with ONLY valid JSON (no markdown, no explanation):
{
  "decisions": [{ "topic": "subject area", "title": "clear summary", "content": "full context with names and reasoning", "assignee": null, "deadline": null }],
  "action_items": [{ "topic": "subject area", "title": "specific task", "content": "full detail of what needs to happen", "assignee": "person or null", "deadline": "deadline or null" }],
  "information": [{ "topic": "subject area", "title": "what was shared", "content": "exact details, numbers, and context", "assignee": null, "deadline": null }],
  "discussion": [{ "topic": "subject area", "title": "topic debated", "content": "positions taken, arguments made, outcome if any", "assignee": null, "deadline": null }],
  "status_updates": [{ "topic": "subject area", "title": "what was reported", "content": "current state, blockers, next steps", "assignee": null, "deadline": null }]
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

  private estimateItemCount(transcriptLength: number): string {
    // ~150 chars per spoken line, ~5 lines per minute → ~750 chars/min
    const estMinutes = Math.max(5, Math.round(transcriptLength / 750))
    // Scale: ~1 item per minute, min 5, no max
    const minItems = Math.max(5, Math.round(estMinutes * 0.8))
    const maxItems = Math.round(estMinutes * 1.5)
    return `This appears to be roughly a ${estMinutes}-minute meeting. Aim for ${minItems}-${maxItems} items total across all categories — approximately 1 item per minute of meeting.`
  }

  async summarize(meetingId: string, transcript: string): Promise<MeetingSegments> {
    const chunks = this.chunkTranscript(transcript)
    const itemGuidance = this.estimateItemCount(transcript.length)
    console.log(`Processing transcript in ${chunks.length} chunk(s) (${transcript.length} chars total). ${itemGuidance}`)

    const merged: MeetingSegments = {
      decisions: [],
      actionItems: [],
      information: [],
      discussion: [],
      statusUpdates: [],
    }

    for (let i = 0; i < chunks.length; i++) {
      const chunkLabel = chunks.length > 1
        ? `\n\nThis is part ${i + 1} of ${chunks.length} of the meeting. Extract ALL noteworthy items from this section. ${itemGuidance}`
        : `\n\n${itemGuidance}`

      let lastError: Error | null = null
      let chunkResult: MeetingSegments | null = null

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const raw = await this.callOllama(chunks[i] + chunkLabel)
          chunkResult = this.parseResponse(meetingId, raw, merged)
          break
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err))
          if (attempt < MAX_RETRIES) continue
        }
      }

      if (!chunkResult) {
        throw lastError ?? new Error(`LLM summarization failed on chunk ${i + 1}/${chunks.length}`)
      }

      merged.decisions.push(...chunkResult.decisions)
      merged.actionItems.push(...chunkResult.actionItems)
      merged.information.push(...chunkResult.information)
      merged.discussion.push(...chunkResult.discussion)
      merged.statusUpdates.push(...chunkResult.statusUpdates)
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

  private async callOllama(transcript: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Here is the meeting transcript:\n\n${transcript}` },
        ],
        stream: false,
        format: 'json',
        options: {
          num_ctx: TARGET_CONTEXT_TOKENS,
          temperature: 0,
        },
      }),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Ollama returned ${res.status}: ${text.slice(0, 200)}`)
    }

    const data = (await res.json()) as OllamaResponse
    if (data.error) {
      throw new Error(`Ollama error: ${data.error}`)
    }

    const content = data.message?.content
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
      let index = existingCount

      for (const item of items) {
        if (!item.title || !item.content) continue
        result[resultKey].push({
          id: `${meetingId}-${rawKey}-${index}`,
          meetingId,
          category,
          topic: item.topic ? capitalize(String(item.topic)) : null,
          title: capitalize(String(item.title)),
          content: capitalize(String(item.content)),
          assignee: item.assignee ? String(item.assignee) : null,
          deadline: item.deadline ? String(item.deadline) : null,
          sourceStartMs: 0,
          sourceEndMs: 0,
        })
        index++
      }
    }

    return result
  }
}
