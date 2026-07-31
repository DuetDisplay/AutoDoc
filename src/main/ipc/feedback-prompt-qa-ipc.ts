import { ipcMain, type WebContents } from 'electron'
import type { FeedbackPromptQAScenario, FeedbackPromptQASnapshot } from '../../shared/types'
import {
  FEEDBACK_REMINDER_DELAY_MS,
  toLocalDateKey,
  type FeedbackPromptService
} from '../services/feedback-prompt-service'
import {
  createDefaultFeedbackPromptState,
  type FeedbackPromptState,
  type FeedbackPromptStore
} from '../services/feedback-prompt-store'

export const QA_FEEDBACK_SIMULATOR_MARKER = 'AUTODOC_QA_FEEDBACK_SIMULATOR_V1'

const QA_SCENARIOS = [
  'reset',
  'initial',
  'reminder',
  'contacted',
  'never'
] as const satisfies readonly FeedbackPromptQAScenario[]

export interface RegisterFeedbackPromptQAIpcOptions {
  isTrustedSender: (sender: WebContents) => boolean
  isWindowForegrounded: () => boolean
  isSupportAvailable: () => boolean
  now?: () => number
}

export function isFeedbackPromptQAScenario(value: unknown): value is FeedbackPromptQAScenario {
  return QA_SCENARIOS.some((scenario) => scenario === value)
}

export function createFeedbackPromptQAState(
  scenario: FeedbackPromptQAScenario,
  now: number
): FeedbackPromptState {
  const state = createDefaultFeedbackPromptState()
  if (scenario === 'reset') return state

  const previousDay = new Date(now)
  previousDay.setDate(previousDay.getDate() - 1)
  state.qualifyingSessionCount = 3
  state.qualifyingSessionDates = [toLocalDateKey(now), toLocalDateKey(previousDay.getTime())]
  state.lastQualifiedSessionAt = now

  if (scenario === 'reminder') {
    state.initialPromptShownAt = now - FEEDBACK_REMINDER_DELAY_MS - 1_000
  } else if (scenario === 'contacted') {
    state.contactInitiatedAt = now
  } else if (scenario === 'never') {
    state.neverAskAgain = true
  }

  return state
}

export function registerFeedbackPromptQAIpc(
  service: FeedbackPromptService,
  store: FeedbackPromptStore,
  options: RegisterFeedbackPromptQAIpcOptions
): void {
  const now = options.now ?? Date.now

  const getSnapshot = async (): Promise<FeedbackPromptQASnapshot> => {
    const [state, eligibility] = await Promise.all([store.readState(), service.getEligibility()])
    return {
      stateAvailable: state !== null,
      eligible: eligibility.eligible,
      kind: eligibility.kind,
      reason: eligibility.reason,
      windowForegrounded: options.isWindowForegrounded(),
      supportAvailable: options.isSupportAvailable(),
      state: state
        ? {
            qualifyingSessionCount: state.qualifyingSessionCount,
            qualifyingSessionDates: [...state.qualifyingSessionDates],
            lastQualifiedSessionAt: state.lastQualifiedSessionAt,
            initialPromptShownAt: state.initialPromptShownAt,
            reminderPromptShownAt: state.reminderPromptShownAt,
            contactInitiatedAt: state.contactInitiatedAt,
            neverAskAgain: state.neverAskAgain
          }
        : null
    }
  }

  ipcMain.handle(
    'qa:feedback-prompt:get-state',
    async (event): Promise<FeedbackPromptQASnapshot | null> => {
      if (!options.isTrustedSender(event.sender)) return null
      return await getSnapshot()
    }
  )

  ipcMain.handle(
    'qa:feedback-prompt:set-scenario',
    async (event, rawScenario: unknown): Promise<FeedbackPromptQASnapshot | null> => {
      if (!options.isTrustedSender(event.sender) || !isFeedbackPromptQAScenario(rawScenario)) {
        return null
      }

      const currentTime = now()
      if (!Number.isFinite(currentTime) || currentTime < 0) return null

      const state = await service.replaceStateForFixture(
        createFeedbackPromptQAState(rawScenario, currentTime)
      )
      if (!state) return null
      return await getSnapshot()
    }
  )
}
