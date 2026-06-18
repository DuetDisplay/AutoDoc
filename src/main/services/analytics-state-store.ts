import Store from 'electron-store'
import { randomUUID } from 'crypto'
import type {
  AnalyticsConsentSnapshot,
  AnalyticsDailyActiveResult,
  AnalyticsLocalSignal,
  AnalyticsSessionEndResult,
  AnalyticsSessionStartResult,
  AnalyticsState
} from '../../shared/types'

interface AnalyticsStateSchema extends AnalyticsState {}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10)
}

function daysSince(dateIso: string): number {
  const startedAt = new Date(dateIso).getTime()
  if (!Number.isFinite(startedAt)) return 0
  const elapsedMs = Date.now() - startedAt
  return Math.max(0, Math.floor(elapsedMs / 86_400_000))
}

function bucketCount(count: number): string {
  if (count <= 0) return '0'
  if (count === 1) return '1'
  if (count <= 3) return '2-3'
  if (count <= 10) return '4-10'
  if (count <= 25) return '11-25'
  return '26+'
}

function bucketDurationSeconds(seconds: number): string {
  if (seconds < 10) return '0-9s'
  if (seconds < 60) return '10-59s'
  if (seconds < 5 * 60) return '1-4m'
  if (seconds < 30 * 60) return '5-29m'
  if (seconds < 60 * 60) return '30-59m'
  if (seconds < 2 * 60 * 60) return '1-2h'
  return '2h+'
}

function createDefaultState(): AnalyticsStateSchema {
  return {
    installId: randomUUID(),
    firstLaunchDate: new Date().toISOString(),
    lastDailyActiveDate: null,
    sessionId: null,
    sessionStartedAt: null,
    onboardingStarted: false,
    onboardingCompleted: false,
    whisperSetupCompleted: false,
    ollamaSetupCompleted: false,
    setupCompleted: false,
    firstRecordingCompleted: false,
    firstNotesGenerated: false,
    userActivated: false,
    recordingsCompletedCount: 0,
    notesGeneratedCount: 0
  }
}

export class AnalyticsStateStore {
  private store: Store<AnalyticsStateSchema>

  constructor() {
    const defaults = createDefaultState()
    this.store = new Store<AnalyticsStateSchema>({
      name: 'autodoc-analytics-state',
      defaults
    })

    // Older partial stores should be completed without rotating install IDs.
    for (const [key, value] of Object.entries(defaults) as Array<
      [keyof AnalyticsStateSchema, AnalyticsStateSchema[keyof AnalyticsStateSchema]]
    >) {
      if (this.store.get(key) === undefined) {
        this.store.set(key, value as never)
      }
    }
  }

  getState(): AnalyticsState {
    const state = this.store.store
    return {
      ...state,
      setupCompleted: state.whisperSetupCompleted && state.ollamaSetupCompleted
    }
  }

  recordLocalSignal(signal: AnalyticsLocalSignal): boolean {
    const state = this.getState()

    switch (signal) {
      case 'onboarding_started':
        if (state.onboardingStarted) return false
        this.store.set('onboardingStarted', true)
        return true
      case 'onboarding_completed':
        if (state.onboardingCompleted) return false
        this.store.set('onboardingStarted', true)
        this.store.set('onboardingCompleted', true)
        return true
      case 'whisper_setup_completed':
        if (state.whisperSetupCompleted) return false
        this.store.set('whisperSetupCompleted', true)
        this.syncSetupCompleted()
        return true
      case 'ollama_setup_completed':
        if (state.ollamaSetupCompleted) return false
        this.store.set('ollamaSetupCompleted', true)
        this.syncSetupCompleted()
        return true
      case 'recording_completed':
        this.store.set('recordingsCompletedCount', state.recordingsCompletedCount + 1)
        if (state.firstRecordingCompleted) return false
        this.store.set('firstRecordingCompleted', true)
        return true
      case 'notes_generated':
        this.store.set('notesGeneratedCount', state.notesGeneratedCount + 1)
        if (state.firstNotesGenerated) return false
        this.store.set('firstNotesGenerated', true)
        return true
      case 'user_activated':
        if (state.userActivated) return false
        this.store.set('userActivated', true)
        return true
    }
  }

  markDailyActive(): AnalyticsDailyActiveResult {
    const state = this.getState()
    const today = todayIsoDate()
    const tracked = state.lastDailyActiveDate !== today
    if (tracked) {
      this.store.set('lastDailyActiveDate', today)
    }
    return {
      tracked,
      daysSinceFirstLaunch: daysSince(state.firstLaunchDate)
    }
  }

  startSession(): AnalyticsSessionStartResult {
    const sessionId = randomUUID()
    const state = this.getState()
    this.store.set('sessionId', sessionId)
    this.store.set('sessionStartedAt', new Date().toISOString())
    return {
      sessionId,
      daysSinceFirstLaunch: daysSince(state.firstLaunchDate)
    }
  }

  endSession(): AnalyticsSessionEndResult | null {
    const state = this.getState()
    if (!state.sessionId || !state.sessionStartedAt) return null

    const startedAt = new Date(state.sessionStartedAt).getTime()
    const durationSeconds = Number.isFinite(startedAt)
      ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
      : 0

    this.store.set('sessionId', null)
    this.store.set('sessionStartedAt', null)

    return {
      sessionId: state.sessionId,
      sessionDurationBucket: bucketDurationSeconds(durationSeconds)
    }
  }

  getConsentSnapshot(): AnalyticsConsentSnapshot {
    const state = this.getState()
    return {
      days_since_first_launch: daysSince(state.firstLaunchDate),
      onboarding_started: state.onboardingStarted,
      onboarding_completed: state.onboardingCompleted,
      setup_completed: state.setupCompleted,
      first_recording_completed: state.firstRecordingCompleted,
      first_notes_generated: state.firstNotesGenerated,
      user_activated: state.userActivated,
      recordings_completed_bucket: bucketCount(state.recordingsCompletedCount),
      notes_generated_bucket: bucketCount(state.notesGeneratedCount)
    }
  }

  clear(): void {
    this.store.clear()
    const defaults = createDefaultState()
    for (const [key, value] of Object.entries(defaults) as Array<
      [keyof AnalyticsStateSchema, AnalyticsStateSchema[keyof AnalyticsStateSchema]]
    >) {
      this.store.set(key, value as never)
    }
  }

  private syncSetupCompleted(): void {
    const state = this.getState()
    this.store.set('setupCompleted', state.whisperSetupCompleted && state.ollamaSetupCompleted)
  }
}

export const analyticsDurationBucket = bucketDurationSeconds
