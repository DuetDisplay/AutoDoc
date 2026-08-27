export interface OllamaSetupRunner {
  startAndPull(): Promise<void>
  resetReady?(): void
  beginSetupLifecycle?(): number
  captureLifecycleEpoch?(): number
  assertLifecycleEpoch?(epoch: number): void
}

export interface OllamaSetupCoordinatorOptions {
  retryDelaysMs?: number[]
  onAttemptStart?: (attempt: number) => void
  onFinalError?: (error: Error) => void
  isCancellationError?: (error: unknown) => boolean
}

export interface EnsureOllamaSetupOptions {
  force?: boolean
}

const DEFAULT_RETRY_DELAYS_MS = [0, 5_000, 30_000, 120_000]
const RETRY_CANCELLATION_POLL_MS = 250

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class OllamaSetupCoordinator {
  private setupPromise: Promise<void> | null = null
  private setupLifecycleEpoch: number | undefined
  private terminalError: Error | null = null
  private retryDelaysMs: number[]
  private onAttemptStart?: (attempt: number) => void
  private onFinalError?: (error: Error) => void
  private isCancellationError: (error: unknown) => boolean

  constructor(
    private runner: OllamaSetupRunner,
    options: OllamaSetupCoordinatorOptions = {}
  ) {
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
    this.onAttemptStart = options.onAttemptStart
    this.onFinalError = options.onFinalError
    this.isCancellationError = options.isCancellationError ?? (() => false)
  }

  ensureRunning(options: EnsureOllamaSetupOptions = {}): Promise<void> {
    if (this.setupPromise) {
      if (options.force && !this.isSetupLifecycleCurrent()) {
        const staleSetup = this.setupPromise
        return staleSetup.catch(() => {}).then(() => this.ensureRunning({ force: true }))
      }
      return this.setupPromise
    }

    if (options.force) {
      this.terminalError = null
      this.runner.resetReady?.()
    } else if (this.terminalError) {
      return Promise.reject(this.terminalError)
    }

    const lifecycleEpoch = this.runner.beginSetupLifecycle?.()
    const run = this.runSetupAttempts(lifecycleEpoch)
    const promise = run
      .then(() => {
        this.terminalError = null
      })
      .catch((error) => {
        const normalized = toError(error)
        if (!this.isCancellationError(normalized)) {
          this.terminalError = normalized
          this.onFinalError?.(normalized)
        }
        throw normalized
      })
      .finally(() => {
        if (this.setupPromise === promise) {
          this.setupPromise = null
          this.setupLifecycleEpoch = undefined
        }
      })
    this.setupLifecycleEpoch = lifecycleEpoch
    this.setupPromise = promise

    return promise
  }

  waitUntilReady(): Promise<void> {
    const lifecycleEpoch = this.runner.captureLifecycleEpoch?.()
    if (lifecycleEpoch != null) {
      try {
        this.runner.assertLifecycleEpoch?.(lifecycleEpoch)
      } catch (error) {
        return Promise.reject(error)
      }
    }
    return this.ensureRunning()
  }

  private async runSetupAttempts(lifecycleEpoch?: number): Promise<void> {
    let lastError: Error | null = null

    for (let attemptIndex = 0; attemptIndex < this.retryDelaysMs.length; attemptIndex++) {
      const retryDelayMs = this.retryDelaysMs[attemptIndex]
      await this.waitForRetryDelay(retryDelayMs, lifecycleEpoch)
      this.assertLifecycleEpoch(lifecycleEpoch)
      this.onAttemptStart?.(attemptIndex + 1)

      try {
        await this.runner.startAndPull()
        if (lifecycleEpoch != null) {
          this.runner.assertLifecycleEpoch?.(lifecycleEpoch)
        }
        return
      } catch (error) {
        const normalized = toError(error)
        if (this.isCancellationError(normalized)) {
          throw normalized
        }
        lastError = normalized
      }
    }

    throw lastError ?? new Error('Ollama setup failed')
  }

  private isSetupLifecycleCurrent(): boolean {
    if (this.setupLifecycleEpoch == null || !this.runner.assertLifecycleEpoch) return true
    try {
      this.runner.assertLifecycleEpoch(this.setupLifecycleEpoch)
      return true
    } catch {
      return false
    }
  }

  private assertLifecycleEpoch(lifecycleEpoch?: number): void {
    if (lifecycleEpoch != null) {
      this.runner.assertLifecycleEpoch?.(lifecycleEpoch)
    }
  }

  private async waitForRetryDelay(retryDelayMs: number, lifecycleEpoch?: number): Promise<void> {
    if (retryDelayMs <= 0) return
    if (lifecycleEpoch == null || !this.runner.assertLifecycleEpoch) {
      await delay(retryDelayMs)
      return
    }

    let remainingMs = retryDelayMs
    while (remainingMs > 0) {
      const sliceMs = Math.min(remainingMs, RETRY_CANCELLATION_POLL_MS)
      await delay(sliceMs)
      this.assertLifecycleEpoch(lifecycleEpoch)
      remainingMs -= sliceMs
    }
  }
}
