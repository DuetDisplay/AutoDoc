import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron-store', () => {
  return {
    default: vi.fn().mockImplementation((opts?: { defaults?: Record<string, unknown> }) => {
      const data: Record<string, unknown> = { ...(opts?.defaults ?? {}) }
      return {
        get: vi.fn((key: string, defaultValue?: unknown) => {
          return key in data ? data[key] : defaultValue
        }),
        set: vi.fn((key: string, value: unknown) => {
          data[key] = value
        }),
        clear: vi.fn(() => {
          for (const key of Object.keys(data)) {
            delete data[key]
          }
        }),
        get store() {
          return { ...data }
        }
      }
    })
  }
})

import { AnalyticsStateStore } from '../analytics-state-store'

describe('AnalyticsStateStore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-17T10:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('generates a stable anonymous install ID and first launch date', () => {
    const store = new AnalyticsStateStore()

    const firstState = store.getState()
    const secondState = store.getState()

    expect(firstState.installId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    )
    expect(secondState.installId).toBe(firstState.installId)
    expect(secondState.firstLaunchDate).toBe(firstState.firstLaunchDate)
  })

  it('records local funnel flags and count buckets without network analytics', () => {
    const store = new AnalyticsStateStore()

    expect(store.recordLocalSignal('onboarding_started')).toBe(true)
    expect(store.recordLocalSignal('onboarding_started')).toBe(false)
    expect(store.recordLocalSignal('whisper_setup_completed')).toBe(true)
    expect(store.recordLocalSignal('ollama_setup_completed')).toBe(true)
    expect(store.recordLocalSignal('recording_completed')).toBe(true)
    expect(store.recordLocalSignal('recording_completed')).toBe(false)
    expect(store.recordLocalSignal('notes_generated')).toBe(true)

    const state = store.getState()
    expect(state.onboardingStarted).toBe(true)
    expect(state.setupCompleted).toBe(true)
    expect(state.recordingsCompletedCount).toBe(2)
    expect(state.notesGeneratedCount).toBe(1)
    expect(store.getConsentSnapshot()).toMatchObject({
      onboarding_started: true,
      setup_completed: true,
      first_recording_completed: true,
      first_notes_generated: true,
      recordings_completed_bucket: '2-3',
      notes_generated_bucket: '1'
    })
  })

  it('marks daily active once per local day', () => {
    const store = new AnalyticsStateStore()

    expect(store.markDailyActive()).toEqual({ tracked: true, daysSinceFirstLaunch: 0 })
    expect(store.markDailyActive()).toEqual({ tracked: false, daysSinceFirstLaunch: 0 })

    vi.setSystemTime(new Date('2026-06-18T10:00:00Z'))

    expect(store.markDailyActive()).toEqual({ tracked: true, daysSinceFirstLaunch: 1 })
  })

  it('starts and ends sessions with only a bucketed duration', () => {
    const store = new AnalyticsStateStore()

    const started = store.startSession()
    expect(started.sessionId).toBeTruthy()
    expect(started.daysSinceFirstLaunch).toBe(0)

    vi.setSystemTime(new Date('2026-06-17T10:00:45Z'))

    expect(store.endSession()).toEqual({
      sessionId: started.sessionId,
      sessionDurationBucket: '10-59s'
    })
    expect(store.endSession()).toBeNull()
  })

  it('clears analytics state by rotating to fresh local identifiers', () => {
    const store = new AnalyticsStateStore()
    const firstInstallId = store.getState().installId

    store.recordLocalSignal('onboarding_completed')
    store.clear()

    const clearedState = store.getState()
    expect(clearedState.installId).toBeTruthy()
    expect(clearedState.installId).not.toBe(firstInstallId)
    expect(clearedState.onboardingCompleted).toBe(false)
    expect(clearedState.recordingsCompletedCount).toBe(0)
  })
})
