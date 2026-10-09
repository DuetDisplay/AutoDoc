export const OLLAMA_POST_WAKE_DELAY_MS = 30_000
export const OLLAMA_POST_WAKE_RETRY_DELAYS_MS = [60_000, 180_000] as const
export const OLLAMA_POST_WAKE_READY_HOLD_MS = 20_000

export interface OllamaPostWakePolicy {
  delayMs: number
  retryDelaysMs: readonly number[]
  readyHoldMs: number
  pauseEnabled: boolean
}

export function getOllamaPostWakePolicy(
  platform: NodeJS.Platform = process.platform
): OllamaPostWakePolicy {
  if (platform !== 'win32') {
    return {
      delayMs: 0,
      retryDelaysMs: [],
      readyHoldMs: 0,
      pauseEnabled: false
    }
  }
  return {
    delayMs: OLLAMA_POST_WAKE_DELAY_MS,
    retryDelaysMs: OLLAMA_POST_WAKE_RETRY_DELAYS_MS,
    readyHoldMs: OLLAMA_POST_WAKE_READY_HOLD_MS,
    pauseEnabled: true
  }
}

export interface OllamaPostWakeSchedulerOptions {
  checkOllama: () => Promise<void>
  isServerRunning?: () => Promise<boolean>
  isPaused?: () => boolean
  captureEpoch?: () => number
  isEpochCurrent?: (epoch: number) => boolean
  delayMs?: number
  retryDelaysMs?: readonly number[]
  readyHoldMs?: number
  onWakeSucceeded?: () => void
  onWakeFailed?: () => void
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
}

export interface OllamaPostWakeScheduler {
  scheduleAfterWake(): void
  clearPending(): void
  cancel(): void
}

export function createOllamaPostWakeScheduler(
  options: OllamaPostWakeSchedulerOptions
): OllamaPostWakeScheduler {
  const delayMs = options.delayMs ?? OLLAMA_POST_WAKE_DELAY_MS
  const retryDelaysMs = options.retryDelaysMs ?? OLLAMA_POST_WAKE_RETRY_DELAYS_MS
  const readyHoldMs = options.readyHoldMs ?? OLLAMA_POST_WAKE_READY_HOLD_MS

  let timer: ReturnType<typeof setTimeout> | null = null
  let cancelled = false
  let wakeGeneration = 0
  let retryIndex = 0
  let scheduledEpoch: number | null = null

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

  const isStale = (generation: number): boolean => {
    if (cancelled || generation !== wakeGeneration || isPaused()) return true
    if (scheduledEpoch == null || !options.isEpochCurrent) return false
    return !options.isEpochCurrent(scheduledEpoch)
  }

  const finishWakeFailure = (generation: number): void => {
    if (isStale(generation)) return
    options.onWakeFailed?.()
  }

  const scheduleRetry = (generation: number): void => {
    if (isStale(generation)) return
    if (retryIndex >= retryDelaysMs.length) {
      finishWakeFailure(generation)
      return
    }
    const retryDelayMs = retryDelaysMs[retryIndex]
    retryIndex += 1
    schedule(retryDelayMs, () => {
      void runCheck(generation)
    })
  }

  const confirmStillRunning = async (generation: number): Promise<void> => {
    if (isStale(generation)) return
    if (readyHoldMs <= 0 || !options.isServerRunning) {
      options.onWakeSucceeded?.()
      return
    }
    schedule(readyHoldMs, () => {
      void (async () => {
        if (isStale(generation)) return
        const running = await options.isServerRunning?.()
        if (running) {
          options.onWakeSucceeded?.()
          return
        }
        scheduleRetry(generation)
      })()
    })
  }

  const runCheck = async (generation: number): Promise<void> => {
    if (isStale(generation)) return
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
      scheduledEpoch = options.captureEpoch?.() ?? null
      const generation = wakeGeneration
      if (delayMs <= 0) {
        void runCheck(generation)
        return
      }
      schedule(delayMs, () => {
        void runCheck(generation)
      })
    },
    clearPending(): void {
      wakeGeneration += 1
      retryIndex = 0
      scheduledEpoch = null
      clearTimer()
    },
    cancel(): void {
      cancelled = true
      clearTimer()
    }
  }
}
