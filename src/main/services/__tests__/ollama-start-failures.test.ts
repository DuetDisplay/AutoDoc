import { afterEach, describe, expect, it, vi } from 'vitest'

const { logAutodocEvent } = vi.hoisted(() => ({
  logAutodocEvent: vi.fn()
}))

vi.mock('../autodoc-log', () => ({
  logAutodocEvent,
  logAutodocFailure: vi.fn()
}))

import {
  OLLAMA_POST_WAKE_DELAY_MS,
  OLLAMA_POST_WAKE_READY_HOLD_MS,
  OLLAMA_POST_WAKE_RETRY_DELAYS_MS,
  createOllamaPostWakeScheduler
} from '../ollama-post-wake'
import {
  areBackgroundOllamaRestartsPaused,
  recordOllamaPostWakeCheckFailed,
  recordOllamaPostWakeCheckSucceeded,
  recordOllamaServeStable,
  recordOllamaStartFailure,
  recordOllamaStartSuccess,
  resetOllamaStartFailureStreak
} from '../ollama-start-failures'

afterEach(() => {
  resetOllamaStartFailureStreak()
  logAutodocEvent.mockClear()
  vi.useRealTimers()
})

describe('ollama post-wake failure cap', () => {
  it('pauses background restarts after three failed wakes and logs once', () => {
    recordOllamaPostWakeCheckFailed()
    recordOllamaPostWakeCheckFailed()
    expect(areBackgroundOllamaRestartsPaused()).toBe(false)
    expect(logAutodocEvent).not.toHaveBeenCalled()

    recordOllamaPostWakeCheckFailed()
    expect(areBackgroundOllamaRestartsPaused()).toBe(true)
    expect(logAutodocEvent).toHaveBeenCalledTimes(1)
    expect(logAutodocEvent).toHaveBeenCalledWith({
      area: 'ollama',
      message: 'ollama restarts paused after repeated start failures'
    })

    recordOllamaPostWakeCheckFailed()
    expect(logAutodocEvent).toHaveBeenCalledTimes(1)
  })

  it('does not pause after individual start() failures', () => {
    for (let i = 0; i < 5; i++) {
      recordOllamaStartFailure()
    }
    expect(areBackgroundOllamaRestartsPaused()).toBe(false)
    expect(logAutodocEvent).not.toHaveBeenCalled()
  })

  it('does not clear an existing pause on start success alone', () => {
    for (let i = 0; i < 3; i++) {
      recordOllamaPostWakeCheckFailed()
    }
    expect(areBackgroundOllamaRestartsPaused()).toBe(true)

    recordOllamaStartSuccess()
    expect(areBackgroundOllamaRestartsPaused()).toBe(true)
  })

  it('clears the pause after a successful post-wake hold or a stable serve', () => {
    for (let i = 0; i < 3; i++) {
      recordOllamaPostWakeCheckFailed()
    }
    recordOllamaPostWakeCheckSucceeded()
    expect(areBackgroundOllamaRestartsPaused()).toBe(false)

    for (let i = 0; i < 3; i++) {
      recordOllamaPostWakeCheckFailed()
    }
    recordOllamaServeStable()
    expect(areBackgroundOllamaRestartsPaused()).toBe(false)
    expect(logAutodocEvent).toHaveBeenCalledTimes(2)
  })

  it('pauses after three wakes that resolve start then die before the hold', async () => {
    const checkOllama = vi.fn().mockImplementation(async () => {
      recordOllamaStartSuccess()
    })
    const isServerRunning = vi.fn().mockResolvedValue(false)
    vi.useFakeTimers()
    const scheduler = createOllamaPostWakeScheduler({
      checkOllama,
      isServerRunning,
      onWakeSucceeded: recordOllamaPostWakeCheckSucceeded,
      onWakeFailed: recordOllamaPostWakeCheckFailed
    })

    for (let i = 0; i < 3; i++) {
      scheduler.scheduleAfterWake()
      await vi.advanceTimersByTimeAsync(OLLAMA_POST_WAKE_DELAY_MS)
      await vi.advanceTimersByTimeAsync(OLLAMA_POST_WAKE_READY_HOLD_MS)
      await vi.advanceTimersByTimeAsync(OLLAMA_POST_WAKE_RETRY_DELAYS_MS[0])
      await vi.advanceTimersByTimeAsync(OLLAMA_POST_WAKE_READY_HOLD_MS)
      await vi.advanceTimersByTimeAsync(OLLAMA_POST_WAKE_RETRY_DELAYS_MS[1])
      await vi.advanceTimersByTimeAsync(OLLAMA_POST_WAKE_READY_HOLD_MS)
    }

    expect(areBackgroundOllamaRestartsPaused()).toBe(true)
    expect(logAutodocEvent).toHaveBeenCalledTimes(1)
    expect(logAutodocEvent).toHaveBeenCalledWith({
      area: 'ollama',
      message: 'ollama restarts paused after repeated start failures'
    })

    recordOllamaStartSuccess()
    expect(areBackgroundOllamaRestartsPaused()).toBe(true)

    recordOllamaServeStable()
    expect(areBackgroundOllamaRestartsPaused()).toBe(false)
  })
})
