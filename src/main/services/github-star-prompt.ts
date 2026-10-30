import type { MeetingMetadata, TranscriptionStatus, SegmentationStatus } from '../../shared/types'
import Store from 'electron-store'
import { randomUUID } from 'node:crypto'
import { toLocalDateKey } from './feedback-prompt-service'

export { AUTODOC_GITHUB_URL } from '../../shared/constants'
export function isSuccessfulStarMeeting(
  metadata: MeetingMetadata | null,
  transcription: TranscriptionStatus,
  notes: SegmentationStatus,
  hasNotes: boolean,
  errorCode?: string
): boolean {
  return Boolean(
    metadata &&
    Number.isFinite(metadata.durationSeconds) &&
    metadata.durationSeconds >= 180 &&
    !metadata.isFinalizing &&
    !metadata.videoProcessingFailed &&
    !metadata.videoCaptureEndedEarly &&
    metadata.videoStatus !== 'failed' &&
    transcription === 'complete' &&
    notes === 'complete' &&
    hasNotes &&
    !errorCode
  )
}

export interface GithubStarPromptState {
  activatedAt: number
  qualifiedMeetingId: string | null
  shownAt: number | null
}
export interface GithubStarPromptStateStore {
  read(): GithubStarPromptState | null
  write(state: GithubStarPromptState): void
}

export function createGithubStarPromptStore(now: number): GithubStarPromptStateStore {
  try {
    const store = new Store<{ state: GithubStarPromptState }>({ name: 'autodoc-github-star' })
    // A separate durable preference survives upgrades. Never infer eligibility from old notes.
    if (!store.has('state'))
      store.set('state', { activatedAt: now, qualifiedMeetingId: null, shownAt: null })
    return { read: () => store.get('state'), write: (state) => store.set('state', state) }
  } catch {
    return {
      read: () => null,
      write: () => {
        throw new Error('Local prompt state unavailable')
      }
    }
  }
}

export interface GithubStarPromptOptions {
  store: GithubStarPromptStateStore
  now?: () => number
  isBusy: () => boolean
  isOnboardingComplete: () => boolean
  feedbackTakesPriority: () => Promise<boolean>
  isGoodMeeting: (meetingId: string) => Promise<boolean>
}

/** Local eligibility only: no telemetry, network requests, or GitHub account checks. */
export class GithubStarPromptService {
  private reservation: { id: string; expiresAt: number } | null = null
  private shownThisSession = false
  private queue: Promise<void> = Promise.resolve()
  private readonly now: () => number
  constructor(private readonly options: GithubStarPromptOptions) {
    this.now = options.now ?? Date.now
  }

  private read(): GithubStarPromptState | null {
    try {
      const s = this.options.store.read()
      if (
        !s ||
        !Number.isFinite(s.activatedAt) ||
        s.activatedAt < 0 ||
        (s.shownAt !== null && (!Number.isFinite(s.shownAt) || s.shownAt < 0)) ||
        (s.qualifiedMeetingId !== null &&
          (typeof s.qualifiedMeetingId !== 'string' || !s.qualifiedMeetingId))
      )
        return null
      return s
    } catch {
      return null
    }
  }
  private async serial<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    const result = this.queue.then(fn)
    this.queue = result.then(
      () => undefined,
      () => undefined
    )
    try {
      return await result
    } catch {
      return fallback
    }
  }
  async recordCompletedMeeting(meetingId: string): Promise<void> {
    await this.serial(async () => {
      const state = this.read()
      if (!state || state.shownAt !== null || this.now() < state.activatedAt) return
      if (await this.options.isGoodMeeting(meetingId))
        this.options.store.write({ ...state, qualifiedMeetingId: meetingId })
    }, undefined)
  }
  blocksFeedback(): boolean {
    const state = this.read()
    return (
      this.shownThisSession ||
      Boolean(
        state?.shownAt !== null &&
        state?.shownAt !== undefined &&
        toLocalDateKey(state.shownAt) === toLocalDateKey(this.now())
      )
    )
  }
  private async eligible(): Promise<boolean> {
    const state = this.read()
    return Boolean(
      state &&
      state.shownAt === null &&
      state.qualifiedMeetingId &&
      this.options.isOnboardingComplete() &&
      !this.options.isBusy() &&
      (await this.options.isGoodMeeting(state.qualifiedMeetingId)) &&
      !this.options.isBusy() &&
      !(await this.options.feedbackTakesPriority()) &&
      !this.options.isBusy() &&
      this.options.isOnboardingComplete()
    )
  }
  async reserve(): Promise<string | null> {
    return await this.serial(async () => {
      if (this.reservation && this.reservation.expiresAt > this.now()) return null
      if (!(await this.eligible())) return null
      const id = randomUUID()
      this.reservation = { id, expiresAt: this.now() + 15_000 }
      return id
    }, null)
  }
  async confirm(id: string): Promise<boolean> {
    return await this.serial(async () => {
      const reservation = this.reservation
      if (!reservation || reservation.id !== id || reservation.expiresAt <= this.now()) return false
      const eligible = await this.eligible()
      if (this.reservation?.id !== id) return false
      this.reservation = null
      if (!eligible || reservation.expiresAt <= this.now()) return false
      const state = this.read()
      if (!state || state.shownAt !== null) return false
      this.options.store.write({ ...state, shownAt: this.now() })
      this.shownThisSession = true
      return true
    }, false)
  }
  cancel(id: string): void {
    if (this.reservation?.id === id) this.reservation = null
  }
}
