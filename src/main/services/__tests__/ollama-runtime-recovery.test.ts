import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../autodoc-log', () => ({
  logAutodocEvent: vi.fn(),
  logAutodocFailure: vi.fn()
}))

import {
  createOllamaRuntimeRecovery,
  OLLAMA_MODEL_LOAD_FAILED_MESSAGE,
  type OllamaRecoveryManager
} from '../ollama-runtime-recovery'
import {
  OLLAMA_MODEL_LOAD_FAILED_ERROR_CODE,
  createOllamaModelLoadFailedError,
  isOllamaModelLoadFailureError,
  isOllamaModelLoadFailureText
} from '../ollama-model-load-failure'
import { isTransientOllamaRuntimeError } from '../llm'

const STDERR_MODEL_LOAD =
  'error loading model: llama_model_loader: failed to load model from C:\\Users\\[home]\\AppData\\Roaming\\AutoDoc\\ollama-data\\blobs\\sha256-85e4'

function createManager(overrides: Partial<OllamaRecoveryManager> = {}): {
  manager: OllamaRecoveryManager
  failures: { count: number }
} {
  const failures = { count: 0 }
  const manager: OllamaRecoveryManager = {
    captureLifecycleEpoch: () => 1,
    assertLifecycleEpoch: () => {},
    recoverUnhealthyRuntime: vi.fn(async () => {}),
    isServerRunning: vi.fn(async () => true),
    hasUsableNotesModel: vi.fn(async () => true),
    isServeStarting: () => false,
    waitForStartingServe: vi.fn(async () => true),
    startAndPull: vi.fn(async () => {}),
    getModelLoadFailureCount: () => failures.count,
    clearModelLoadFailures: () => {
      failures.count = 0
    },
    ...overrides
  }
  return { manager, failures }
}

function createRecovery(manager: OllamaRecoveryManager) {
  const callbacks = {
    markSetupStarting: vi.fn(),
    markSetupReady: vi.fn(),
    markSetupFailed: vi.fn(),
    onLatchChange: vi.fn()
  }
  const recovery = createOllamaRuntimeRecovery({
    manager,
    ...callbacks,
    isCancellationError: () => false,
    retryDelaysMs: [0, 5, 15],
    sleep: async () => {}
  })
  return { recovery, ...callbacks }
}

describe('model load failure classification', () => {
  it('recognises the llama.cpp load errors and ignores memory shortfalls', () => {
    expect(isOllamaModelLoadFailureText(STDERR_MODEL_LOAD)).toBe(true)
    expect(
      isOllamaModelLoadFailureText(
        'Ollama returned 500: {"error":"llama runner process has terminated: error loading model: llama_model_loader: failed to load model from C:\\x"}'
      )
    ).toBe(true)
    // Printed on every successful load; a later unrelated crash must not latch notes off.
    expect(
      isOllamaModelLoadFailureText(
        'llama_model_loader: loaded meta data with 35 key-value pairs and 398 tensors from C:\\x'
      )
    ).toBe(false)
    // GPU allocation failures stay on the existing recovery path (for example the CPU fallback).
    expect(
      isOllamaModelLoadFailureText(
        'llama runner process has terminated: error loading model: unable to allocate CUDA0 buffer\nllama_model_load_from_file_impl: failed to load model'
      )
    ).toBe(false)
    expect(
      isOllamaModelLoadFailureText(
        'model requires more system memory (9.0 GiB) than is available (4.0 GiB)'
      )
    ).toBe(false)
    expect(isOllamaModelLoadFailureText('fetch failed')).toBe(false)
  })

  it('recognises errors by code or message', () => {
    expect(isOllamaModelLoadFailureError(createOllamaModelLoadFailedError('anything'))).toBe(true)
    expect(isOllamaModelLoadFailureError(new Error(STDERR_MODEL_LOAD))).toBe(true)
    expect(isOllamaModelLoadFailureError(new Error('fetch failed'))).toBe(false)
    expect(isOllamaModelLoadFailureError('error loading model')).toBe(false)
  })

  it('is not a transient runtime error even when the runner also reports termination', () => {
    expect(
      isTransientOllamaRuntimeError(
        `Ollama returned 500: llama runner process has terminated: ${STDERR_MODEL_LOAD}`
      )
    ).toBe(false)
    expect(
      isTransientOllamaRuntimeError('llama runner process has terminated: exit status 2')
    ).toBe(true)
    expect(isTransientOllamaRuntimeError('fetch failed')).toBe(true)
  })
})

describe('createOllamaRuntimeRecovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('marks setup ready after a healthy restart', async () => {
    const { manager } = createManager()
    const { recovery, markSetupStarting, markSetupReady, markSetupFailed } = createRecovery(manager)

    await recovery.recover()

    expect(markSetupStarting).toHaveBeenCalledTimes(1)
    expect(markSetupReady).toHaveBeenCalledTimes(1)
    expect(markSetupFailed).not.toHaveBeenCalled()
    expect(manager.recoverUnhealthyRuntime).toHaveBeenCalledTimes(1)
  })

  it('still retries transient failures up to three attempts', async () => {
    const recoverUnhealthyRuntime = vi
      .fn()
      .mockRejectedValueOnce(new Error('Ollama exited with code 1, signal null'))
      .mockRejectedValueOnce(new Error('Failed to start Ollama: spawn EBUSY'))
      .mockResolvedValueOnce(undefined)
    const { manager } = createManager({ recoverUnhealthyRuntime })
    const { recovery, markSetupReady, markSetupFailed } = createRecovery(manager)

    await recovery.recover()

    expect(recoverUnhealthyRuntime).toHaveBeenCalledTimes(3)
    expect(markSetupReady).toHaveBeenCalledTimes(1)
    expect(markSetupFailed).not.toHaveBeenCalled()
    expect(recovery.isModelLoadLatched()).toBe(false)
  })

  it('fails with the last error after three transient attempts and does not latch', async () => {
    const recoverUnhealthyRuntime = vi.fn(async () => {
      throw new Error('Ollama exited with code 1, signal null')
    })
    const { manager } = createManager({ recoverUnhealthyRuntime })
    const { recovery, markSetupFailed } = createRecovery(manager)

    await expect(recovery.recover()).rejects.toThrow('exited with code 1')

    expect(recoverUnhealthyRuntime).toHaveBeenCalledTimes(3)
    expect(markSetupFailed).toHaveBeenCalledTimes(1)
    expect(markSetupFailed.mock.calls[0]).toHaveLength(1)
    expect(recovery.isModelLoadLatched()).toBe(false)
  })

  it('stops after the first attempt that throws a model-load failure and latches', async () => {
    const recoverUnhealthyRuntime = vi.fn(async () => {
      throw createOllamaModelLoadFailedError(`Ollama exited with code 1: ${STDERR_MODEL_LOAD}`)
    })
    const { manager } = createManager({ recoverUnhealthyRuntime })
    const { recovery, markSetupFailed, onLatchChange } = createRecovery(manager)

    const error = await recovery.recover().catch((e: unknown) => e)

    expect(recoverUnhealthyRuntime).toHaveBeenCalledTimes(1)
    expect(error).toMatchObject({
      message: OLLAMA_MODEL_LOAD_FAILED_MESSAGE,
      code: OLLAMA_MODEL_LOAD_FAILED_ERROR_CODE
    })
    expect(markSetupFailed).toHaveBeenCalledTimes(1)
    expect(markSetupFailed).toHaveBeenCalledWith(error, 'model_load')
    expect(onLatchChange).toHaveBeenCalledWith(true)
    expect(recovery.isModelLoadLatched()).toBe(true)
  })

  it('stops when the serve exits loading the model even though the attempt itself resolved', async () => {
    const { manager, failures } = createManager({
      recoverUnhealthyRuntime: vi.fn(async () => {}),
      isServerRunning: vi.fn(async () => false)
    })
    failures.count = 1
    const { recovery, markSetupFailed } = createRecovery(manager)

    await expect(recovery.recover()).rejects.toThrow(OLLAMA_MODEL_LOAD_FAILED_MESSAGE)

    expect(manager.recoverUnhealthyRuntime).toHaveBeenCalledTimes(1)
    expect(markSetupFailed).toHaveBeenCalledWith(expect.any(Error), 'model_load')
  })

  it('fails fast on later calls without restarting Ollama or touching status', async () => {
    const recoverUnhealthyRuntime = vi.fn(async () => {
      throw createOllamaModelLoadFailedError(STDERR_MODEL_LOAD)
    })
    const { manager } = createManager({ recoverUnhealthyRuntime })
    const { recovery, markSetupStarting, markSetupFailed } = createRecovery(manager)
    await recovery.recover().catch(() => {})

    await expect(recovery.recover()).rejects.toThrow(OLLAMA_MODEL_LOAD_FAILED_MESSAGE)
    await expect(recovery.recover()).rejects.toThrow(OLLAMA_MODEL_LOAD_FAILED_MESSAGE)

    expect(recoverUnhealthyRuntime).toHaveBeenCalledTimes(1)
    expect(markSetupStarting).toHaveBeenCalledTimes(1)
    expect(markSetupFailed).toHaveBeenCalledTimes(1)
  })

  it('does not restart at all after a second model-load exit', async () => {
    const { manager, failures } = createManager()
    failures.count = 2
    const { recovery, markSetupStarting } = createRecovery(manager)

    await expect(recovery.recover()).rejects.toThrow(OLLAMA_MODEL_LOAD_FAILED_MESSAGE)

    expect(manager.recoverUnhealthyRuntime).not.toHaveBeenCalled()
    expect(markSetupStarting).not.toHaveBeenCalled()
  })

  it('latches from a request-level HTTP failure and skips the restart loop', async () => {
    const { manager } = createManager()
    const { recovery, markSetupFailed } = createRecovery(manager)

    recovery.reportModelLoadFailure(`Ollama returned 500: ${STDERR_MODEL_LOAD}`)
    recovery.reportModelLoadFailure(`Ollama returned 500: ${STDERR_MODEL_LOAD}`)

    expect(markSetupFailed).toHaveBeenCalledTimes(1)
    expect(markSetupFailed).toHaveBeenCalledWith(expect.any(Error), 'model_load')
    await expect(recovery.recover()).rejects.toThrow(OLLAMA_MODEL_LOAD_FAILED_MESSAGE)
    expect(manager.recoverUnhealthyRuntime).not.toHaveBeenCalled()
  })

  it('allows one recovery attempt again after an explicit retry clears the latch', async () => {
    const { manager, failures } = createManager()
    const { recovery, markSetupReady, onLatchChange } = createRecovery(manager)
    failures.count = 2
    await recovery.recover().catch(() => {})
    expect(recovery.isModelLoadLatched()).toBe(true)

    recovery.clearModelLoadLatch()

    expect(recovery.isModelLoadLatched()).toBe(false)
    expect(failures.count).toBe(0)
    expect(onLatchChange).toHaveBeenLastCalledWith(false)
    await expect(recovery.recover()).resolves.toBeUndefined()
    expect(manager.recoverUnhealthyRuntime).toHaveBeenCalledTimes(1)
    expect(markSetupReady).toHaveBeenCalledTimes(1)
  })
})
