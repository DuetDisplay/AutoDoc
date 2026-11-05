import { logAutodocEvent } from './autodoc-log'

const EXIT_RESTART_DELAY_MS = 3_000
const MAX_RUNS_PER_WINDOW = 3
const BUDGET_WINDOW_MS = 10 * 60_000

export interface OllamaBackgroundRecoveryDeps {
  isServerRunning(): Promise<boolean>
  /** A serve or setup run already in progress, which a new request should join. */
  isStarting(): boolean
  captureEpoch(): number
  isEpochCurrent(epoch: number): boolean
  /** Quit, model-load latch, post-wake chain or paused background restarts. */
  shouldDefer(): boolean
  start(): Promise<void>
}

export interface OllamaBackgroundRecovery {
  scheduleAfterExit(): void
  requestFromPoll(): void
  resetBudget(): void
}

/**
 * Restarts a server that was ready and then went away, limited across the exit and health-poll
 * triggers. Setup, explicit retries, notes recovery and post-wake keep their own bounds, so this
 * is not a limit on every restart. A run counts once, even if setup retries inside it.
 */
export function createOllamaBackgroundRecovery(
  deps: OllamaBackgroundRecoveryDeps
): OllamaBackgroundRecovery {
  let exitTimer: ReturnType<typeof setTimeout> | null = null
  let runTimes: number[] = []

  const admit = (trigger: 'exit' | 'poll'): void => {
    if (deps.shouldDefer() || deps.isStarting()) return
    const now = Date.now()
    runTimes = runTimes.filter((time) => now - time < BUDGET_WINDOW_MS)
    if (runTimes.length >= MAX_RUNS_PER_WINDOW) {
      logAutodocEvent({
        area: 'ollama',
        level: 'warn',
        message: 'ollama background recovery suppressed; budget used',
        context: { trigger, runs: runTimes.length }
      })
      return
    }
    runTimes.push(now)
    const run = runTimes.length
    logAutodocEvent({
      area: 'ollama',
      message: 'ollama background recovery started',
      context: { trigger, run }
    })
    deps.start().then(
      () => {
        logAutodocEvent({
          area: 'ollama',
          message: 'ollama background recovery finished',
          context: { trigger, run, outcome: 'ready' }
        })
      },
      () => {
        // The setup path has already reported why it failed.
        logAutodocEvent({
          area: 'ollama',
          level: 'warn',
          message: 'ollama background recovery finished',
          context: { trigger, run, outcome: 'failed' }
        })
      }
    )
  }

  return {
    scheduleAfterExit() {
      const epoch = deps.captureEpoch()
      if (exitTimer) clearTimeout(exitTimer)
      exitTimer = setTimeout(() => {
        exitTimer = null
        void deps
          .isServerRunning()
          .catch(() => false)
          .then((running) => {
            // Rechecked after the probe: Quit can land while it is waiting for a response.
            if (!running && deps.isEpochCurrent(epoch)) admit('exit')
          })
      }, EXIT_RESTART_DELAY_MS)
      exitTimer.unref?.()
    },
    requestFromPoll() {
      admit('poll')
    },
    resetBudget() {
      runTimes = []
    }
  }
}
