export interface OllamaSetupRunner {
  startAndPull(): Promise<void>
  resetReady?(): void
}

export interface OllamaSetupCoordinatorOptions {
  retryDelaysMs?: number[]
  onAttemptStart?: (attempt: number) => void
  onFinalError?: (error: Error) => void
}

export interface EnsureOllamaSetupOptions {
  force?: boolean
}

const DEFAULT_RETRY_DELAYS_MS = [0, 5_000, 30_000, 120_000]

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class OllamaSetupCoordinator {
  private setupPromise: Promise<void> | null = null
  private terminalError: Error | null = null
  private retryDelaysMs: number[]
  private onAttemptStart?: (attempt: number) => void
  private onFinalError?: (error: Error) => void

  constructor(
    private runner: OllamaSetupRunner,
    options: OllamaSetupCoordinatorOptions = {}
  ) {
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
    this.onAttemptStart = options.onAttemptStart
    this.onFinalError = options.onFinalError
  }

  ensureRunning(options: EnsureOllamaSetupOptions = {}): Promise<void> {
    if (this.setupPromise) return this.setupPromise

    if (options.force) {
      this.terminalError = null
      this.runner.resetReady?.()
    } else if (this.terminalError) {
      return Promise.reject(this.terminalError)
    }

    this.setupPromise = this.runSetupAttempts()
      .then(() => {
        this.terminalError = null
      })
      .catch((error) => {
        const normalized = toError(error)
        this.terminalError = normalized
        this.onFinalError?.(normalized)
        throw normalized
      })
      .finally(() => {
        this.setupPromise = null
      })

    return this.setupPromise
  }

  waitUntilReady(): Promise<void> {
    return this.ensureRunning()
  }

  private async runSetupAttempts(): Promise<void> {
    let lastError: Error | null = null

    for (let attemptIndex = 0; attemptIndex < this.retryDelaysMs.length; attemptIndex++) {
      await delay(this.retryDelaysMs[attemptIndex])
      this.onAttemptStart?.(attemptIndex + 1)

      try {
        await this.runner.startAndPull()
        return
      } catch (error) {
        lastError = toError(error)
      }
    }

    throw lastError ?? new Error('Ollama setup failed')
  }
}
