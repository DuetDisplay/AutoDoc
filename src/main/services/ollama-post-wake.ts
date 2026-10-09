export const OLLAMA_POST_WAKE_DELAY_MS = 30_000
export const OLLAMA_POST_WAKE_RETRY_DELAYS_MS = [60_000, 180_000] as const

export interface OllamaPostWakeSchedulerOptions {
  checkOllama: () => Promise<void>
  isPaused?: () => boolean
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

  const schedule = (delayMs: number, generation: number): void => {
    clearTimer()
    const setTimeoutFn = options.setTimeoutFn ?? setTimeout
    timer = setTimeoutFn(() => {
      timer = null
      void runCheck(generation)
    }, delayMs)
  }

  const isPaused = (): boolean => options.isPaused?.() === true

  const runCheck = async (generation: number): Promise<void> => {
    if (cancelled || generation !== wakeGeneration || isPaused()) return
    try {
      await options.checkOllama()
    } catch {
      if (cancelled || generation !== wakeGeneration || isPaused()) return
      if (retryIndex >= OLLAMA_POST_WAKE_RETRY_DELAYS_MS.length) return
      const delayMs = OLLAMA_POST_WAKE_RETRY_DELAYS_MS[retryIndex]
      retryIndex += 1
      schedule(delayMs, generation)
    }
  }

  return {
    scheduleAfterWake(): void {
      if (cancelled || isPaused()) return
      wakeGeneration += 1
      retryIndex = 0
      schedule(OLLAMA_POST_WAKE_DELAY_MS, wakeGeneration)
    },
    cancel(): void {
      cancelled = true
      clearTimer()
    }
  }
}
