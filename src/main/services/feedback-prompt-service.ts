import { randomUUID } from 'node:crypto'
import {
  FeedbackPromptStore,
  MAX_QUALIFYING_SESSION_DATES,
  type FeedbackPromptState
} from './feedback-prompt-store'

export const QUALIFYING_SESSION_DEDUP_MS = 30 * 60 * 1000
export const FEEDBACK_REMINDER_DELAY_MS = 14 * 24 * 60 * 60 * 1000
export const FEEDBACK_PROMPT_RESERVATION_TTL_MS = 15 * 1000

export type FeedbackPromptKind = 'initial' | 'reminder'
export type FeedbackPromptAction = 'later' | 'dismiss' | 'never'
export type FeedbackPromptSurface = 'upcoming' | 'ai_notes'

export type FeedbackPromptEligibilityReason =
  | 'eligible-initial'
  | 'eligible-reminder'
  | 'state-unavailable'
  | 'dependency-unavailable'
  | 'onboarding-incomplete'
  | 'busy'
  | 'support-unavailable'
  | 'contact-initiated'
  | 'never-ask-again'
  | 'baseline-unavailable'
  | 'usage-threshold-not-met'
  | 'reminder-not-due'
  | 'reminder-already-shown'
  | 'reservation-active'
  | 'reservation-unavailable'

export interface FeedbackPromptEligibility {
  eligible: boolean
  kind: FeedbackPromptKind | null
  reason: FeedbackPromptEligibilityReason
}

export interface EvaluateFeedbackPromptInput {
  state: FeedbackPromptState
  now: number
  eligibilityBaselineAt: number | null
  onboardingComplete: boolean
  busy: boolean
  supportAvailable: boolean
}

export interface FeedbackPromptReservationResult extends FeedbackPromptEligibility {
  reserved: boolean
  reservationId: string | null
}

export interface FeedbackPromptConfirmationResult extends FeedbackPromptEligibility {
  confirmed: boolean
  impressionId: string | null
}

export interface RecordQualifyingSessionResult {
  recorded: boolean
  stateAvailable: boolean
}

export interface RecordQualifyingSessionOptions {
  /** Bypasses persisted 30-minute dedup for the first qualified focus in a fresh process. */
  forceNewSession?: boolean
}

type MaybePromise<T> = T | Promise<T>

export interface FeedbackPromptStateStore {
  readState(): Promise<FeedbackPromptState | null>
  updateState(
    mutate: (current: FeedbackPromptState) => FeedbackPromptState
  ): Promise<FeedbackPromptState | null>
}

export interface FeedbackPromptServiceOptions {
  store?: FeedbackPromptStateStore
  now?: () => number
  getEligibilityBaselineAt: () => MaybePromise<number | null>
  isOnboardingComplete: () => MaybePromise<boolean>
  isBusy: () => MaybePromise<boolean>
  isSupportAvailable: () => MaybePromise<boolean>
  createReservationId?: () => string
  reservationTtlMs?: number
}

interface FeedbackPromptReservation {
  id: string
  surface: FeedbackPromptSurface
  kind: FeedbackPromptKind
  expiresAt: number
}

interface FeedbackPromptImpression {
  id: string
  surface: FeedbackPromptSurface
  kind: FeedbackPromptKind
}

const ineligible = (
  reason: Exclude<FeedbackPromptEligibilityReason, 'eligible-initial' | 'eligible-reminder'>
): FeedbackPromptEligibility => ({ eligible: false, kind: null, reason })

