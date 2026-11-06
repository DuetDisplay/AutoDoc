import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SafeQuitCoordinator } from '../safe-quit'
import { AskAiConversationHolds } from '../ask-ai-conversation-hold'

describe('safe quit', () => {
  it('lets the quit proceed when onQuitAllowed throws', () => {
    const coordinator = new SafeQuitCoordinator({
      prepare: vi.fn(),
      quit: vi.fn(),
      onQuitAllowed: () => {
        throw new Error('hook failed')
      },
      onError: vi.fn()
    })
    const event = { preventDefault: vi.fn() }
    coordinator.allowQuit()
    expect(coordinator.beforeQuit(event)).toBe(true)
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('prevents repeated quits until capture and finalization finish', async () => {
    let finish!: () => void
    const prepare = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const quit = vi.fn()
    const coordinator = new SafeQuitCoordinator({ prepare, quit, onError: vi.fn() })
    const event = { preventDefault: vi.fn() }
    expect(coordinator.beforeQuit(event)).toBe(false)
    expect(coordinator.beforeQuit(event)).toBe(false)
    expect(event.preventDefault).toHaveBeenCalledTimes(2)
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(quit).not.toHaveBeenCalled()
    finish()
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1))
    expect(coordinator.beforeQuit(event)).toBe(true)
  })

  it('keeps the app open on failure and allows another quit attempt', async () => {
    const prepare = vi
      .fn()
      .mockRejectedValueOnce(new Error('capture still writing'))
      .mockResolvedValue(undefined)
    const quit = vi.fn()
    const onError = vi.fn()
    const coordinator = new SafeQuitCoordinator({ prepare, quit, onError })
    const event = { preventDefault: vi.fn() }
    coordinator.beforeQuit(event)
    await vi.waitFor(() => expect(onError).toHaveBeenCalled())
    expect(quit).not.toHaveBeenCalled()
    coordinator.beforeQuit(event)
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1))
  })
})

it('keeps Ask AI holds usable after failed update preflight and shuts them down only on an allowed before-quit', async () => {
  const holds = new AskAiConversationHolds(),
    resume = vi.fn(),
    quit = vi.fn()
  const shutdown = vi.fn(() => holds.shutdown())
  const safeQuit = new SafeQuitCoordinator({
    prepare: async () => {},
    quit,
    onError: vi.fn(),
    onQuitAllowed: shutdown
  })
  const end = await holds.begin(1, async () => resume)
  // prepareForInstall / before-quit-for-update do not actually allow app exit.
  safeQuit.allowQuit()
  expect(shutdown).not.toHaveBeenCalled()
  safeQuit.cancelPreparedQuit() // onInstallFailed
  const again = await holds.begin(1, async () => resume)
  const event = { preventDefault: vi.fn() }
  expect(safeQuit.beforeQuit(event)).toBe(false)
  expect(shutdown).not.toHaveBeenCalled()
  await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce())
  expect(safeQuit.beforeQuit(event)).toBe(true)
  expect(shutdown).toHaveBeenCalledOnce()
  end()
  again()
  expect(resume).not.toHaveBeenCalled()
  await expect(holds.begin(2, async () => resume)).rejects.toMatchObject({ name: 'AbortError' })
})

describe('quits that never finish', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('gives up on a hung prepare so quitting can be retried', async () => {
    const onError = vi.fn()
    const quit = vi.fn()
    const prepare = vi.fn(() => new Promise<void>(() => {}))
    const coordinator = new SafeQuitCoordinator({ prepare, quit, onError })
    const event = { preventDefault: vi.fn() }

    coordinator.beforeQuit(event)
    await vi.advanceTimersByTimeAsync(120_000)

    expect(onError).toHaveBeenCalledOnce()
    expect(quit).not.toHaveBeenCalled()
    coordinator.beforeQuit(event)
    expect(prepare).toHaveBeenCalledTimes(2)
  })

  it('does not quit when prepare finishes after it timed out', async () => {
    let finish!: () => void
    const quit = vi.fn()
    const coordinator = new SafeQuitCoordinator({
      prepare: () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
      quit,
      onError: vi.fn()
    })

    coordinator.beforeQuit({ preventDefault: vi.fn() })
    await vi.advanceTimersByTimeAsync(120_000)
    finish()
    await vi.advanceTimersByTimeAsync(0)

    expect(quit).not.toHaveBeenCalled()
  })

  it('reports once when the process is still alive after an allowed quit', async () => {
    const onQuitStalled = vi.fn()
    const coordinator = new SafeQuitCoordinator({
      prepare: vi.fn(),
      quit: vi.fn(),
      onError: vi.fn(),
      onQuitStalled
    })
    coordinator.allowQuit()

    coordinator.beforeQuit({ preventDefault: vi.fn() })
    coordinator.beforeQuit({ preventDefault: vi.fn() })
    await vi.advanceTimersByTimeAsync(59_999)
    expect(onQuitStalled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    expect(onQuitStalled).toHaveBeenCalledOnce()
  })

  it('does not force an exit after the quit was cancelled', async () => {
    const onQuitStalled = vi.fn()
    const coordinator = new SafeQuitCoordinator({
      prepare: vi.fn(),
      quit: vi.fn(),
      onError: vi.fn(),
      onQuitStalled
    })
    coordinator.allowQuit()
    coordinator.beforeQuit({ preventDefault: vi.fn() })

    coordinator.cancelPreparedQuit()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(onQuitStalled).not.toHaveBeenCalled()
  })
})
