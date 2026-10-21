import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OLLAMA_POST_WAKE_DELAY_MS,
  OLLAMA_POST_WAKE_READY_HOLD_MS,
  OLLAMA_POST_WAKE_RETRY_DELAYS_MS,
  createOllamaPostWakeScheduler,
  getOllamaPostWakePolicy,
  runOllamaWakeCheck
} from '../ollama-post-wake'

afterEach(() => {
  vi.useRealTimers()
})

describe('ollama wake check', () => {
  it('marks a running server ready while background restarts are paused', async () => {
    const onAlreadyRunning = vi.fn()
    const startIfNeeded = vi.fn()
    await runOllamaWakeCheck({
      isBackgroundRestartPaused: () => true,
      isServerRunning: async () => true,
      onAlreadyRunning,
      startIfNeeded
    })
    expect(onAlreadyRunning).toHaveBeenCalledTimes(1)
    expect(startIfNeeded).not.toHaveBeenCalled()
  })
})

describe('ollama post-wake scheduler', () => {
  it('runs a Mac resume check immediately with no retries', async () => {
    const checkOllama = vi.fn().mockResolvedValue(undefined)
    const scheduler = createOllamaPostWakeScheduler({
      checkOllama,
      ...getOllamaPostWakePolicy('darwin')
    })
    scheduler.scheduleAfterWake()
    await Promise.resolve()
    expect(checkOllama).toHaveBeenCalledTimes(1)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(checkOllama).toHaveBeenCalledTimes(1)
  })

  it('merges resume and unlock-screen into one check after the wake delay', async () => {
    const checkOllama = vi.fn().mockResolvedValue(undefined)
    const notesStart = vi.fn().mockResolvedValue(undefined)
    vi.useFakeTimers()
    const scheduler = createOllamaPostWakeScheduler({ checkOllama })
    scheduler.scheduleAfterWake()
    await vi.advanceTimersByTimeAsync(10_000)
    await notesStart()
    scheduler.scheduleAfterWake()
    await vi.advanceTimersByTimeAsync(OLLAMA_POST_WAKE_DELAY_MS - 1)

    expect(notesStart).toHaveBeenCalledTimes(1)
    expect(checkOllama).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(checkOllama).toHaveBeenCalledTimes(1)
  })

  it('retries a failed post-wake start at 60s and 180s, then records one failed wake', async () => {
    const checkOllama = vi.fn().mockRejectedValue(new Error('serve failed to start'))
    const onWakeFailed = vi.fn()
    const onWakeSucceeded = vi.fn()
    vi.useFakeTimers()
    const scheduler = createOllamaPostWakeScheduler({
      checkOllama,
      onWakeFailed,
      onWakeSucceeded
    })
    scheduler.scheduleAfterWake()
    await vi.advanceTimersByTimeAsync(OLLAMA_POST_WAKE_DELAY_MS)
    expect(checkOllama).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(OLLAMA_POST_WAKE_RETRY_DELAYS_MS[0])
    expect(checkOllama).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(OLLAMA_POST_WAKE_RETRY_DELAYS_MS[1])
    expect(checkOllama).toHaveBeenCalledTimes(3)
    expect(onWakeFailed).toHaveBeenCalledTimes(1)
    expect(onWakeSucceeded).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(OLLAMA_POST_WAKE_RETRY_DELAYS_MS[1])
    expect(checkOllama).toHaveBeenCalledTimes(3)
    expect(onWakeFailed).toHaveBeenCalledTimes(1)
  })

  it('retries when the serve disappears 20s after a successful start', async () => {
    const checkOllama = vi.fn().mockResolvedValue(undefined)
    const isServerRunning = vi.fn().mockResolvedValue(false)
    vi.useFakeTimers()
    const scheduler = createOllamaPostWakeScheduler({ checkOllama, isServerRunning })
    scheduler.scheduleAfterWake()
    await vi.advanceTimersByTimeAsync(OLLAMA_POST_WAKE_DELAY_MS)
    expect(checkOllama).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(OLLAMA_POST_WAKE_READY_HOLD_MS)
    expect(isServerRunning).toHaveBeenCalledTimes(1)
    expect(checkOllama).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(OLLAMA_POST_WAKE_RETRY_DELAYS_MS[0])
    expect(checkOllama).toHaveBeenCalledTimes(2)
  })

  it('succeeds without retry when the hold check finds a starting serve that then answers', async () => {
    const checkOllama = vi.fn().mockResolvedValue(undefined)
    const isServerRunning = vi.fn().mockResolvedValue(false)
    const isServeStarting = vi.fn().mockReturnValue(true)
    const waitForStartingServe = vi.fn().mockResolvedValue(true)
    const onWakeSucceeded = vi.fn()
    const onWakeFailed = vi.fn()
    vi.useFakeTimers()
    const scheduler = createOllamaPostWakeScheduler({
      checkOllama,
      isServerRunning,
      isServeStarting,
      waitForStartingServe,
      onWakeSucceeded,
      onWakeFailed
    })
    scheduler.scheduleAfterWake()
    await vi.advanceTimersByTimeAsync(OLLAMA_POST_WAKE_DELAY_MS + OLLAMA_POST_WAKE_READY_HOLD_MS)

    expect(waitForStartingServe).toHaveBeenCalledTimes(1)
    expect(onWakeSucceeded).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(OLLAMA_POST_WAKE_RETRY_DELAYS_MS[0])
    expect(checkOllama).toHaveBeenCalledTimes(1)
    expect(onWakeFailed).not.toHaveBeenCalled()
    expect(scheduler.isActive()).toBe(false)
  })

  it('runs the normal retry path when the starting serve never answers', async () => {
    const checkOllama = vi.fn().mockResolvedValue(undefined)
    const waitForStartingServe = vi.fn().mockResolvedValue(false)
    const onWakeSucceeded = vi.fn()
    vi.useFakeTimers()
    const scheduler = createOllamaPostWakeScheduler({
      checkOllama,
      isServerRunning: vi.fn().mockResolvedValue(false),
      isServeStarting: () => true,
      waitForStartingServe,
      onWakeSucceeded
    })
    scheduler.scheduleAfterWake()
    await vi.advanceTimersByTimeAsync(OLLAMA_POST_WAKE_DELAY_MS + OLLAMA_POST_WAKE_READY_HOLD_MS)
    expect(waitForStartingServe).toHaveBeenCalledTimes(1)
    expect(onWakeSucceeded).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(OLLAMA_POST_WAKE_RETRY_DELAYS_MS[0])
    expect(checkOllama).toHaveBeenCalledTimes(2)
  })

  it('does not wait for a serve that is not starting', async () => {
    const waitForStartingServe = vi.fn().mockResolvedValue(true)
    vi.useFakeTimers()
    const scheduler = createOllamaPostWakeScheduler({
      checkOllama: vi.fn().mockResolvedValue(undefined),
      isServerRunning: vi.fn().mockResolvedValue(false),
      isServeStarting: () => false,
      waitForStartingServe
    })
    scheduler.scheduleAfterWake()
    await vi.advanceTimersByTimeAsync(OLLAMA_POST_WAKE_DELAY_MS + OLLAMA_POST_WAKE_READY_HOLD_MS)
    expect(waitForStartingServe).not.toHaveBeenCalled()
  })

  it('lets a newer wake cancel a hold check that is waiting on a starting serve', async () => {
    const checkOllama = vi.fn().mockResolvedValue(undefined)
    let releaseWait!: (started: boolean) => void
    const waitForStartingServe = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          releaseWait = resolve
        })
    )
    const onWakeSucceeded = vi.fn()
    vi.useFakeTimers()
    const scheduler = createOllamaPostWakeScheduler({
      checkOllama,
      isServerRunning: vi.fn().mockResolvedValue(false),
      isServeStarting: () => true,
      waitForStartingServe,
      onWakeSucceeded
    })
    scheduler.scheduleAfterWake()
    await vi.advanceTimersByTimeAsync(OLLAMA_POST_WAKE_DELAY_MS + OLLAMA_POST_WAKE_READY_HOLD_MS)
    expect(waitForStartingServe).toHaveBeenCalledTimes(1)

    scheduler.scheduleAfterWake()
    releaseWait(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(onWakeSucceeded).not.toHaveBeenCalled()
  })

  it('starts a fresh 30s check when a new wake lands during retry', async () => {
    const checkOllama = vi.fn().mockRejectedValue(new Error('serve failed to start'))
    vi.useFakeTimers()
    const scheduler = createOllamaPostWakeScheduler({ checkOllama })
    scheduler.scheduleAfterWake()
    await vi.advanceTimersByTimeAsync(OLLAMA_POST_WAKE_DELAY_MS)
    expect(checkOllama).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(10_000)
    scheduler.scheduleAfterWake()
    await vi.advanceTimersByTimeAsync(OLLAMA_POST_WAKE_DELAY_MS)
    expect(checkOllama).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(OLLAMA_POST_WAKE_RETRY_DELAYS_MS[0] - 10_000)
    expect(checkOllama).toHaveBeenCalledTimes(2)
  })

  it('skips post-wake checks once background restarts are paused', async () => {
    const checkOllama = vi.fn().mockResolvedValue(undefined)
    const isPaused = vi.fn().mockReturnValue(true)
    vi.useFakeTimers()
    const scheduler = createOllamaPostWakeScheduler({ checkOllama, isPaused })
    scheduler.scheduleAfterWake()
    await vi.advanceTimersByTimeAsync(OLLAMA_POST_WAKE_DELAY_MS)
    expect(checkOllama).not.toHaveBeenCalled()
  })

  it('skips a scheduled check after stop() changes the lifecycle epoch', async () => {
    const checkOllama = vi.fn().mockResolvedValue(undefined)
    let epoch = 1
    vi.useFakeTimers()
    const scheduler = createOllamaPostWakeScheduler({
      checkOllama,
      captureEpoch: () => epoch,
      isEpochCurrent: (scheduled) => scheduled === epoch
    })
    scheduler.scheduleAfterWake()
    epoch += 1
    await vi.advanceTimersByTimeAsync(OLLAMA_POST_WAKE_DELAY_MS)
    expect(checkOllama).not.toHaveBeenCalled()

    epoch = 1
    scheduler.scheduleAfterWake()
    scheduler.clearPending()
    await vi.advanceTimersByTimeAsync(OLLAMA_POST_WAKE_DELAY_MS)
    expect(checkOllama).not.toHaveBeenCalled()
  })

  it('clears a pending check on cancel so quit does not restart Ollama', async () => {
    const checkOllama = vi.fn().mockResolvedValue(undefined)
    vi.useFakeTimers()
    const scheduler = createOllamaPostWakeScheduler({ checkOllama })
    scheduler.scheduleAfterWake()
    scheduler.cancel()
    await vi.advanceTimersByTimeAsync(OLLAMA_POST_WAKE_DELAY_MS)
    scheduler.scheduleAfterWake()
    await vi.advanceTimersByTimeAsync(OLLAMA_POST_WAKE_DELAY_MS)

    expect(checkOllama).not.toHaveBeenCalled()
  })

  it('is active during delay, hold, and retry backoff, and idle after success, give-up, clear, or cancel', async () => {
    vi.useFakeTimers()
    const successfulCheck = vi.fn().mockResolvedValue(undefined)
    const stillRunning = vi.fn().mockResolvedValue(true)
    const successScheduler = createOllamaPostWakeScheduler({
      checkOllama: successfulCheck,
      isServerRunning: stillRunning
    })
    expect(successScheduler.isActive()).toBe(false)
    successScheduler.scheduleAfterWake()
    expect(successScheduler.isActive()).toBe(true)

    await vi.advanceTimersByTimeAsync(OLLAMA_POST_WAKE_DELAY_MS)
    expect(successfulCheck).toHaveBeenCalledTimes(1)
    expect(successScheduler.isActive()).toBe(true)

    await vi.advanceTimersByTimeAsync(OLLAMA_POST_WAKE_READY_HOLD_MS)
    expect(stillRunning).toHaveBeenCalledTimes(1)
    expect(successScheduler.isActive()).toBe(false)

    const failedCheck = vi.fn().mockRejectedValue(new Error('serve failed to start'))
    const failedScheduler = createOllamaPostWakeScheduler({ checkOllama: failedCheck })
    failedScheduler.scheduleAfterWake()
    expect(failedScheduler.isActive()).toBe(true)
    await vi.advanceTimersByTimeAsync(OLLAMA_POST_WAKE_DELAY_MS)
    expect(failedCheck).toHaveBeenCalledTimes(1)
    expect(failedScheduler.isActive()).toBe(true)

    await vi.advanceTimersByTimeAsync(OLLAMA_POST_WAKE_RETRY_DELAYS_MS[0])
    expect(failedCheck).toHaveBeenCalledTimes(2)
    expect(failedScheduler.isActive()).toBe(true)

    await vi.advanceTimersByTimeAsync(OLLAMA_POST_WAKE_RETRY_DELAYS_MS[1])
    expect(failedCheck).toHaveBeenCalledTimes(3)
    expect(failedScheduler.isActive()).toBe(false)

    const pendingScheduler = createOllamaPostWakeScheduler({
      checkOllama: vi.fn().mockResolvedValue(undefined)
    })
    pendingScheduler.scheduleAfterWake()
    expect(pendingScheduler.isActive()).toBe(true)
    pendingScheduler.clearPending()
    expect(pendingScheduler.isActive()).toBe(false)

    const cancelledScheduler = createOllamaPostWakeScheduler({
      checkOllama: vi.fn().mockResolvedValue(undefined)
    })
    cancelledScheduler.scheduleAfterWake()
    expect(cancelledScheduler.isActive()).toBe(true)
    cancelledScheduler.cancel()
    expect(cancelledScheduler.isActive()).toBe(false)
  })
})
