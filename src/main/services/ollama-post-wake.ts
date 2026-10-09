export const OLLAMA_POST_WAKE_DELAY_MS = 30_000
export const OLLAMA_POST_WAKE_RETRY_DELAYS_MS = [60_000, 180_000] as const
export const OLLAMA_POST_WAKE_READY_HOLD_MS = 20_000

export interface OllamaPostWakeSchedulerOptions {
  checkOllama: () => Promise<void>
  isServerRunning?: () => Promise<boolean>
  isPaused?: () => boolean
  readyHoldMs?: number
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
}

export interface OllamaPostWakeScheduler {
  scheduleAfterWake(): void
  cancel(): void
}

export function createOllamaPostWakeScheduler(
  options: OllamaPostWakeSchedulerOptions
): OllamaPostWakeScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null
  let cancelled = false
  let wakeGeneration = 0
  let retryIndex = 0

  const clearTimer = (): void => {
    if (timer == null) return
    const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout
    clearTimeoutFn(timer)
    timer = null
  }

  const schedule = (delayMs: number, action: () => void): void => {
    clearTimer()
    const setTimeoutFn = options.setTimeoutFn ?? setTimeout
    timer = setTimeoutFn(() => {
      timer = null
      action()
    }, delayMs)
  }

  const isPaused = (): boolean => options.isPaused?.() === true

  const scheduleRetry = (generation: number): void => {
    if (cancelled || generation !== wakeGeneration || isPaused()) return
    if (retryIndex >= OLLAMA_POST_WAKE_RETRY_DELAYS_MS.length) return
    const delayMs = OLLAMA_POST_WAKE_RETRY_DELAYS_MS[retryIndex]
    retryIndex += 1
    schedule(delayMs, () => {
      void runCheck(generation)
    })
  }

  const confirmStillRunning = async (generation: number): Promise<void> => {
    if (cancelled || generation !== wakeGeneration || isPaused()) return
    const holdMs = options.readyHoldMs ?? OLLAMA_POST_WAKE_READY_HOLD_MS
    if (holdMs <= 0 || !options.isServerRunning) return
    schedule(holdMs, () => {
      void (async () => {
        if (cancelled || generation !== wakeGeneration || isPaused()) return
        const running = await options.isServerRunning?.()
        if (running) return
        scheduleRetry(generation)
      })()
    })
  }

  const runCheck = async (generation: number): Promise<void> => {
    if (cancelled || generation !== wakeGeneration || isPaused()) return
    try {
      await options.checkOllama()
    } catch {
      scheduleRetry(generation)
      return
    }
    await confirmStillRunning(generation)
  }

  return {
    scheduleAfterWake(): void {
      if (cancelled || isPaused()) return
      wakeGeneration += 1
      retryIndex = 0
      const generation = wakeGeneration
      schedule(OLLAMA_POST_WAKE_DELAY_MS, () => {
        void runCheck(generation)
      })
    },
    cancel(): void {
      cancelled = true
      clearTimer()
    }
  }
}
