import { QUALIFYING_SESSION_DEDUP_MS } from './feedback-prompt-service'

export const QUALIFYING_FOREGROUND_FOCUS_MS = 60_000

export interface FeedbackForegroundSessionRecorder {
  recordQualifyingSession(
    now?: number,
    options?: { forceNewSession?: boolean }
  ): Promise<{ recorded: boolean; stateAvailable: boolean }>
}

export interface FeedbackForegroundSessionTrackerOptions {
  recorder: FeedbackForegroundSessionRecorder
  isOnboardingComplete: () => boolean
  isForegrounded: () => boolean
  now?: () => number
  qualifyingFocusMs?: number
  inactivityMs?: number
}

export class FeedbackForegroundSessionTracker {
  private readonly now: () => number
  private readonly qualifyingFocusMs: number
  private readonly inactivityMs: number
  private timer: NodeJS.Timeout | null = null
  private inactiveSince: number | null = null
  private recordedThisLaunch = false
  private qualificationInFlight = false
  private disposed = false

  constructor(private readonly options: FeedbackForegroundSessionTrackerOptions) {
    this.now = options.now ?? Date.now
    this.qualifyingFocusMs = options.qualifyingFocusMs ?? QUALIFYING_FOREGROUND_FOCUS_MS
    this.inactivityMs = options.inactivityMs ?? QUALIFYING_SESSION_DEDUP_MS
  }

  observeActive(): void {
    if (this.disposed || !this.options.isOnboardingComplete() || !this.options.isForegrounded()) {
      return
    }

    const now = this.now()
    const followsLongInactivity =
      this.inactiveSince !== null && now - this.inactiveSince >= this.inactivityMs
    this.inactiveSince = null

    if (this.timer || this.qualificationInFlight) return

    if (this.recordedThisLaunch && !followsLongInactivity) {
      return
    }

    this.timer = setTimeout(() => {
      this.timer = null
      if (this.disposed || !this.options.isOnboardingComplete() || !this.options.isForegrounded()) {
        return
      }

      this.qualificationInFlight = true
      void this.recordQualifyingSession()
    }, this.qualifyingFocusMs)
    this.timer.unref?.()
  }

  observeInactive(): void {
    if (this.disposed) return
    this.cancelTimer()
    this.inactiveSince ??= this.now()
  }

  dispose(): void {
    this.disposed = true
    this.cancelTimer()
  }

  private cancelTimer(): void {
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = null
  }

  private async recordQualifyingSession(): Promise<void> {
    try {
      const result = await this.options.recorder.recordQualifyingSession(this.now(), {
        forceNewSession: !this.recordedThisLaunch
      })
      if (!this.disposed && result.recorded) this.recordedThisLaunch = true
    } catch {
      // Qualification is best-effort; a later foreground transition can retry.
    } finally {
      this.qualificationInFlight = false
    }
  }
}
