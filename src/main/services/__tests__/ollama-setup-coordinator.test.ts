import { describe, expect, it, vi } from 'vitest'
import { OllamaSetupCoordinator } from '../ollama-setup-coordinator'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('OllamaSetupCoordinator', () => {
  it('shares one in-flight setup attempt across callers', async () => {
    const setup = deferred()
    const manager = {
      startAndPull: vi.fn(() => setup.promise)
    }
    const coordinator = new OllamaSetupCoordinator(manager, {
      retryDelaysMs: [0]
    })

    const first = coordinator.ensureRunning()
    const second = coordinator.ensureRunning()
    await Promise.resolve()

    expect(manager.startAndPull).toHaveBeenCalledTimes(1)
    setup.resolve()
    await expect(first).resolves.toBeUndefined()
    await expect(second).resolves.toBeUndefined()
  })

  it('retries sequentially after failures without overlapping attempts', async () => {
    let activeAttempts = 0
    let maxActiveAttempts = 0
    const manager = {
      startAndPull: vi.fn(async () => {
        activeAttempts += 1
        maxActiveAttempts = Math.max(maxActiveAttempts, activeAttempts)
        await Promise.resolve()
        activeAttempts -= 1
        if (manager.startAndPull.mock.calls.length < 3) {
          throw new Error('transient download failure')
        }
      })
    }
    const coordinator = new OllamaSetupCoordinator(manager, {
      retryDelaysMs: [0, 0, 0]
    })

    await expect(coordinator.ensureRunning()).resolves.toBeUndefined()

    expect(manager.startAndPull).toHaveBeenCalledTimes(3)
    expect(maxActiveAttempts).toBe(1)
  })

  it('stops after the automatic retry budget until a manual retry resets it', async () => {
    const manager = {
      startAndPull: vi.fn().mockRejectedValueOnce(new Error('download failed'))
    }
    const coordinator = new OllamaSetupCoordinator(manager, {
      retryDelaysMs: [0]
    })

    await expect(coordinator.ensureRunning()).rejects.toThrow('download failed')
    await expect(coordinator.ensureRunning()).rejects.toThrow('download failed')
    expect(manager.startAndPull).toHaveBeenCalledTimes(1)

    manager.startAndPull.mockResolvedValueOnce(undefined)
    await expect(coordinator.ensureRunning({ force: true })).resolves.toBeUndefined()
    expect(manager.startAndPull).toHaveBeenCalledTimes(2)
  })
})
