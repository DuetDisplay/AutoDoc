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
  recordOllamaStartFailure,
  recordOllamaStartSuccess,
  resetOllamaStartFailureStreak
} from '../ollama-start-failures'

afterEach(() => {
  resetOllamaStartFailureStreak()
  logAutodocEvent.mockClear()
})

describe('ollama start-failure cap', () => {
  it('pauses background restarts after five failures and logs once', () => {
    for (let i = 0; i < 4; i++) {
      recordOllamaStartFailure()
    }
    expect(areBackgroundOllamaRestartsPaused()).toBe(false)
    expect(logAutodocEvent).not.toHaveBeenCalled()

    recordOllamaStartFailure()
    expect(areBackgroundOllamaRestartsPaused()).toBe(true)
    expect(logAutodocEvent).toHaveBeenCalledTimes(1)
    expect(logAutodocEvent).toHaveBeenCalledWith({
      area: 'ollama',
      message: 'ollama restarts paused after repeated start failures'
    })

    recordOllamaStartFailure()
    expect(logAutodocEvent).toHaveBeenCalledTimes(1)
  })

  it('clears the pause after a successful start', () => {
    for (let i = 0; i < 5; i++) {
      recordOllamaStartFailure()
    }
    recordOllamaStartSuccess()
    expect(areBackgroundOllamaRestartsPaused()).toBe(false)

    recordOllamaStartFailure()
    expect(areBackgroundOllamaRestartsPaused()).toBe(false)
    expect(logAutodocEvent).toHaveBeenCalledTimes(1)
  })
})
