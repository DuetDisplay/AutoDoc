import { ipcMain, type WebContents } from 'electron'
import type {
  FeedbackPromptConfirmationResponse,
  FeedbackPromptAction,
  FeedbackPromptReservationResponse,
  FeedbackPromptSurface
} from '../../shared/types'
import type { FeedbackPromptService } from '../services/feedback-prompt-service'

const FEEDBACK_PROMPT_SURFACES = [
  'upcoming',
  'ai_notes'
] as const satisfies readonly FeedbackPromptSurface[]
const FEEDBACK_PROMPT_ACTIONS = [
  'later',
  'dismiss',
  'never'
] as const satisfies readonly FeedbackPromptAction[]

export function isFeedbackPromptSurface(value: unknown): value is FeedbackPromptSurface {
  return FEEDBACK_PROMPT_SURFACES.some((surface) => surface === value)
}

export function isFeedbackPromptAction(value: unknown): value is FeedbackPromptAction {
  return FEEDBACK_PROMPT_ACTIONS.some((action) => action === value)
}

export function isFeedbackPromptReservationId(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 128 && value.trim() === value
  )
}

export interface RegisterFeedbackPromptIpcOptions {
  isTrustedSender: (sender: WebContents) => boolean
  observeForeground: () => void
}

export function registerFeedbackPromptIpc(
  service: FeedbackPromptService,
  options: RegisterFeedbackPromptIpcOptions
): void {
  ipcMain.handle('feedback:observe-foreground', (event): void => {
    if (!options.isTrustedSender(event.sender)) return
    options.observeForeground()
  })

  ipcMain.handle(
    'feedback:reserve-prompt',
    async (event, rawSurface: unknown): Promise<FeedbackPromptReservationResponse> => {
      if (!options.isTrustedSender(event.sender) || !isFeedbackPromptSurface(rawSurface)) {
        return { status: 'suppressed' }
      }

      const result = await service.reservePrompt(rawSurface)
      if (!result.reserved || !result.reservationId || !result.kind) {
        return { status: 'suppressed' }
      }
      return {
        status: 'reserved',
        reservationId: result.reservationId,
        appearance: result.kind
      }
    }
  )

  ipcMain.handle(
    'feedback:confirm-prompt',
    async (
      event,
      rawReservationId: unknown,
      rawSurface: unknown
    ): Promise<FeedbackPromptConfirmationResponse> => {
      if (
        !options.isTrustedSender(event.sender) ||
        !isFeedbackPromptReservationId(rawReservationId) ||
        !isFeedbackPromptSurface(rawSurface)
      ) {
        return { status: 'rejected' }
      }

      const result = await service.confirmPrompt(rawReservationId, rawSurface)
      return result.confirmed ? { status: 'confirmed' } : { status: 'rejected' }
    }
  )

  ipcMain.handle(
    'feedback:cancel-prompt',
    async (event, rawReservationId: unknown, rawSurface: unknown): Promise<boolean> => {
      if (
        !options.isTrustedSender(event.sender) ||
        !isFeedbackPromptReservationId(rawReservationId) ||
        !isFeedbackPromptSurface(rawSurface)
      ) {
        return false
      }
      return await service.cancelPrompt(rawReservationId, rawSurface)
    }
  )

  ipcMain.handle(
    'feedback:record-action',
    async (event, rawImpressionId: unknown, rawAction: unknown): Promise<boolean> => {
      if (
        !options.isTrustedSender(event.sender) ||
        !isFeedbackPromptReservationId(rawImpressionId) ||
        !isFeedbackPromptAction(rawAction)
      ) {
        return false
      }
      return await service.recordAction(rawImpressionId, rawAction)
    }
  )
}
