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

export interface OllamaWakeCheckOptions {
  isBackgroundRestartPaused: () => boolean
  isServerRunning: () => Promise<boolean>
  onAlreadyRunning: () => void | Promise<void>
  startIfNeeded: () => Promise<void>
}

export async function runOllamaWakeCheck(options: OllamaWakeCheckOptions): Promise<void> {
  const running = await options.isServerRunning()
  if (running) {
    await options.onAlreadyRunning()
    return
  }
  if (options.isBackgroundRestartPaused()) return
  await options.startIfNeeded()
}

export interface OllamaPostWakeScheduler {
  scheduleAfterWake(): void
  clearPending(): void
  cancel(): void
  isActive(): boolean
}

export function isOllamaPostWakeSchedulerActive(
  scheduler: OllamaPostWakeScheduler | null | undefined
): boolean {
  return scheduler?.isActive() === true
}

export function createOllamaPostWakeScheduler(
  options: OllamaPostWakeSchedulerOptions
): OllamaPostWakeScheduler {
  const delayMs = options.delayMs ?? OLLAMA_POST_WAKE_DELAY_MS
  const retryDelaysMs = options.retryDelaysMs ?? OLLAMA_POST_WAKE_RETRY_DELAYS_MS
  const readyHoldMs = options.readyHoldMs ?? OLLAMA_POST_WAKE_READY_HOLD_MS

  let timer: ReturnType<typeof setTimeout> | null = null
  let cancelled = false
  let chainActive = false
  let wakeGeneration = 0
  let retryIndex = 0
  let scheduledEpoch: number | null = null

  const endChain = (generation: number): void => {
    if (generation === wakeGeneration) {
      chainActive = false
    }
  }

  const clearTimer = (): void => {
    if (timer == null) return
    const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout
    clearTimeoutFn(timer)
    timer = null
  }

  const schedule = (delayMs: number, generation: number, action: () => void): void => {
    clearTimer()
    const setTimeoutFn = options.setTimeoutFn ?? setTimeout
    timer = setTimeoutFn(() => {
      timer = null
      if (isStale(generation)) {
        endChain(generation)
        return
      }
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
    if (!isStale(generation)) {
      options.onWakeFailed?.()
    }
    endChain(generation)
  }

  const scheduleRetry = (generation: number): void => {
    if (isStale(generation)) {
      endChain(generation)
      return
    }
    if (retryIndex >= retryDelaysMs.length) {
      finishWakeFailure(generation)
      return
    }
    const retryDelayMs = retryDelaysMs[retryIndex]
    retryIndex += 1
    schedule(retryDelayMs, generation, () => {
      void runCheck(generation)
    })
  }

  const confirmStillRunning = async (generation: number): Promise<void> => {
    if (isStale(generation)) {
      endChain(generation)
      return
    }
    if (readyHoldMs <= 0 || !options.isServerRunning) {
      options.onWakeSucceeded?.()
      endChain(generation)
      return
    }
    schedule(readyHoldMs, generation, () => {
      void (async () => {
        if (isStale(generation)) {
          endChain(generation)
          return
        }
        const running = await options.isServerRunning?.()
        if (running) {
          options.onWakeSucceeded?.()
          endChain(generation)
          return
        }
        scheduleRetry(generation)
      })()
    })
  }

  const runCheck = async (generation: number): Promise<void> => {
    if (isStale(generation)) {
      endChain(generation)
      return
    }
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
      chainActive = true
      const generation = wakeGeneration
      if (delayMs <= 0) {
        void runCheck(generation)
        return
      }
      schedule(delayMs, generation, () => {
        void runCheck(generation)
      })
    },
    clearPending(): void {
      wakeGeneration += 1
      retryIndex = 0
      scheduledEpoch = null
      chainActive = false
      clearTimer()
    },
    cancel(): void {
      cancelled = true
      chainActive = false
      clearTimer()
    },
    isActive(): boolean {
      return !cancelled && chainActive
    }
  }
}
