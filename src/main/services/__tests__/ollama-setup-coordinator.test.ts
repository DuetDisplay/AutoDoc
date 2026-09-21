import { afterEach, describe, expect, it, vi } from 'vitest'
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

afterEach(() => {
  vi.useRealTimers()
})

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

  it('documents cached startAndPull finishing without a fresh pull-complete event', async () => {
    const manager = {
      startAndPull: vi.fn().mockResolvedValue(undefined)
    }
    const onAttemptStart = vi.fn()
    const coordinator = new OllamaSetupCoordinator(manager, {
      retryDelaysMs: [0],
      onAttemptStart
    })

    await coordinator.ensureRunning()
    expect(onAttemptStart).toHaveBeenCalledTimes(1)

    // A later recovery re-enters setup, but startAndPull may resolve from cache without
    // emitting pull-complete — the parent must mark ready on ensureRunning().then(...).
    await coordinator.ensureRunning()
    expect(manager.startAndPull).toHaveBeenCalledTimes(2)
    expect(onAttemptStart).toHaveBeenCalledTimes(2)
  })

  it('clears a cached runner on force so a hung serve can be replaced', async () => {
    const resetReady = vi.fn()
    const manager = {
      startAndPull: vi.fn().mockResolvedValue(undefined),
      resetReady
    }
    const coordinator = new OllamaSetupCoordinator(manager, {
      retryDelaysMs: [0]
    })

    await coordinator.ensureRunning()
    await coordinator.ensureRunning()
    expect(resetReady).not.toHaveBeenCalled()

    await coordinator.ensureRunning({ force: true })
    expect(resetReady).toHaveBeenCalledTimes(1)
    expect(manager.startAndPull).toHaveBeenCalledTimes(3)
  })

  it('does not let a delayed retry revive a lifecycle cancelled by stop()', async () => {
    vi.useFakeTimers()
    let lifecycleEpoch = 0
    let stopped = false
    const cancellation = (): Error & { code: string } =>
      Object.assign(new Error('start cancelled by stop()'), {
        code: 'OLLAMA_START_CANCELLED'
      })
    const manager = {
      beginSetupLifecycle: vi.fn(() => {
        stopped = false
        return lifecycleEpoch
      }),
      assertLifecycleEpoch: vi.fn((expectedEpoch: number) => {
        if (stopped || expectedEpoch !== lifecycleEpoch) throw cancellation()
      }),
      startAndPull: vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(new Error('transient download failure'))
        .mockResolvedValue(undefined)
    }
    const onFinalError = vi.fn()
    const coordinator = new OllamaSetupCoordinator(manager, {
      retryDelaysMs: [0, 5_000],
      onFinalError,
      isCancellationError: (error) =>
        error instanceof Error && 'code' in error && error.code === 'OLLAMA_START_CANCELLED'
    })

    const setup = coordinator.ensureRunning()
    const cancelled = expect(setup).rejects.toMatchObject({
      code: 'OLLAMA_START_CANCELLED'
    })
    await Promise.resolve()
    expect(manager.startAndPull).toHaveBeenCalledTimes(1)

    stopped = true
    lifecycleEpoch += 1
    expect(manager.startAndPull).toHaveBeenCalledTimes(1)
    const forcedSetup = coordinator.ensureRunning({ force: true })
    await vi.advanceTimersByTimeAsync(250)
    await cancelled

    expect(onFinalError).not.toHaveBeenCalled()

    await expect(forcedSetup).resolves.toBeUndefined()
    expect(manager.startAndPull).toHaveBeenCalledTimes(2)
  })

  it('does not let a readiness waiter reactivate a stopped runner', async () => {
    const cancellation = Object.assign(new Error('start cancelled by stop()'), {
      code: 'OLLAMA_START_CANCELLED'
    })
    const manager = {
      captureLifecycleEpoch: vi.fn(() => 3),
      assertLifecycleEpoch: vi.fn(() => {
        throw cancellation
      }),
      beginSetupLifecycle: vi.fn(() => 4),
      startAndPull: vi.fn().mockResolvedValue(undefined)
    }
    const coordinator = new OllamaSetupCoordinator(manager, {
      retryDelaysMs: [0],
      isCancellationError: (error) => error === cancellation
    })

    await expect(coordinator.waitUntilReady()).rejects.toBe(cancellation)
    expect(manager.beginSetupLifecycle).not.toHaveBeenCalled()
    expect(manager.startAndPull).not.toHaveBeenCalled()
  })
})
