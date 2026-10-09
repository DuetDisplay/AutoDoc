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
})
