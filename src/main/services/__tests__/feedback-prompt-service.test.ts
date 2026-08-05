import { describe, expect, it } from 'vitest'
import {
  FeedbackPromptStore,
  createDefaultFeedbackPromptState,
  type FeedbackPromptEncryption,
  type FeedbackPromptState,
  type FeedbackPromptStoreBackend
} from '../feedback-prompt-store'
import {
  FEEDBACK_PROMPT_RESERVATION_TTL_MS,
  FEEDBACK_REMINDER_DELAY_MS,
  QUALIFYING_SESSION_DEDUP_MS,
  FeedbackPromptService,
  evaluateFeedbackPromptEligibility,
  toLocalDateKey,
  type FeedbackPromptServiceOptions,
  type FeedbackPromptStateStore
} from '../feedback-prompt-service'

const DAY_MS = 24 * 60 * 60 * 1000

class MemoryBackend implements FeedbackPromptStoreBackend {
  readonly values = new Map<string, unknown>()
  get(key: 'state'): unknown {
    return this.values.get(key)
  }
  set(key: 'state', value: string): void {
    this.values.set(key, value)
  }
}

const testEncryption: FeedbackPromptEncryption = {
  isEncryptionAvailable: () => true,
  encryptString: (plaintext) => Buffer.from(`encrypted:${plaintext}`, 'utf8'),
  decryptString: (ciphertext) => {
    const serialized = ciphertext.toString('utf8')
    if (!serialized.startsWith('encrypted:')) throw new Error('Invalid ciphertext')
    return serialized.slice('encrypted:'.length)
  }
}

function createStore(): FeedbackPromptStore {
  return new FeedbackPromptStore({
    backend: new MemoryBackend(),
    encryption: testEncryption
  })
}

function createService(
  store: FeedbackPromptStateStore = createStore(),
  overrides: Partial<FeedbackPromptServiceOptions> = {}
): FeedbackPromptService {
  return new FeedbackPromptService({
    store,
    now: () => 0,
    getEligibilityBaselineAt: () => 0,
    isOnboardingComplete: () => true,
    isBusy: () => false,
    isSupportAvailable: () => true,
    ...overrides
  })
}

function qualifiedState(overrides: Partial<FeedbackPromptState> = {}): FeedbackPromptState {
  return {
    ...createDefaultFeedbackPromptState(),
    qualifyingSessionCount: 3,
    qualifyingSessionDates: ['2026-07-31', '2026-07-30'],
    lastQualifiedSessionAt: Date.UTC(2026, 6, 31),
    ...overrides
  }
}

function localTime(year: number, month: number, day: number, hour = 12, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute).getTime()
}

