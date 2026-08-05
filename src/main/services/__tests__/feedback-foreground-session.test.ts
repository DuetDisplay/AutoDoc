import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FeedbackForegroundSessionTracker,
  QUALIFYING_FOREGROUND_FOCUS_MS
} from '../feedback-foreground-session'
import { QUALIFYING_SESSION_DEDUP_MS } from '../feedback-prompt-service'

describe('FeedbackForegroundSessionTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-31T14:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function setup() {
    let foregrounded = true
    let onboardingComplete = true
    const recordQualifyingSession = vi.fn().mockResolvedValue({
      recorded: true,
      stateAvailable: true
    })
    const tracker = new FeedbackForegroundSessionTracker({
      recorder: { recordQualifyingSession },
      isOnboardingComplete: () => onboardingComplete,
      isForegrounded: () => foregrounded
    })
    return {
      tracker,
      recordQualifyingSession,
      setForegrounded: (value: boolean) => {
        foregrounded = value
      },
      setOnboardingComplete: (value: boolean) => {
        onboardingComplete = value
      }
    }
  }

  it('records the first fresh-launch session only after 60 focused seconds', async () => {
    const { tracker, recordQualifyingSession } = setup()
    tracker.observeActive()

    await vi.advanceTimersByTimeAsync(QUALIFYING_FOREGROUND_FOCUS_MS - 1)
    expect(recordQualifyingSession).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    expect(recordQualifyingSession).toHaveBeenCalledOnce()
    expect(recordQualifyingSession).toHaveBeenCalledWith(Date.now(), {
      forceNewSession: true
    })
  })

  it('cancels qualification when the app becomes inactive', async () => {
    const { tracker, recordQualifyingSession, setForegrounded } = setup()
    tracker.observeActive()
    await vi.advanceTimersByTimeAsync(45_000)
    setForegrounded(false)
    tracker.observeInactive()
    await vi.advanceTimersByTimeAsync(30_000)

    expect(recordQualifyingSession).not.toHaveBeenCalled()
  })

  it('does not manufacture sessions from repeated focus events', async () => {
    const { tracker, recordQualifyingSession } = setup()
    tracker.observeActive()
    tracker.observeActive()
    await vi.advanceTimersByTimeAsync(30_000)
    tracker.observeActive()
    await vi.advanceTimersByTimeAsync(30_000)

    expect(recordQualifyingSession).toHaveBeenCalledOnce()
  })

  it('does not start duplicate forced records while persistence is in flight', async () => {
    let resolveRecord:
      | ((result: { recorded: boolean; stateAvailable: boolean }) => void)
      | undefined
    const recordQualifyingSession = vi.fn(
      () =>
        new Promise<{ recorded: boolean; stateAvailable: boolean }>((resolve) => {
          resolveRecord = resolve
        })
    )
    const tracker = new FeedbackForegroundSessionTracker({
      recorder: { recordQualifyingSession },
      isOnboardingComplete: () => true,
      isForegrounded: () => true
    })

    tracker.observeActive()
    await vi.advanceTimersByTimeAsync(QUALIFYING_FOREGROUND_FOCUS_MS)
    expect(recordQualifyingSession).toHaveBeenCalledOnce()
    expect(recordQualifyingSession).toHaveBeenCalledWith(Date.now(), {
      forceNewSession: true
    })

    tracker.observeActive()
    tracker.observeActive()
    await vi.advanceTimersByTimeAsync(2 * QUALIFYING_FOREGROUND_FOCUS_MS)
    expect(recordQualifyingSession).toHaveBeenCalledOnce()

    resolveRecord?.({ recorded: true, stateAvailable: true })
    await Promise.resolve()
    tracker.observeActive()
    await vi.advanceTimersByTimeAsync(QUALIFYING_FOREGROUND_FOCUS_MS)
    expect(recordQualifyingSession).toHaveBeenCalledOnce()
  })

  it('does not retain stale inactivity across an in-flight qualification', async () => {
    let foregrounded = true
    let resolveRecord:
      | ((result: { recorded: boolean; stateAvailable: boolean }) => void)
      | undefined
    const recordQualifyingSession = vi.fn(
      () =>
        new Promise<{ recorded: boolean; stateAvailable: boolean }>((resolve) => {
          resolveRecord = resolve
        })
    )
    const tracker = new FeedbackForegroundSessionTracker({
      recorder: { recordQualifyingSession },
      isOnboardingComplete: () => true,
      isForegrounded: () => foregrounded
    })

    tracker.observeActive()
    await vi.advanceTimersByTimeAsync(QUALIFYING_FOREGROUND_FOCUS_MS)
    expect(recordQualifyingSession).toHaveBeenCalledOnce()

    foregrounded = false
    tracker.observeInactive()
    await vi.advanceTimersByTimeAsync(1_000)
    foregrounded = true
    tracker.observeActive()

    resolveRecord?.({ recorded: true, stateAvailable: true })
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(QUALIFYING_SESSION_DEDUP_MS)

    foregrounded = false
    tracker.observeInactive()
    await vi.advanceTimersByTimeAsync(1_000)
    foregrounded = true
    tracker.observeActive()
    await vi.advanceTimersByTimeAsync(QUALIFYING_FOREGROUND_FOCUS_MS)

    expect(recordQualifyingSession).toHaveBeenCalledOnce()
  })

  it('contains synchronous recorder failures and allows a later retry', async () => {
    const recordQualifyingSession = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('state write failed synchronously')
      })
      .mockResolvedValueOnce({ recorded: true, stateAvailable: true })
    const tracker = new FeedbackForegroundSessionTracker({
      recorder: { recordQualifyingSession },
      isOnboardingComplete: () => true,
      isForegrounded: () => true
    })

    tracker.observeActive()
    await vi.advanceTimersByTimeAsync(QUALIFYING_FOREGROUND_FOCUS_MS)
    expect(recordQualifyingSession).toHaveBeenCalledOnce()

    tracker.observeActive()
    await vi.advanceTimersByTimeAsync(QUALIFYING_FOREGROUND_FOCUS_MS)
    expect(recordQualifyingSession).toHaveBeenCalledTimes(2)
    expect(recordQualifyingSession).toHaveBeenLastCalledWith(Date.now(), {
      forceNewSession: true
    })
  })

  it('requires 30 inactive minutes before another session can begin', async () => {
    const { tracker, recordQualifyingSession, setForegrounded } = setup()
    tracker.observeActive()
    await vi.advanceTimersByTimeAsync(QUALIFYING_FOREGROUND_FOCUS_MS)

    setForegrounded(false)
    tracker.observeInactive()
    await vi.advanceTimersByTimeAsync(QUALIFYING_SESSION_DEDUP_MS - 1)
    setForegrounded(true)
    tracker.observeActive()
    await vi.advanceTimersByTimeAsync(QUALIFYING_FOREGROUND_FOCUS_MS)
    expect(recordQualifyingSession).toHaveBeenCalledOnce()

    setForegrounded(false)
    tracker.observeInactive()
    await vi.advanceTimersByTimeAsync(QUALIFYING_SESSION_DEDUP_MS)
    setForegrounded(true)
    tracker.observeActive()
    await vi.advanceTimersByTimeAsync(QUALIFYING_FOREGROUND_FOCUS_MS)

    expect(recordQualifyingSession).toHaveBeenCalledTimes(2)
    expect(recordQualifyingSession).toHaveBeenLastCalledWith(Date.now(), {
      forceNewSession: false
    })
  })

  it('does not count background uptime or pre-onboarding use', async () => {
    const { tracker, recordQualifyingSession, setForegrounded, setOnboardingComplete } = setup()
    setOnboardingComplete(false)
    tracker.observeActive()
    await vi.advanceTimersByTimeAsync(2 * QUALIFYING_FOREGROUND_FOCUS_MS)

    setOnboardingComplete(true)
    setForegrounded(false)
    tracker.observeInactive()
    await vi.advanceTimersByTimeAsync(2 * QUALIFYING_SESSION_DEDUP_MS)
    expect(recordQualifyingSession).not.toHaveBeenCalled()
  })
})