export function toLocalDateKey(now: number): string {
  const date = new Date(now)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function localDateOrdinal(dateKey: string): number {
  const [year, month, day] = dateKey.split('-').map(Number)
  return Date.UTC(year, month - 1, day)
}

function boundedSessionDates(dates: string[]): string[] {
  return [...new Set(dates)]
    .sort((left, right) => localDateOrdinal(right) - localDateOrdinal(left))
    .slice(0, MAX_QUALIFYING_SESSION_DATES)
}

function hasQualifyingUsage(
  state: FeedbackPromptState,
  now: number,
  eligibilityBaselineAt: number
): boolean {
  const sessionPath = state.qualifyingSessionCount >= 3 && state.qualifyingSessionDates.length >= 2
  const elapsedSinceBaseline = Math.max(0, now - eligibilityBaselineAt)
  const agePath =
    elapsedSinceBaseline >= FEEDBACK_REMINDER_DELAY_MS && state.qualifyingSessionCount >= 1
  return sessionPath || agePath
}

export function evaluateFeedbackPromptEligibility(
  input: EvaluateFeedbackPromptInput
): FeedbackPromptEligibility {
  const { state, now, eligibilityBaselineAt, onboardingComplete, busy, supportAvailable } = input

  if (state.contactInitiatedAt !== null) return ineligible('contact-initiated')
  if (state.neverAskAgain) return ineligible('never-ask-again')
  if (!onboardingComplete) return ineligible('onboarding-incomplete')
  if (busy) return ineligible('busy')
  if (!supportAvailable) return ineligible('support-unavailable')
  if (
    eligibilityBaselineAt === null ||
    !Number.isFinite(eligibilityBaselineAt) ||
    eligibilityBaselineAt < 0 ||
    !Number.isFinite(now) ||
    now < 0
  ) {
    return ineligible('baseline-unavailable')
  }
  if (!hasQualifyingUsage(state, now, eligibilityBaselineAt)) {
    return ineligible('usage-threshold-not-met')
  }

  if (state.initialPromptShownAt === null) {
    return { eligible: true, kind: 'initial', reason: 'eligible-initial' }
  }
  if (state.reminderPromptShownAt !== null) {
    return ineligible('reminder-already-shown')
  }
  if (Math.max(0, now - state.initialPromptShownAt) < FEEDBACK_REMINDER_DELAY_MS) {
    return ineligible('reminder-not-due')
  }

  return { eligible: true, kind: 'reminder', reason: 'eligible-reminder' }
}

/** Main-owned feedback state machine. UI visibility timing is coordinated by the caller. */
export class FeedbackPromptService {
  private readonly store: FeedbackPromptStateStore
  private readonly now: () => number
  private readonly createReservationId: () => string
  private readonly reservationTtlMs: number
  private activeReservation: FeedbackPromptReservation | null = null
  private activeImpression: FeedbackPromptImpression | null = null
  private operationQueue: Promise<void> = Promise.resolve()

  constructor(private readonly options: FeedbackPromptServiceOptions) {
    this.store = options.store ?? new FeedbackPromptStore()
    this.now = options.now ?? Date.now
    this.createReservationId = options.createReservationId ?? randomUUID
    this.reservationTtlMs = options.reservationTtlMs ?? FEEDBACK_PROMPT_RESERVATION_TTL_MS
  }

  async recordQualifyingSession(
    now = this.now(),
    options: RecordQualifyingSessionOptions = {}
  ): Promise<RecordQualifyingSessionResult> {
    if (!Number.isFinite(now) || now < 0) {
      return { recorded: false, stateAvailable: false }
    }

    let recorded = false
    const state = await this.store.updateState((current) => {
      const previous = current.lastQualifiedSessionAt
      if (
        !options.forceNewSession &&
        previous !== null &&
        now - previous < QUALIFYING_SESSION_DEDUP_MS
      ) {
        return current
      }

      recorded = true
      const localDate = toLocalDateKey(now)
      return {
        ...current,
        qualifyingSessionCount: Math.min(
          Number.MAX_SAFE_INTEGER,
          current.qualifyingSessionCount + 1
        ),
        qualifyingSessionDates: boundedSessionDates([localDate, ...current.qualifyingSessionDates]),
        lastQualifiedSessionAt: now
      }
    })

    return {
      recorded: state !== null && recorded,
      stateAvailable: state !== null
    }
  }

  async getEligibility(now = this.now()): Promise<FeedbackPromptEligibility> {
    const state = await this.store.readState()
    if (!state) return ineligible('state-unavailable')

    const context = await this.readEligibilityContext()
    if (!context) return ineligible('dependency-unavailable')
    return evaluateFeedbackPromptEligibility({ state, now, ...context })
  }

  async reservePrompt(
    surface: FeedbackPromptSurface,
    now = this.now()
  ): Promise<FeedbackPromptReservationResult> {
    return await this.enqueueOperation(async () => {
      if (
        !this.isValidSurface(surface) ||
        !this.isValidTime(now) ||
        !this.hasValidReservationTtl()
      ) {
        return this.reservationFailure('reservation-unavailable')
      }

      this.expireReservation(now)
      if (this.activeReservation) return this.reservationFailure('reservation-active')

      const state = await this.store.readState()
      if (!state) return this.reservationFailure('state-unavailable')

      const context = await this.readEligibilityContext()
      if (!context) return this.reservationFailure('dependency-unavailable')

      const eligibility = evaluateFeedbackPromptEligibility({ state, now, ...context })
      if (!eligibility.eligible || !eligibility.kind) {
        return { ...eligibility, reserved: false, reservationId: null }
      }

      let reservationId: string
      try {
        reservationId = this.createReservationId()
      } catch {
        return this.reservationFailure('reservation-unavailable')
      }
      if (!this.isValidReservationId(reservationId)) {
        return this.reservationFailure('reservation-unavailable')
      }

      const expiresAt = now + this.reservationTtlMs
      if (!this.isValidTime(expiresAt)) {
        return this.reservationFailure('reservation-unavailable')
      }

      this.activeReservation = {
        id: reservationId,
        surface,
        kind: eligibility.kind,
        expiresAt
      }
      return { ...eligibility, reserved: true, reservationId }
    }, this.reservationFailure('dependency-unavailable'))
  }

  async confirmPrompt(
    reservationId: string,
    surface: FeedbackPromptSurface,
    now = this.now()
  ): Promise<FeedbackPromptConfirmationResult> {
    return await this.enqueueOperation(async () => {
      if (!this.isValidSurface(surface) || !this.isValidTime(now)) {
        return this.confirmationFailure('reservation-unavailable')
      }

      this.expireReservation(now)
      const reservation = this.activeReservation
      if (!reservation || reservation.id !== reservationId || reservation.surface !== surface) {
        return this.confirmationFailure('reservation-unavailable')
      }

      // A matching confirmation consumes the reservation even when a gate changed.
      this.activeReservation = null

      const context = await this.readEligibilityContext()
      if (!context) return this.confirmationFailure('dependency-unavailable')

      let eligibility: FeedbackPromptEligibility = ineligible('state-unavailable')
      let confirmed = false
      const state = await this.store.updateState((current) => {
        eligibility = evaluateFeedbackPromptEligibility({ state: current, now, ...context })
        if (!eligibility.eligible || !eligibility.kind || eligibility.kind !== reservation.kind) {
          return current
        }

        confirmed = true
        if (eligibility.kind === 'initial') {
          return { ...current, initialPromptShownAt: now }
        }
        return { ...current, reminderPromptShownAt: now }
      })

      if (!state) return this.confirmationFailure('state-unavailable')
      if (!confirmed || !eligibility.kind) {
        return { ...eligibility, confirmed: false, impressionId: null }
      }

      this.activeImpression = {
        id: reservation.id,
        surface: reservation.surface,
        kind: eligibility.kind
      }
      return { ...eligibility, confirmed: true, impressionId: reservation.id }
    }, this.confirmationFailure('dependency-unavailable'))
  }

  async cancelPrompt(
    reservationId: string,
    surface: FeedbackPromptSurface,
    now = this.now()
  ): Promise<boolean> {
    return await this.enqueueOperation(async () => {
      if (!this.isValidSurface(surface) || !this.isValidTime(now)) return false

      this.expireReservation(now)
      if (
        !this.activeReservation ||
        this.activeReservation.id !== reservationId ||
        this.activeReservation.surface !== surface
      ) {
        return false
      }

      this.activeReservation = null
      return true
    }, false)
  }

  async recordAction(impressionId: string, action: FeedbackPromptAction): Promise<boolean> {
    return await this.enqueueOperation(async () => {
      const impression = this.activeImpression
      if (
        !this.isValidReservationId(impressionId) ||
        !impression ||
        impression.id !== impressionId
      ) {
        return false
      }

      if (action === 'never') {
        const state = await this.store.updateState((current) => ({
          ...current,
          neverAskAgain: true
        }))
        if (state) this.activeImpression = null
        return state !== null
      }

      if (action === 'later' && impression.kind === 'initial') {
        this.activeImpression = null
        return true
      }

      if (action === 'dismiss' && impression.kind === 'reminder') {
        this.activeImpression = null
        return true
      }

      return false
    }, false)
  }

  async recordContactInitiated(now = this.now()): Promise<void> {
    await this.enqueueOperation(async () => {
      this.activeReservation = null
      this.activeImpression = null
      if (!this.isValidTime(now)) return

      await this.store.updateState((current) => ({
        ...current,
        contactInitiatedAt: current.contactInitiatedAt ?? now
      }))
    }, undefined)
  }

  private async enqueueOperation<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
    const result = this.operationQueue.then(operation)
    this.operationQueue = result.then(
      () => undefined,
      () => undefined
    )
    try {
      return await result
    } catch {
      return fallback
    }
  }

  private expireReservation(now: number): void {
    if (this.activeReservation && now >= this.activeReservation.expiresAt) {
      this.activeReservation = null
    }
  }

  private isValidTime(value: number): boolean {
    return Number.isFinite(value) && value >= 0
  }

  private isValidSurface(value: unknown): value is FeedbackPromptSurface {
    return value === 'upcoming' || value === 'ai_notes'
  }

  private isValidReservationId(value: unknown): value is string {
    return (
      typeof value === 'string' && value.length > 0 && value.length <= 128 && value.trim() === value
    )
  }

  private hasValidReservationTtl(): boolean {
    return Number.isFinite(this.reservationTtlMs) && this.reservationTtlMs > 0
  }

  private reservationFailure(
    reason: Exclude<FeedbackPromptEligibilityReason, 'eligible-initial' | 'eligible-reminder'>
  ): FeedbackPromptReservationResult {
    return { ...ineligible(reason), reserved: false, reservationId: null }
  }

  private confirmationFailure(
    reason: Exclude<FeedbackPromptEligibilityReason, 'eligible-initial' | 'eligible-reminder'>
  ): FeedbackPromptConfirmationResult {
    return { ...ineligible(reason), confirmed: false, impressionId: null }
  }

  private async readEligibilityContext(): Promise<Omit<
    EvaluateFeedbackPromptInput,
    'state' | 'now'
  > | null> {
    try {
      const [eligibilityBaselineAt, onboardingComplete, busy, supportAvailable] = await Promise.all(
        [
          this.options.getEligibilityBaselineAt(),
          this.options.isOnboardingComplete(),
          this.options.isBusy(),
          this.options.isSupportAvailable()
        ]
      )
      return { eligibilityBaselineAt, onboardingComplete, busy, supportAvailable }
    } catch {
      return null
    }
  }
}
