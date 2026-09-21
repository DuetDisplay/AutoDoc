export interface GenerateOptions {
  num_ctx: number
  num_predict: number
  temperature: number
  seed: number
  stop: readonly string[]
}

export interface GenerateRequest {
  model: string
  prompt: string
  stream?: boolean
  options: GenerateOptions
}

export interface OllamaTimings {
  wallClockMs: number
  loadDurationMs: number | null
  promptEvalDurationMs: number | null
  evalDurationMs: number | null
  totalDurationMs: number | null
  promptEvalCount: number | null
  evalCount: number | null
  doneReason: string | null
}

export interface GenerateResult {
  text: string
  rawBody: string
  timings: OllamaTimings
}

export interface ModelIdentity {
  tag: string
  digest: string | null
  parameterSize: string | null
  quantization: string | null
  family: string | null
  modifiedAt: string | null
}

export interface OllamaClientOptions {
  fetch?: typeof fetch
}

interface MetricsPayload {
  total_duration?: number
  load_duration?: number
  prompt_eval_count?: number
  prompt_eval_duration?: number
  eval_count?: number
  eval_duration?: number
  done_reason?: string
  response?: string
  error?: string
  done?: boolean
}

function nsToMs(value: number | undefined): number | null {
  return typeof value === 'number' ? Math.round(value / 1_000_000) : null
}

function timingsFrom(data: MetricsPayload, wallClockMs: number): OllamaTimings {
  return {
    wallClockMs,
    loadDurationMs: nsToMs(data.load_duration),
    promptEvalDurationMs: nsToMs(data.prompt_eval_duration),
    evalDurationMs: nsToMs(data.eval_duration),
    totalDurationMs: nsToMs(data.total_duration) ?? wallClockMs,
    promptEvalCount: typeof data.prompt_eval_count === 'number' ? data.prompt_eval_count : null,
    evalCount: typeof data.eval_count === 'number' ? data.eval_count : null,
    doneReason: data.done_reason ?? null
  }
}

function generateBody(request: GenerateRequest): Record<string, unknown> {
  const stream = request.stream !== false
  return {
    model: request.model,
    prompt: request.prompt,
    stream,
    options: {
      num_ctx: request.options.num_ctx,
      num_predict: request.options.num_predict,
      temperature: request.options.temperature,
      seed: request.options.seed,
      ...(request.options.stop.length > 0 ? { stop: [...request.options.stop] } : {})
    }
  }
}

export class OllamaClient {
  readonly baseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(host: string, options: OllamaClientOptions = {}) {
    this.baseUrl = host.startsWith('http') ? host.replace(/\/$/u, '') : `http://${host}`
    this.fetchImpl = options.fetch ?? fetch
  }

  async version(): Promise<string> {
    const payload = (await this.json('GET', '/api/version')) as { version?: string }
    if (typeof payload.version !== 'string' || payload.version.length === 0) {
      throw new Error('Ollama /api/version returned no version')
    }
    return payload.version
  }

  async tags(): Promise<{ name: string; digest: string | null; modifiedAt: string | null }[]> {
    const payload = (await this.json('GET', '/api/tags')) as {
      models?: { name?: string; model?: string; digest?: string; modified_at?: string }[]
    }
    return (payload.models ?? []).map((model) => ({
      name: model.name ?? model.model ?? 'unknown',
      digest: model.digest ?? null,
      modifiedAt: model.modified_at ?? null
    }))
  }

  async show(model: string): Promise<Record<string, unknown>> {
    return this.json('POST', '/api/show', { name: model })
  }

  async modelIdentity(model: string): Promise<ModelIdentity> {
    let show: Record<string, unknown>
    try {
      show = await this.show(model)
    } catch {
      const available = await this.tags()
      throw new Error(
        `Model ${model} is not available. Store tags: ${available.map((item) => item.name).join(', ') || '(none)'}`
      )
    }
    const listed = (await this.tags()).find(
      (item) => item.name === model || item.name === `${model}:latest`
    )
    const details = (show.details ?? {}) as Record<string, unknown>
    const digestFromShow = typeof show.digest === 'string' ? show.digest : null
    return {
      tag: model,
      digest: listed?.digest ?? digestFromShow,
      parameterSize: typeof details.parameter_size === 'string' ? details.parameter_size : null,
      quantization:
        typeof details.quantization_level === 'string' ? details.quantization_level : null,
      family: typeof details.family === 'string' ? details.family : null,
      modifiedAt: listed?.modifiedAt ?? null
    }
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const stream = request.stream !== false
    const started = Date.now()
    const response = await this.fetchImpl(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(generateBody(request))
    })
    if (!response.ok) {
      throw new Error(`Ollama /api/generate failed with HTTP ${response.status}`)
    }
    if (!stream) {
      const rawBody = await response.text()
      const data = JSON.parse(rawBody) as MetricsPayload
      if (data.error) throw new Error('Ollama generate error')
      return {
        text: data.response ?? '',
        rawBody,
        timings: timingsFrom(data, Date.now() - started)
      }
    }
    return this.readStream(response, started)
  }

  private async readStream(response: Response, started: number): Promise<GenerateResult> {
    if (response.body === null) throw new Error('Ollama stream had no body')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let rawBody = ''
    let text = ''
    let last: MetricsPayload = {}
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = decoder.decode(value, { stream: true })
      rawBody += chunk
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        const data = JSON.parse(line) as MetricsPayload
        if (data.error) throw new Error('Ollama generate error')
        if (typeof data.response === 'string') text += data.response
        last = data
      }
    }
    if (buffer.trim()) {
      const data = JSON.parse(buffer) as MetricsPayload
      if (data.error) throw new Error('Ollama generate error')
      if (typeof data.response === 'string') text += data.response
      last = data
    }
    return {
      text,
      rawBody,
      timings: timingsFrom(last, Date.now() - started)
    }
  }

  private async json(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    if (!response.ok) {
      throw new Error(`Ollama ${path} failed with HTTP ${response.status}`)
    }
    return (await response.json()) as Record<string, unknown>
  }
}

export { generateBody }
