import { logAutodocFailure } from './autodoc-log'

const PREPARE_TIMEOUT_MS = 120_000
const QUIT_STALL_TIMEOUT_MS = 60_000

/** Holds Electron's quit until the renderer and recording finalization have settled. */
export class SafeQuitCoordinator {
  private ready = false
  private pending = false
  private stallTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly options: {
      prepare: () => Promise<void>
      quit: () => void
      onQuitAllowed?: () => void
      onError: (error: unknown) => void
      /** The process is still alive long after a quit was allowed through. */
      onQuitStalled?: () => void
    }
  ) {}

  allowQuit(): void {
    this.ready = true
  }

  cancelPreparedQuit(): void {
    this.ready = false
    if (this.stallTimer) clearTimeout(this.stallTimer)
    this.stallTimer = null
  }

  beforeQuit(event: { preventDefault: () => void }): boolean {
    if (this.ready) {
      try {
        this.options.onQuitAllowed?.()
      } catch (error) {
        logAutodocFailure({ area: 'app', message: 'quit-allowed hook failed', error })
      }
      this.stallTimer ??= setTimeout(() => this.options.onQuitStalled?.(), QUIT_STALL_TIMEOUT_MS)
      return true
    }
    event.preventDefault()
    if (this.pending) return false
    this.pending = true
    void this.prepareWithinLimit()
      .then(() => {
        this.ready = true
        this.options.quit()
      })
      .catch((error: unknown) => {
        this.options.onError(error)
      })
      .finally(() => {
        this.pending = false
      })
    return false
  }

  private async prepareWithinLimit(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.options.prepare(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Preparing to quit did not finish')),
            PREPARE_TIMEOUT_MS
          )
        })
      ])
    } finally {
      clearTimeout(timer)
    }
  }
}
