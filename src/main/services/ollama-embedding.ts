import { DEFAULT_OLLAMA_EMBEDDING_MODEL } from '../../shared/constants'
import type { ChatEmbeddingProvider } from './chat-retrieval'

const EMBED_TIMEOUT_MS = 12_000
const AVAILABILITY_TIMEOUT_MS = 1_500
const UNAVAILABLE_CACHE_TTL_MS = 30_000
const EMBED_KEEP_ALIVE = process.env.AUTODOC_ASK_AI_EMBED_KEEP_ALIVE ?? '10m'

export class OllamaEmbeddingProvider implements ChatEmbeddingProvider {
  readonly model: string
  private availability: boolean | null = null
  private availabilityCheckedAt = 0

  constructor(
    private baseUrl: string,
    model = process.env.AUTODOC_ASK_AI_EMBEDDING_MODEL ?? DEFAULT_OLLAMA_EMBEDDING_MODEL
  ) {
    this.model = model
  }

  async isAvailable(): Promise<boolean> {
    if (process.env.AUTODOC_ASK_AI_EMBEDDINGS === '0') return false
    if (this.availability === true) return true
    if (
      this.availability === false &&
      Date.now() - this.availabilityCheckedAt < UNAVAILABLE_CACHE_TTL_MS
    ) {
      return false
    }

    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(AVAILABILITY_TIMEOUT_MS)
      })
      if (!res.ok) {
        this.availability = false
        this.availabilityCheckedAt = Date.now()
        return false
      }

      const data = (await res.json()) as { models?: { name?: string; model?: string }[] }
      this.availability =
        data.models?.some((entry) => {
          const name = entry.name ?? entry.model ?? ''
          return name === this.model || name.startsWith(`${this.model}:`)
        }) ?? false
      this.availabilityCheckedAt = Date.now()
      return this.availability
    } catch {
      this.availability = false
      this.availabilityCheckedAt = Date.now()
      return false
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []

    const res = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
      body: JSON.stringify({
        model: this.model,
        input: texts,
        keep_alive: EMBED_KEEP_ALIVE,
        truncate: true
      })
    })

    if (!res.ok) {
      this.availability = false
      this.availabilityCheckedAt = Date.now()
      throw new Error(`Ollama embedding model ${this.model} returned ${res.status}`)
    }

    const data = (await res.json()) as { embeddings?: number[][]; embedding?: number[] }
    if (Array.isArray(data.embeddings)) {
      if (data.embeddings.length !== texts.length) {
        throw new Error(
          `Ollama embedding model ${this.model} returned ${data.embeddings.length} embeddings for ${texts.length} inputs`
        )
      }
      return data.embeddings
    }
    if (Array.isArray(data.embedding)) {
      if (texts.length !== 1) {
        throw new Error(
          `Ollama embedding model ${this.model} returned one embedding for ${texts.length} inputs`
        )
      }
      return [data.embedding]
    }
    throw new Error(`Ollama embedding model ${this.model} returned no embeddings`)
  }
}
