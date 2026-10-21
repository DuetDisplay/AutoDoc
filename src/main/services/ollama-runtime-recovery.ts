import { logAutodocEvent } from './autodoc-log'
import {
  createOllamaModelLoadFailedError,
  isOllamaModelLoadFailureError
} from './ollama-model-load-failure'
import type { OllamaSetupStatus } from '../../shared/types'

export const OLLAMA_MODEL_LOAD_FAILED_MESSAGE = "AutoDoc couldn't load the notes model."

const DEFAULT_RETRY_DELAYS_MS = [0, 5_000, 15_000]

export interface OllamaRecoveryManager {
  captureLifecycleEpoch(): number
  assertLifecycleEpoch(epoch: number): void
  recoverUnhealthyRuntime(): Promise<void>
  isServerRunning(): Promise<boolean>
  hasUsableNotesModel(): Promise<boolean>
  isServeStarting(): boolean
  waitForStartingServe(): Promise<boolean>
  startAndPull(): Promise<void>
  /** Serve exits caused by the model file failing to load since the last clear. */
  getModelLoadFailureCount(): number
  clearModelLoadFailures(): void
}

export interface OllamaRuntimeRecoveryOptions {
  manager: OllamaRecoveryManager
  markSetupStarting(): void
  markSetupReady(): void
  markSetupFailed(error: unknown, failedStep?: OllamaSetupStatus['failedStep']): void
  isCancellationError(error: unknown): boolean
  /** Lets the status code stop reporting "ready" while the model cannot load. */
  onLatchChange?(latched: boolean): void
  retryDelaysMs?: number[]
  sleep?(ms: number): Promise<void>
}

export interface OllamaRuntimeRecovery {
  recover(): Promise<void>
  /** Called by a notes request whose HTTP error says the model could not be loaded. */
  reportModelLoadFailure(message: string): void
  /** Called by explicit user retry paths; allows one more recovery attempt. */
  clearModelLoadLatch(): void
  isModelLoadLatched(): boolean
}

/**
 * Restarts an unhealthy Ollama and waits for it to serve the notes model, with
 * bounded retries. A model that cannot be loaded (for example a models path the
 * runner cannot open) is not fixed by restarting, so the first such failure stops
 * the loop and latches for the rest of the session: later calls fail immediately
 * without touching the serve until the user retries explicitly.
 */
export function createOllamaRuntimeRecovery(
  options: OllamaRuntimeRecoveryOptions
): OllamaRuntimeRecovery {
  const { manager } = options
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  let latchedError: Error | null = null

  const latch = (reason: string, detail: unknown): Error => {
    if (latchedError) return latchedError
    const cause = detail instanceof Error ? detail : new Error(String(detail))
    latchedError = Object.assign(
      createOllamaModelLoadFailedError(OLLAMA_MODEL_LOAD_FAILED_MESSAGE),
      {
        cause
      }
    )
    options.onLatchChange?.(true)
    logAutodocEvent({
      area: 'ollama',
      message: 'ollama notes model failed to load; recovery latched off',
      level: 'warn',
      context: { reason, modelLoadFailures: manager.getModelLoadFailureCount() }
    })
    options.markSetupFailed(latchedError, 'model_load')
    return latchedError
  }

  const recover = async (): Promise<void> => {
    if (latchedError) throw latchedError

    const recoveryEpoch = manager.captureLifecycleEpoch()
    manager.assertLifecycleEpoch(recoveryEpoch)
    // A second model-load crash proves a restart did not help; do not try again.
    if (manager.getModelLoadFailureCount() >= 2) {
      throw latch('repeated-model-load-exit', 'repeated model load failures before recovery')
    }
    options.markSetupStarting()
    let lastError: Error | null = null
    for (let attemptIndex = 0; attemptIndex < retryDelaysMs.length; attemptIndex++) {
      const delayMs = retryDelaysMs[attemptIndex]
      if (delayMs > 0) {
        await sleep(delayMs)
        manager.assertLifecycleEpoch(recoveryEpoch)
      }
      try {
        manager.assertLifecycleEpoch(recoveryEpoch)
        await manager.recoverUnhealthyRuntime()
        manager.assertLifecycleEpoch(recoveryEpoch)

        let serverRunning = await manager.isServerRunning()
        manager.assertLifecycleEpoch(recoveryEpoch)
        let hasNotesModel = serverRunning && (await manager.hasUsableNotesModel())
        manager.assertLifecycleEpoch(recoveryEpoch)

        // A fresh serve can spend 10+ s discovering GPUs without answering.
        // Wait for it so the next attempt does not kill a healthy server.
        if (!(serverRunning && hasNotesModel) && manager.isServeStarting()) {
          await manager.waitForStartingServe()
          manager.assertLifecycleEpoch(recoveryEpoch)
          serverRunning = await manager.isServerRunning()
          manager.assertLifecycleEpoch(recoveryEpoch)
          hasNotesModel = serverRunning && (await manager.hasUsableNotesModel())
          manager.assertLifecycleEpoch(recoveryEpoch)
        }

        if (serverRunning && !hasNotesModel) {
          await manager.startAndPull()
          manager.assertLifecycleEpoch(recoveryEpoch)
          serverRunning = await manager.isServerRunning()
          manager.assertLifecycleEpoch(recoveryEpoch)
          hasNotesModel = serverRunning && (await manager.hasUsableNotesModel())
          manager.assertLifecycleEpoch(recoveryEpoch)
        }
        if (serverRunning && hasNotesModel) {
          options.markSetupReady()
          return
        }
        lastError = new Error('Ollama recovery finished but serve or notes model is not ready')
        logAutodocEvent({
          area: 'ollama',
          message: 'ollama recovery attempt not ready',
          context: {
            attempt: attemptIndex + 1,
            serverRunning,
            hasNotesModel,
            error: null
          }
        })
      } catch (error) {
        if (options.isCancellationError(error)) {
          throw error
        }
        lastError = error instanceof Error ? error : new Error(String(error))
        logAutodocEvent({
          area: 'ollama',
          message: 'ollama recovery attempt not ready',
          context: {
            attempt: attemptIndex + 1,
            serverRunning: null,
            hasNotesModel: null,
            error: lastError.message
          }
        })
        if (isOllamaModelLoadFailureError(lastError)) {
          throw latch('recovery-attempt-model-load-failure', lastError)
        }
      }
      if (manager.getModelLoadFailureCount() >= 1) {
        throw latch('serve-exited-loading-model', lastError)
      }
    }
    options.markSetupFailed(lastError ?? new Error('Ollama recovery failed'))
    throw lastError ?? new Error('Ollama recovery failed')
  }

  return {
    recover,
    reportModelLoadFailure: (message) => {
      if (latchedError) return
      latch('request-model-load-failure', message)
    },
    clearModelLoadLatch: () => {
      manager.clearModelLoadFailures()
      if (!latchedError) return
      latchedError = null
      options.onLatchChange?.(false)
    },
    isModelLoadLatched: () => latchedError !== null
  }
}