describe('feedback prompt qualifying sessions', () => {
  it('deduplicates within 30 minutes and records at the exact boundary', async () => {
    const store = createStore()
    const service = createService(store)
    const startedAt = localTime(2026, 7, 30)

    await expect(service.recordQualifyingSession(startedAt)).resolves.toEqual({
      recorded: true,
      stateAvailable: true
    })
    await expect(
      service.recordQualifyingSession(startedAt + QUALIFYING_SESSION_DEDUP_MS - 1)
    ).resolves.toEqual({ recorded: false, stateAvailable: true })
    await expect(
      service.recordQualifyingSession(startedAt + QUALIFYING_SESSION_DEDUP_MS)
    ).resolves.toEqual({ recorded: true, stateAvailable: true })

    await expect(store.readState()).resolves.toMatchObject({
      qualifyingSessionCount: 2,
      qualifyingSessionDates: ['2026-07-30']
    })
  })

  it('deduplicates clock rollback rather than creating another session', async () => {
    const store = createStore()
    const service = createService(store)
    const startedAt = localTime(2026, 7, 30, 12)

    await service.recordQualifyingSession(startedAt)
    await expect(service.recordQualifyingSession(startedAt - DAY_MS)).resolves.toMatchObject({
      recorded: false
    })
    await expect(store.readState()).resolves.toMatchObject({ qualifyingSessionCount: 1 })
  })

  it('lets the first qualifying focus in a fresh process bypass persisted dedup', async () => {
    const store = createStore()
    const firstProcess = createService(store)
    const startedAt = localTime(2026, 7, 30)
    await firstProcess.recordQualifyingSession(startedAt)

    const freshProcess = createService(store)
    await expect(
      freshProcess.recordQualifyingSession(startedAt + 5 * 60_000, { forceNewSession: true })
    ).resolves.toEqual({ recorded: true, stateAvailable: true })
    await expect(store.readState()).resolves.toMatchObject({ qualifyingSessionCount: 2 })
  })

  it('tracks distinct local calendar dates across local midnight', async () => {
    const store = createStore()
    const service = createService(store)
    const beforeMidnight = localTime(2026, 7, 30, 23, 45)
    const afterMidnight = localTime(2026, 7, 31, 0, 16)

    expect(toLocalDateKey(beforeMidnight)).toBe('2026-07-30')
    expect(toLocalDateKey(afterMidnight)).toBe('2026-07-31')
    await service.recordQualifyingSession(beforeMidnight)
    await service.recordQualifyingSession(afterMidnight)

    await expect(store.readState()).resolves.toMatchObject({
      qualifyingSessionCount: 2,
      qualifyingSessionDates: ['2026-07-31', '2026-07-30']
    })
  })

  it('bounds stored local dates while retaining the lifetime session count', async () => {
    const store = createStore()
    const service = createService(store)
    const start = localTime(2026, 1, 1)

    for (let day = 0; day < 35; day += 1) {
      await service.recordQualifyingSession(start + day * DAY_MS, { forceNewSession: true })
    }

    const state = await store.readState()
    expect(state?.qualifyingSessionCount).toBe(35)
    expect(state?.qualifyingSessionDates).toHaveLength(30)
    expect(state?.qualifyingSessionDates).toContain(toLocalDateKey(start + 34 * DAY_MS))
    expect(state?.qualifyingSessionDates).not.toContain(toLocalDateKey(start))
  })

  it('serializes concurrent session records so focus storms count once', async () => {
    const store = createStore()
    const service = createService(store)
    const now = localTime(2026, 7, 31)

    const results = await Promise.all(
      Array.from({ length: 20 }, () => service.recordQualifyingSession(now))
    )

    expect(results.filter((result) => result.recorded)).toHaveLength(1)
    await expect(store.readState()).resolves.toMatchObject({ qualifyingSessionCount: 1 })
  })
})

describe('evaluateFeedbackPromptEligibility', () => {
  const now = Date.UTC(2026, 6, 31)

  it('qualifies three sessions spanning at least two local dates', () => {
    expect(
      evaluateFeedbackPromptEligibility({
        state: qualifiedState(),
        now,
        eligibilityBaselineAt: now,
        onboardingComplete: true,
        busy: false,
        supportAvailable: true
      })
    ).toEqual({ eligible: true, kind: 'initial', reason: 'eligible-initial' })

    expect(
      evaluateFeedbackPromptEligibility({
        state: qualifiedState({ qualifyingSessionDates: ['2026-07-31'] }),
        now,
        eligibilityBaselineAt: now,
        onboardingComplete: true,
        busy: false,
        supportAvailable: true
      }).reason
    ).toBe('usage-threshold-not-met')
  })

  it('qualifies one session at exactly 14 days after the injected baseline', () => {
    const oneSession = qualifiedState({
      qualifyingSessionCount: 1,
      qualifyingSessionDates: ['2026-07-31']
    })

    expect(
      evaluateFeedbackPromptEligibility({
        state: oneSession,
        now,
        eligibilityBaselineAt: now - FEEDBACK_REMINDER_DELAY_MS,
        onboardingComplete: true,
        busy: false,
        supportAvailable: true
      }).reason
    ).toBe('eligible-initial')
    expect(
      evaluateFeedbackPromptEligibility({
        state: oneSession,
        now,
        eligibilityBaselineAt: now - FEEDBACK_REMINDER_DELAY_MS + 1,
        onboardingComplete: true,
        busy: false,
        supportAvailable: true
      }).reason
    ).toBe('usage-threshold-not-met')
  })

  it('returns bounded gate and terminal reasons', () => {
    const base = {
      state: qualifiedState(),
      now,
      eligibilityBaselineAt: now,
      onboardingComplete: true,
      busy: false,
      supportAvailable: true
    }

    expect(evaluateFeedbackPromptEligibility({ ...base, onboardingComplete: false }).reason).toBe(
      'onboarding-incomplete'
    )
    expect(evaluateFeedbackPromptEligibility({ ...base, busy: true }).reason).toBe('busy')
    expect(evaluateFeedbackPromptEligibility({ ...base, supportAvailable: false }).reason).toBe(
      'support-unavailable'
    )
    expect(
      evaluateFeedbackPromptEligibility({
        ...base,
        state: qualifiedState({ contactInitiatedAt: now })
      }).reason
    ).toBe('contact-initiated')
    expect(
      evaluateFeedbackPromptEligibility({
        ...base,
        state: qualifiedState({ neverAskAgain: true })
      }).reason
    ).toBe('never-ask-again')
  })
})

