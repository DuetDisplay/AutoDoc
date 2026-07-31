import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (...args: any[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => unknown) => {
      handlers.set(channel, handler)
    })
  }
}))

import {
  createFeedbackPromptQAState,
  isFeedbackPromptQAScenario,
  registerFeedbackPromptQAIpc
} from '../feedback-prompt-qa-ipc'
import {
  evaluateFeedbackPromptEligibility,
  FEEDBACK_REMINDER_DELAY_MS
} from '../../services/feedback-prompt-service'
import {
  createDefaultFeedbackPromptState,
  type FeedbackPromptState
} from '../../services/feedback-prompt-store'

const NOW = new Date(2026, 6, 31, 12).getTime()
const trustedSender = { id: 1 }
const untrustedSender = { id: 2 }

function handler(channel: string): (...args: any[]) => unknown {
  const registered = handlers.get(channel)
  if (!registered) throw new Error(`Missing handler for ${channel}`)
  return registered
}

function register() {
  let state: FeedbackPromptState = createDefaultFeedbackPromptState()
  const service = {
    replaceStateForFixture: vi.fn(async (nextState: FeedbackPromptState) => {
      state = structuredClone(nextState)
      return structuredClone(state)
    }),
    getEligibility: vi.fn(async () =>
      evaluateFeedbackPromptEligibility({
        state,
        now: NOW,
        eligibilityBaselineAt: NOW - FEEDBACK_REMINDER_DELAY_MS,
        onboardingComplete: true,
        busy: false,
        supportAvailable: true
      })
    )
  }
  const store = {
    readState: vi.fn(async () => structuredClone(state))
  }

  registerFeedbackPromptQAIpc(service as any, store as any, {
    isTrustedSender: (sender) => sender === trustedSender,
    isWindowForegrounded: () => true,
    isSupportAvailable: () => true,
    now: () => NOW
  })
  return { service, store }
}

describe('QA feedback prompt IPC', () => {
  beforeEach(() => {
    handlers.clear()
  })

  it('builds bounded first, reminder, suppression, and reset states', () => {
    const initial = createFeedbackPromptQAState('initial', NOW)
    expect(initial).toMatchObject({
      qualifyingSessionCount: 3,
      initialPromptShownAt: null,
      reminderPromptShownAt: null,
      contactInitiatedAt: null,
      neverAskAgain: false
    })
    expect(initial.qualifyingSessionDates).toHaveLength(2)

    expect(createFeedbackPromptQAState('reminder', NOW)).toMatchObject({
      initialPromptShownAt: NOW - FEEDBACK_REMINDER_DELAY_MS - 1_000,
      reminderPromptShownAt: null
    })
    expect(createFeedbackPromptQAState('contacted', NOW).contactInitiatedAt).toBe(NOW)
    expect(createFeedbackPromptQAState('never', NOW).neverAskAgain).toBe(true)
    expect(createFeedbackPromptQAState('reset', NOW)).toEqual(createDefaultFeedbackPromptState())
  })

  it('accepts only the finite scenario contract', () => {
    for (const scenario of ['reset', 'initial', 'reminder', 'contacted', 'never']) {
      expect(isFeedbackPromptQAScenario(scenario)).toBe(true)
    }
    for (const scenario of ['', 'initial-eligible', 'production', {}, null]) {
      expect(isFeedbackPromptQAScenario(scenario)).toBe(false)
    }
  })

  it('applies scenarios and returns readable state only to the trusted window', async () => {
    const { service } = register()

    await expect(
      handler('qa:feedback-prompt:get-state')({ sender: untrustedSender })
    ).resolves.toBeNull()
    await expect(
      handler('qa:feedback-prompt:set-scenario')({ sender: untrustedSender }, 'initial')
    ).resolves.toBeNull()
    await expect(
      handler('qa:feedback-prompt:set-scenario')({ sender: trustedSender }, 'arbitrary')
    ).resolves.toBeNull()
    expect(service.replaceStateForFixture).not.toHaveBeenCalled()

    await expect(
      handler('qa:feedback-prompt:set-scenario')({ sender: trustedSender }, 'initial')
    ).resolves.toMatchObject({
      stateAvailable: true,
      eligible: true,
      kind: 'initial',
      reason: 'eligible-initial',
      windowForegrounded: true,
      supportAvailable: true,
      state: { qualifyingSessionCount: 3, neverAskAgain: false }
    })
    expect(service.replaceStateForFixture).toHaveBeenCalledOnce()
  })

  it('surfaces final suppression reasons for deterministic QA verification', async () => {
    register()

    await expect(
      handler('qa:feedback-prompt:set-scenario')({ sender: trustedSender }, 'contacted')
    ).resolves.toMatchObject({ eligible: false, reason: 'contact-initiated' })
    await expect(
      handler('qa:feedback-prompt:set-scenario')({ sender: trustedSender }, 'never')
    ).resolves.toMatchObject({ eligible: false, reason: 'never-ask-again' })
    await expect(
      handler('qa:feedback-prompt:set-scenario')({ sender: trustedSender }, 'reset')
    ).resolves.toMatchObject({ eligible: false, reason: 'usage-threshold-not-met' })
  })
})
