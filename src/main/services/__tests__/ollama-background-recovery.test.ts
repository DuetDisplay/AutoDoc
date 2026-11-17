import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../autodoc-log', () => ({ logAutodocEvent: vi.fn(), logAutodocFailure: vi.fn() }))

import { createOllamaBackgroundRecovery } from '../ollama-background-recovery'

const RESTART_DELAY_MS = 3_000
const BUDGET_WINDOW_MS = 10 * 60_000

function setup() {
  const state = { running: false, starting: false, epoch: 1, defer: false }
  const start = vi.fn().mockResolvedValue(undefined)
  const isServerRunning = vi.fn(async () => state.running)
  const recovery = createOllamaBackgroundRecovery({
    isServerRunning,
    isStarting: () => state.starting,
    captureEpoch: () => state.epoch,
    isEpochCurrent: (epoch) => epoch === state.epoch,
    shouldDefer: () => state.defer,
    start
  })
  return { state, start, isServerRunning, recovery }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ollama background recovery', () => {
  describe('after an unexpected exit', () => {
    it('restarts once after a short delay', async () => {
      const { start, recovery } = setup()

      recovery.scheduleAfterExit()
      await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS - 1)
      expect(start).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      expect(start).toHaveBeenCalledTimes(1)
    })

    it('coalesces repeated exits into one restart', async () => {
      const { start, recovery } = setup()

      recovery.scheduleAfterExit()
      await vi.advanceTimersByTimeAsync(1_000)
      recovery.scheduleAfterExit()
      await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS)

      expect(start).toHaveBeenCalledTimes(1)
    })

    it('does not restart or charge the budget when the server is healthy again', async () => {
      const { state, start, recovery } = setup()
      state.running = true

      recovery.scheduleAfterExit()
      await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS)
      expect(start).not.toHaveBeenCalled()

      for (let run = 0; run < 3; run += 1) recovery.requestFromPoll()
      expect(start).toHaveBeenCalledTimes(3)
    })

    it('does not start when the app quits during the health probe', async () => {
      const { state, start, isServerRunning, recovery } = setup()
      let finishProbe: (running: boolean) => void = () => {}
      isServerRunning.mockReturnValue(
        new Promise<boolean>((resolve) => {
          finishProbe = resolve
        })
      )

      recovery.scheduleAfterExit()
      await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS)
      state.epoch += 1
      finishProbe(false)
      await vi.advanceTimersByTimeAsync(0)

      expect(start).not.toHaveBeenCalled()
    })

    it('does not start when a deferral begins during the health probe', async () => {
      const { state, start, isServerRunning, recovery } = setup()
      let finishProbe: (running: boolean) => void = () => {}
      isServerRunning.mockReturnValue(
        new Promise<boolean>((resolve) => {
          finishProbe = resolve
        })
      )

      recovery.scheduleAfterExit()
      await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS)
      state.defer = true
      finishProbe(false)
      await vi.advanceTimersByTimeAsync(0)

      expect(start).not.toHaveBeenCalled()
    })

    it('treats a failed health probe as not running', async () => {
      const { start, isServerRunning, recovery } = setup()
      isServerRunning.mockRejectedValue(new Error('probe failed'))

      recovery.scheduleAfterExit()
      await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS)

      expect(start).toHaveBeenCalledTimes(1)
    })

    it('does not surface a failed restart as an unhandled rejection', async () => {
      const { start, recovery } = setup()
      start.mockRejectedValue(new Error('start failed'))

      recovery.scheduleAfterExit()
      await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS)

      expect(start).toHaveBeenCalledTimes(1)
    })
  })

  describe('shared budget', () => {
    it('allows three runs across exit and poll triggers, then suppresses more', async () => {
      const { start, recovery } = setup()

      recovery.scheduleAfterExit()
      await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS)
      recovery.requestFromPoll()
      recovery.scheduleAfterExit()
      await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS)
      expect(start).toHaveBeenCalledTimes(3)

      recovery.requestFromPoll()
      recovery.scheduleAfterExit()
      await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS)

      expect(start).toHaveBeenCalledTimes(3)
    })

    it('allows another run once the window has passed', async () => {
      const { start, recovery } = setup()
      for (let run = 0; run < 3; run += 1) recovery.requestFromPoll()
      recovery.requestFromPoll()
      expect(start).toHaveBeenCalledTimes(3)

      await vi.advanceTimersByTimeAsync(BUDGET_WINDOW_MS)
      recovery.requestFromPoll()

      expect(start).toHaveBeenCalledTimes(4)
    })

    it('does not charge a request that joins work already starting', async () => {
      const { state, start, recovery } = setup()

      state.starting = true
      for (let run = 0; run < 5; run += 1) recovery.requestFromPoll()
      recovery.scheduleAfterExit()
      await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS)
      expect(start).not.toHaveBeenCalled()

      state.starting = false
      for (let run = 0; run < 3; run += 1) recovery.requestFromPoll()
      expect(start).toHaveBeenCalledTimes(3)
    })

    it('does not start or charge while deferred', () => {
      const { state, start, recovery } = setup()

      state.defer = true
      recovery.requestFromPoll()
      expect(start).not.toHaveBeenCalled()

      state.defer = false
      for (let run = 0; run < 3; run += 1) recovery.requestFromPoll()
      expect(start).toHaveBeenCalledTimes(3)
    })

    it('starts over after an explicit user retry', () => {
      const { start, recovery } = setup()
      for (let run = 0; run < 3; run += 1) recovery.requestFromPoll()

      recovery.resetBudget()
      recovery.requestFromPoll()

      expect(start).toHaveBeenCalledTimes(4)
    })
  })
})