describe('FeedbackPromptService reservations, impressions, and actions', () => {
  async function seedQualified(store: FeedbackPromptStateStore): Promise<void> {
    await store.updateState(() => qualifiedState())
  }

  it('does not persist an impression until confirmation and confirms exactly once', async () => {
    const store = createStore()
    await seedQualified(store)
    const now = Date.UTC(2026, 6, 31)
    const service = createService(store, {
      now: () => now,
      createReservationId: () => 'reservation-1'
    })

    await expect(service.reservePrompt('upcoming')).resolves.toMatchObject({
      reserved: true,
      reservationId: 'reservation-1',
      kind: 'initial',
      reason: 'eligible-initial'
    })
    await expect(store.readState()).resolves.toMatchObject({ initialPromptShownAt: null })

    const confirmations = await Promise.all([
      service.confirmPrompt('reservation-1', 'upcoming'),
      service.confirmPrompt('reservation-1', 'upcoming')
    ])
    expect(confirmations.filter((confirmation) => confirmation.confirmed)).toHaveLength(1)
    expect(confirmations.find((confirmation) => confirmation.confirmed)).toMatchObject({
      impressionId: 'reservation-1',
      kind: 'initial',
      reason: 'eligible-initial'
    })
    await expect(store.readState()).resolves.toMatchObject({ initialPromptShownAt: now })
  })

  it('allows only one concurrent reservation without persisting either request', async () => {
    const store = createStore()
    await seedQualified(store)
    const service = createService(store, { createReservationId: () => 'only-reservation' })

    const reservations = await Promise.all([
      service.reservePrompt('upcoming'),
      service.reservePrompt('ai_notes')
    ])
    expect(reservations.filter((reservation) => reservation.reserved)).toHaveLength(1)
    expect(reservations.find((reservation) => !reservation.reserved)?.reason).toBe(
      'reservation-active'
    )
    await expect(store.readState()).resolves.toMatchObject({ initialPromptShownAt: null })
  })

  it('cancels only a matching reservation and permits a new reservation afterward', async () => {
    const store = createStore()
    await seedQualified(store)
    const ids = ['reservation-1', 'reservation-2']
    const service = createService(store, { createReservationId: () => ids.shift() ?? 'unexpected' })

    await service.reservePrompt('upcoming')
    await expect(service.cancelPrompt('wrong-id', 'upcoming')).resolves.toBe(false)
    await expect(service.cancelPrompt('reservation-1', 'ai_notes')).resolves.toBe(false)
    await expect(service.cancelPrompt('reservation-1', 'upcoming')).resolves.toBe(true)
    await expect(service.cancelPrompt('reservation-1', 'upcoming')).resolves.toBe(false)
    await expect(service.reservePrompt('ai_notes')).resolves.toMatchObject({
      reserved: true,
      reservationId: 'reservation-2'
    })
    await expect(store.readState()).resolves.toMatchObject({ initialPromptShownAt: null })
  })

  it('expires a reservation at the exact TTL without recording an impression', async () => {
    const store = createStore()
    await seedQualified(store)
    let now = Date.UTC(2026, 6, 31)
    const ids = ['expired-reservation', 'replacement-reservation']
    const service = createService(store, {
      now: () => now,
      createReservationId: () => ids.shift() ?? 'unexpected'
    })

    await service.reservePrompt('upcoming')
    now += FEEDBACK_PROMPT_RESERVATION_TTL_MS
    await expect(service.confirmPrompt('expired-reservation', 'upcoming')).resolves.toMatchObject({
      confirmed: false,
      reason: 'reservation-unavailable'
    })
    await expect(service.reservePrompt('ai_notes')).resolves.toMatchObject({
      reserved: true,
      reservationId: 'replacement-reservation'
    })
    await expect(store.readState()).resolves.toMatchObject({ initialPromptShownAt: null })
  })

  it('rejects wrong confirmation IDs and surfaces without consuming the reservation', async () => {
    const store = createStore()
    await seedQualified(store)
    const service = createService(store, { createReservationId: () => 'reservation-1' })

    await service.reservePrompt('upcoming')
    await expect(service.confirmPrompt('wrong-id', 'upcoming')).resolves.toMatchObject({
      confirmed: false,
      reason: 'reservation-unavailable'
    })
    await expect(service.confirmPrompt('reservation-1', 'ai_notes')).resolves.toMatchObject({
      confirmed: false,
      reason: 'reservation-unavailable'
    })
    await expect(service.confirmPrompt('reservation-1', 'upcoming')).resolves.toMatchObject({
      confirmed: true,
      impressionId: 'reservation-1'
    })
  })

  it('rechecks transient gates at confirmation and consumes a now-unsafe reservation', async () => {
    const store = createStore()
    await seedQualified(store)
    let busy = false
    const ids = ['busy-reservation', 'safe-reservation']
    const service = createService(store, {
      isBusy: () => busy,
      createReservationId: () => ids.shift() ?? 'unexpected'
    })

    await service.reservePrompt('upcoming')
    busy = true
    await expect(service.confirmPrompt('busy-reservation', 'upcoming')).resolves.toMatchObject({
      confirmed: false,
      reason: 'busy'
    })
    await expect(store.readState()).resolves.toMatchObject({ initialPromptShownAt: null })

    busy = false
    await expect(service.reservePrompt('upcoming')).resolves.toMatchObject({
      reserved: true,
      reservationId: 'safe-reservation'
    })
  })

  it('rechecks persisted contact state at confirmation without recording an impression', async () => {
    const store = createStore()
    await seedQualified(store)
    const now = Date.UTC(2026, 6, 31)
    const service = createService(store, {
      now: () => now,
      createReservationId: () => 'reservation-1'
    })

    await service.reservePrompt('upcoming')
    await store.updateState((current) => ({ ...current, contactInitiatedAt: now }))
    await expect(service.confirmPrompt('reservation-1', 'upcoming')).resolves.toMatchObject({
      confirmed: false,
      reason: 'contact-initiated'
    })
    await expect(store.readState()).resolves.toMatchObject({
      initialPromptShownAt: null,
      contactInitiatedAt: now
    })
    await expect(service.reservePrompt('upcoming')).resolves.toMatchObject({
      reserved: false,
      reason: 'contact-initiated'
    })
  })

  it('contact through the service clears an outstanding reservation', async () => {
    const store = createStore()
    await seedQualified(store)
    const now = Date.UTC(2026, 6, 31)
    const service = createService(store, {
      now: () => now,
      createReservationId: () => 'reservation-1'
    })

    await service.reservePrompt('upcoming')
    await service.recordContactInitiated()
    await expect(service.confirmPrompt('reservation-1', 'upcoming')).resolves.toMatchObject({
      confirmed: false,
      reason: 'reservation-unavailable'
    })
    await expect(store.readState()).resolves.toMatchObject({ contactInitiatedAt: now })
  })

  it('allows one reminder at 14 days and never a third appearance', async () => {
    const store = createStore()
    await seedQualified(store)
    let now = Date.UTC(2026, 6, 31)
    const ids = ['initial-impression', 'reminder-impression']
    const service = createService(store, {
      now: () => now,
      createReservationId: () => ids.shift() ?? 'unexpected'
    })

    await service.reservePrompt('upcoming')
    await service.confirmPrompt('initial-impression', 'upcoming')
    now += FEEDBACK_REMINDER_DELAY_MS - 1
    await expect(service.reservePrompt('upcoming')).resolves.toMatchObject({
      reserved: false,
      reason: 'reminder-not-due'
    })
    now += 1
    await expect(service.reservePrompt('upcoming')).resolves.toMatchObject({
      reserved: true,
      kind: 'reminder',
      reservationId: 'reminder-impression'
    })
    await expect(service.confirmPrompt('reminder-impression', 'upcoming')).resolves.toMatchObject({
      confirmed: true,
      kind: 'reminder'
    })
    now += 100 * DAY_MS
    await expect(service.reservePrompt('upcoming')).resolves.toMatchObject({
      reserved: false,
      reason: 'reminder-already-shown'
    })
  })

  it('requires a confirmed impression and matches Later/Dismiss to its appearance', async () => {
    const store = createStore()
    await seedQualified(store)
    let now = Date.UTC(2026, 6, 31)
    const ids = ['initial-impression', 'reminder-impression']
    const service = createService(store, {
      now: () => now,
      createReservationId: () => ids.shift() ?? 'unexpected'
    })

    await expect(service.recordAction('initial-impression', 'later')).resolves.toBe(false)
    await service.reservePrompt('upcoming')
    await expect(service.recordAction('initial-impression', 'later')).resolves.toBe(false)
    await service.confirmPrompt('initial-impression', 'upcoming')
    await expect(service.recordAction('wrong-id', 'later')).resolves.toBe(false)
    await expect(service.recordAction('initial-impression', 'dismiss')).resolves.toBe(false)
    await expect(service.recordAction('initial-impression', 'later')).resolves.toBe(true)
    await expect(service.recordAction('initial-impression', 'later')).resolves.toBe(false)

    now += FEEDBACK_REMINDER_DELAY_MS
    await service.reservePrompt('ai_notes')
    await service.confirmPrompt('reminder-impression', 'ai_notes')
    await expect(service.recordAction('reminder-impression', 'later')).resolves.toBe(false)
    await expect(service.recordAction('reminder-impression', 'dismiss')).resolves.toBe(true)
    await expect(service.recordAction('reminder-impression', 'dismiss')).resolves.toBe(false)
  })

  it('makes Never terminal only from a confirmed impression', async () => {
    const neverStore = createStore()
    await seedQualified(neverStore)
    const now = Date.UTC(2026, 6, 31)
    const neverService = createService(neverStore, {
      now: () => now,
      createReservationId: () => 'never-impression'
    })

    await neverService.reservePrompt('upcoming')
    await expect(neverService.recordAction('never-impression', 'never')).resolves.toBe(false)
    await neverService.confirmPrompt('never-impression', 'upcoming')
    await expect(neverService.recordAction('wrong-id', 'never')).resolves.toBe(false)
    await expect(neverService.recordAction('never-impression', 'never')).resolves.toBe(true)
    await expect(neverService.recordAction('never-impression', 'never')).resolves.toBe(false)
    await expect(neverService.getEligibility()).resolves.toMatchObject({
      eligible: false,
      reason: 'never-ask-again'
    })
  })

  it('successful contact clears a confirmed impression and preserves the first contact time', async () => {
    const contactStore = createStore()
    await seedQualified(contactStore)
    const now = Date.UTC(2026, 6, 31)
    const contactService = createService(contactStore, {
      now: () => now,
      createReservationId: () => 'contact-impression'
    })

    await contactService.reservePrompt('upcoming')
    await contactService.confirmPrompt('contact-impression', 'upcoming')
    await contactService.recordContactInitiated()
    await contactService.recordContactInitiated(now + DAY_MS)
    await expect(contactService.recordAction('contact-impression', 'later')).resolves.toBe(false)
    await expect(contactStore.readState()).resolves.toMatchObject({ contactInitiatedAt: now })
    await expect(contactService.getEligibility()).resolves.toMatchObject({
      eligible: false,
      reason: 'contact-initiated'
    })
  })

  it('atomically replaces fixture state and clears transient prompt ownership', async () => {
    const store = createStore()
    await seedQualified(store)
    const now = Date.UTC(2026, 6, 31)
    const ids = ['reserved-before-replacement', 'confirmed-before-replacement']
    const service = createService(store, {
      now: () => now,
      createReservationId: () => ids.shift() ?? 'unexpected'
    })

    await service.reservePrompt('upcoming')
    const contacted = qualifiedState({ contactInitiatedAt: now })
    await expect(service.replaceStateForFixture(contacted)).resolves.toEqual(contacted)
    await expect(
      service.confirmPrompt('reserved-before-replacement', 'upcoming')
    ).resolves.toMatchObject({ confirmed: false, reason: 'reservation-unavailable' })

    await service.replaceStateForFixture(qualifiedState())
    await service.reservePrompt('ai_notes')
    await service.confirmPrompt('confirmed-before-replacement', 'ai_notes')
    const never = qualifiedState({ neverAskAgain: true })
    await expect(service.replaceStateForFixture(never)).resolves.toEqual(never)
    await expect(service.recordAction('confirmed-before-replacement', 'never')).resolves.toBe(false)
    await expect(store.readState()).resolves.toEqual(never)
  })

  it('fails quiet when state or an injected dependency is unavailable', async () => {
    const unavailableStore: FeedbackPromptStateStore = {
      readState: async () => null,
      updateState: async () => null
    }
    await expect(createService(unavailableStore).getEligibility()).resolves.toMatchObject({
      eligible: false,
      reason: 'state-unavailable'
    })

    const store = createStore()
    await seedQualified(store)
    const service = createService(store, {
      isBusy: () => {
        throw new Error('Busy state unavailable')
      },
      createReservationId: () => 'reservation-1'
    })
    await expect(service.reservePrompt('upcoming')).resolves.toMatchObject({
      reserved: false,
      reason: 'dependency-unavailable'
    })
  })

  it('fails closed when reservation creation or confirmation persistence fails', async () => {
    const store = createStore()
    await seedQualified(store)

    const invalidIdService = createService(store, {
      createReservationId: () => {
        throw new Error('Random source unavailable')
      }
    })
    await expect(invalidIdService.reservePrompt('upcoming')).resolves.toMatchObject({
      reserved: false,
      reason: 'reservation-unavailable'
    })

    const persistenceUnavailableStore: FeedbackPromptStateStore = {
      readState: async () => qualifiedState(),
      updateState: async () => null
    }
    const persistenceUnavailableService = createService(persistenceUnavailableStore, {
      createReservationId: () => 'reservation-1'
    })
    await expect(persistenceUnavailableService.reservePrompt('upcoming')).resolves.toMatchObject({
      reserved: true,
      reservationId: 'reservation-1'
    })
    await expect(
      persistenceUnavailableService.confirmPrompt('reservation-1', 'upcoming')
    ).resolves.toMatchObject({ confirmed: false, reason: 'state-unavailable' })
    await expect(
      persistenceUnavailableService.recordAction('reservation-1', 'later')
    ).resolves.toBe(false)
  })
})
