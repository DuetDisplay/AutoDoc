import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerLlmIpc } from '../llm-ipc'

const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
  }
}))

function registerWith(
  isServerRunning: () => Promise<boolean>,
  ensureOllamaRunning: (options?: { force?: boolean }) => void,
  startSetupFromStatusCheck?: boolean,
  onManualSegmentationRetry?: (meetingId: string) => void,
  setupPhase: 'starting' | 'ready' = 'starting',
  lifecycle: {
    captureLifecycleEpoch: () => number
    assertLifecycleEpoch: (epoch: number) => void
  } = {
    captureLifecycleEpoch: () => 0,
    assertLifecycleEpoch: () => {}
  }
) {
  const retry = vi.fn()
  const getActivity = vi.fn((): 'waiting-for-local-ai' | null => null)
  registerLlmIpc(
    {
      retry,
      getActivity
    } as never,
    {
      isServerRunning,
      ...lifecycle
    } as never,
    {
      getModel: () => 'llama3.1'
    } as never,
    () => ({ phase: setupPhase, percent: setupPhase === 'ready' ? 100 : 0 }),
    ensureOllamaRunning,
    startSetupFromStatusCheck,
    onManualSegmentationRetry
  )
  return { retry, getActivity }
}

describe('registerLlmIpc', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
  })

  it('keeps status checks passive when setup is already coordinated elsewhere', async () => {
    const ensureOllamaRunning = vi.fn()
    registerWith(vi.fn().mockResolvedValue(false), ensureOllamaRunning, false)

    await expect(handlers.get('ollama:check-status')?.({})).resolves.toBe(false)

    expect(ensureOllamaRunning).not.toHaveBeenCalled()
  })

  it('force-replaces a dead serve after coordinated setup already finished', async () => {
    const ensureOllamaRunning = vi.fn()
    registerWith(vi.fn().mockResolvedValue(false), ensureOllamaRunning, false, undefined, 'ready')

    await expect(handlers.get('ollama:check-status')?.({})).resolves.toBe(false)
    expect(ensureOllamaRunning).not.toHaveBeenCalled()

    await expect(handlers.get('ollama:check-status')?.({})).resolves.toBe(false)
    expect(ensureOllamaRunning).toHaveBeenCalledWith({ force: true })
  })

  it('preserves the existing active status-check behavior by default', async () => {
    const ensureOllamaRunning = vi.fn()
    registerWith(vi.fn().mockResolvedValue(false), ensureOllamaRunning)

    await expect(handlers.get('ollama:check-status')?.({})).resolves.toBe(false)

    expect(ensureOllamaRunning).toHaveBeenCalledTimes(1)
    expect(ensureOllamaRunning).toHaveBeenCalledWith(undefined)
  })

  it('force-restarts a hung Ollama serve after two failed health checks', async () => {
    const ensureOllamaRunning = vi.fn()
    registerWith(vi.fn().mockResolvedValue(false), ensureOllamaRunning)

    await expect(handlers.get('ollama:check-status')?.({})).resolves.toBe(false)
    await expect(handlers.get('ollama:check-status')?.({})).resolves.toBe(false)

    expect(ensureOllamaRunning).toHaveBeenNthCalledWith(1, undefined)
    expect(ensureOllamaRunning).toHaveBeenNthCalledWith(2, { force: true })
  })

  it('does not force-restart after a later healthy check', async () => {
    const ensureOllamaRunning = vi.fn()
    const isServerRunning = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    registerWith(isServerRunning, ensureOllamaRunning)

    await expect(handlers.get('ollama:check-status')?.({})).resolves.toBe(false)
    await expect(handlers.get('ollama:check-status')?.({})).resolves.toBe(true)
    await expect(handlers.get('ollama:check-status')?.({})).resolves.toBe(false)

    expect(ensureOllamaRunning).toHaveBeenCalledTimes(2)
    expect(ensureOllamaRunning).toHaveBeenNthCalledWith(1, undefined)
    expect(ensureOllamaRunning).toHaveBeenNthCalledWith(2, undefined)
  })

  it('does not restart from a stale status check after the manager is stopped', async () => {
    let lifecycleEpoch = 0
    let releaseHealthCheck!: (running: boolean) => void
    const isServerRunning = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          releaseHealthCheck = resolve
        })
    )
    const ensureOllamaRunning = vi.fn()
    registerWith(isServerRunning, ensureOllamaRunning, true, undefined, 'ready', {
      captureLifecycleEpoch: () => lifecycleEpoch,
      assertLifecycleEpoch: (expectedEpoch) => {
        if (expectedEpoch !== lifecycleEpoch) {
          throw new Error('start cancelled by stop()')
        }
      }
    })

    const status = handlers.get('ollama:check-status')?.({}) as Promise<boolean>
    lifecycleEpoch += 1
    releaseHealthCheck(false)

    await expect(status).resolves.toBe(false)
    expect(ensureOllamaRunning).not.toHaveBeenCalled()
  })

  it('marks manual segmentation retries before retrying notes', async () => {
    const onManualSegmentationRetry = vi.fn()
    const { retry } = registerWith(
      vi.fn().mockResolvedValue(true),
      vi.fn(),
      true,
      onManualSegmentationRetry
    )

    await handlers.get('segmentation:retry')?.({}, 'meeting-123')

    expect(onManualSegmentationRetry).toHaveBeenCalledWith('meeting-123')
    expect(onManualSegmentationRetry.mock.invocationCallOrder[0]).toBeLessThan(
      retry.mock.invocationCallOrder[0]
    )
    expect(retry).toHaveBeenCalledWith('meeting-123')
  })

  it('routes activity queries to the requested recording', async () => {
    const { getActivity } = registerWith(vi.fn().mockResolvedValue(true), vi.fn())
    getActivity.mockReturnValue('waiting-for-local-ai')

    expect(handlers.get('segmentation:get-activity')?.({}, 'meeting-123')).toBe(
      'waiting-for-local-ai'
    )
    expect(getActivity).toHaveBeenCalledWith('meeting-123')
  })
})
