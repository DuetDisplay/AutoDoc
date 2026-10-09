import { afterEach, describe, expect, it, vi } from 'vitest'

const { logAutodocEvent } = vi.hoisted(() => ({
  logAutodocEvent: vi.fn()
}))

vi.mock('../autodoc-log', () => ({
  logAutodocEvent,
  logAutodocFailure: vi.fn()
}))

import {
  areBackgroundOllamaRestartsPaused,
  recordOllamaPostWakeCheckFailed,
  recordOllamaPostWakeCheckSucceeded,
  recordOllamaStartFailure,
  recordOllamaStartSuccess,
  resetOllamaStartFailureStreak
} from '../ollama-start-failures'

afterEach(() => {
  resetOllamaStartFailureStreak()
  logAutodocEvent.mockClear()
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

  it('clears the pause after a successful start or post-wake check', () => {
    for (let i = 0; i < 3; i++) {
      recordOllamaPostWakeCheckFailed()
    }
    expect(areBackgroundOllamaRestartsPaused()).toBe(true)

    recordOllamaStartSuccess()
    expect(areBackgroundOllamaRestartsPaused()).toBe(false)

    for (let i = 0; i < 3; i++) {
      recordOllamaPostWakeCheckFailed()
    }
    recordOllamaPostWakeCheckSucceeded()
    expect(areBackgroundOllamaRestartsPaused()).toBe(false)
    expect(logAutodocEvent).toHaveBeenCalledTimes(2)
  })
})
