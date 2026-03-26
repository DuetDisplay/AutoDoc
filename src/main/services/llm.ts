import type { MeetingSegments, SegmentCategory } from '../../shared/types'

export interface LLMProvider {
  summarize(meetingId: string, transcript: string): Promise<MeetingSegments>
  checkConnection(): Promise<boolean>
}

const MAX_RETRIES = 2

const SYSTEM_PROMPT = `You are a meeting notes assistant. Given a meeting transcript, extract and categorize information into these 5 categories based on Andy Grove's High Output Management framework:

1. **decisions** — What was decided, and by whom
2. **action_items** — Who owns what task, with deadlines if mentioned
3. **information** — Key facts, data, or updates shared
4. **discussion** — Disagreements, open questions, debates
5. **status_updates** — Progress reports on ongoing work

Respond with ONLY valid JSON matching this exact schema (no markdown, no explanation):
{
  "decisions": [{ "title": "short summary", "content": "full detail", "assignee": null, "deadline": null }],
  "action_items": [{ "title": "short summary", "content": "full detail", "assignee": "person or null", "deadline": "deadline or null" }],
  "information": [{ "title": "short summary", "content": "full detail", "assignee": null, "deadline": null }],
  "discussion": [{ "title": "short summary", "content": "full detail", "assignee": null, "deadline": null }],
  "status_updates": [{ "title": "short summary", "content": "full detail", "assignee": null, "deadline": null }]
}

If a category has no items, use an empty array. Every item MUST have title and content fields.`

interface OllamaResponse {
  message?: { content?: string }
  error?: string
}

interface RawSegment {
  title?: string
  content?: string
  assignee?: string | null
  deadline?: string | null
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

  async summarize(meetingId: string, transcript: string): Promise<MeetingSegments> {
    let lastError: Error | null = null

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const raw = await this.callOllama(transcript)
        return this.parseResponse(meetingId, raw)
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        if (attempt < MAX_RETRIES) continue
      }
    }

    throw lastError ?? new Error('LLM summarization failed')
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

  private parseResponse(meetingId: string, raw: string): MeetingSegments {
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
      let index = 0

      for (const item of items) {
        if (!item.title || !item.content) continue
        result[resultKey].push({
          id: `${meetingId}-${rawKey}-${index}`,
          meetingId,
          category,
          title: String(item.title),
          content: String(item.content),
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
