import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OLLAMA_POST_WAKE_DELAY_MS,
  OLLAMA_POST_WAKE_RETRY_DELAYS_MS,
  createOllamaPostWakeScheduler
} from '../ollama-post-wake'

afterEach(() => {
  vi.useRealTimers()
})

describe('ollama post-wake scheduler', () => {
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

  it('retries a failed post-wake start at 60s and 180s, then stops', async () => {
    const checkOllama = vi.fn().mockRejectedValue(new Error('serve failed to start'))
    vi.useFakeTimers()
    const scheduler = createOllamaPostWakeScheduler({ checkOllama })
    scheduler.scheduleAfterWake()
    await vi.advanceTimersByTimeAsync(OLLAMA_POST_WAKE_DELAY_MS)
    expect(checkOllama).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(OLLAMA_POST_WAKE_RETRY_DELAYS_MS[0])
    expect(checkOllama).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(OLLAMA_POST_WAKE_RETRY_DELAYS_MS[1])
    expect(checkOllama).toHaveBeenCalledTimes(3)

    await vi.advanceTimersByTimeAsync(OLLAMA_POST_WAKE_RETRY_DELAYS_MS[1])
    expect(checkOllama).toHaveBeenCalledTimes(3)
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
