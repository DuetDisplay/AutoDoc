import { describe, expect, it, vi } from 'vitest'
import { SafeQuitCoordinator } from '../safe-quit'

describe('safe quit', () => {
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
