import { DEFAULT_OLLAMA_EMBEDDING_MODEL } from '../../shared/constants'
import type { ChatEmbeddingProvider } from './chat-retrieval'

const EMBED_TIMEOUT_MS = 12_000
const AVAILABILITY_TIMEOUT_MS = 1_500
const UNAVAILABLE_CACHE_TTL_MS = 30_000
const EMBED_KEEP_ALIVE = process.env.AUTODOC_ASK_AI_EMBED_KEEP_ALIVE ?? '10m'

export class OllamaEmbeddingProvider implements ChatEmbeddingProvider {
  readonly model: string
  availabilityReason: 'unknown' | 'available' | 'missing' | 'disabled' | 'unreachable' = 'unknown'
  private availability: boolean | null = null
  private modelDigest: string | null = null
  get cacheIdentity(): string {
    return `${this.model}:${this.modelDigest ?? 'unknown'}`
  }
  private availabilityCheckedAt = 0

  constructor(
    private baseUrl: string,
    model = process.env.AUTODOC_ASK_AI_EMBEDDING_MODEL ?? DEFAULT_OLLAMA_EMBEDDING_MODEL,
    private requestOptions?: { num_gpu: number },
    private keepAlive: string | number = EMBED_KEEP_ALIVE
  ) {
    this.model = model
  }

  invalidateAvailability(): void {
    this.availability = null
    this.availabilityReason = 'unknown'
    this.availabilityCheckedAt = 0
  }

  async isAvailable(): Promise<boolean> {
    if (process.env.AUTODOC_ASK_AI_EMBEDDINGS === '0') {
      this.availabilityReason = 'disabled'
      return false
    }
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
        this.availabilityReason = 'unreachable'
        this.availability = false
        this.availabilityCheckedAt = Date.now()
        return false
      }

      const data = (await res.json()) as {
        models?: { name?: string; model?: string; digest?: string }[]
      }
      const installed = data.models?.find((entry) => {
        const name = entry.name ?? entry.model ?? ''
        return name === this.model || name.startsWith(`${this.model}:`)
      })
      this.availabilityReason = installed ? 'available' : 'missing'
      this.availability = Boolean(installed)
      this.modelDigest = installed?.digest ?? null
      this.availabilityCheckedAt = Date.now()
      return this.availability
    } catch {
      this.availabilityReason = 'unreachable'
      this.availability = false
      this.availabilityCheckedAt = Date.now()
      return false
    }
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    if (texts.length === 0) return []

    const res = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(EMBED_TIMEOUT_MS)])
        : AbortSignal.timeout(EMBED_TIMEOUT_MS),
      body: JSON.stringify({
        model: this.model,
        input: texts,
        keep_alive: this.keepAlive,
        ...(this.requestOptions ? { options: this.requestOptions } : {}),
        truncate: true
      })
    })

    if (!res.ok) {
      this.availabilityReason = res.status === 404 ? 'missing' : 'unreachable'
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
