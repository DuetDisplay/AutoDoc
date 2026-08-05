import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type {
  FeedbackPromptAction,
  FeedbackPromptAppearance,
  FeedbackPromptSurface,
  OpenSupportEmailResult
} from '../../../shared/types'
import { trackEvent } from '../services/analytics'
import { FeedbackPromptCard, type FeedbackPromptCopyStatus } from './FeedbackPromptCard'

const PROMPT_RECHECK_INTERVAL_MS = 5_000

interface PromptReservation {
  id: string
  appearance: FeedbackPromptAppearance
  confirmed: boolean
}

function isRendererForegrounded(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus()
}

function trackSupportOutcome(
  surface: FeedbackPromptSurface,
  outcome: 'draft_opened' | 'copy_required' | 'address_copied' | 'copy_failed' | 'unavailable'
): void {
  trackEvent('support_email_outcome', { surface, outcome })
}

export interface FeedbackPromptSlotProps {
  surface: FeedbackPromptSurface
  suppressed?: boolean
}

export function FeedbackPromptSlot({
  surface,
  suppressed = false
}: FeedbackPromptSlotProps): ReactElement | null {
  const initialForegrounded = isRendererForegrounded()
  const [reservation, setReservation] = useState<PromptReservation | null>(null)
  const [finished, setFinished] = useState(false)
  const [foregrounded, setForegrounded] = useState(initialForegrounded)
  const [pending, setPending] = useState(false)
  const [supportResult, setSupportResult] = useState<OpenSupportEmailResult | null>(null)
  const [copyStatus, setCopyStatus] = useState<FeedbackPromptCopyStatus>('idle')
  const mountedRef = useRef(false)
  const reservationRef = useRef<PromptReservation | null>(null)
  const suppressedRef = useRef(suppressed)
  const foregroundedRef = useRef(initialForegrounded)
  const finishedRef = useRef(false)
  const promptElementRef = useRef<HTMLDivElement | null>(null)
  const reserveInFlightRef = useRef(false)
  const requestInFlightRef = useRef(false)

  suppressedRef.current = suppressed
  foregroundedRef.current = foregrounded
  finishedRef.current = finished

  const replaceReservation = useCallback((next: PromptReservation | null): void => {
    reservationRef.current = next
    setReservation(next)
  }, [])

  const finishPrompt = useCallback((): void => {
    reservationRef.current = null
    finishedRef.current = true
    setReservation(null)
    setFinished(true)
  }, [])

  const cancelReservation = useCallback(
    (id: string): void => {
      void window.electronAPI.invoke('feedback:cancel-prompt', id, surface).catch(() => {})
    },
    [surface]
  )

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      const current = reservationRef.current
      if (current && !current.confirmed) cancelReservation(current.id)
      reservationRef.current = null
    }
  }, [cancelReservation])

  useEffect(() => {
    const refreshForegroundState = (): void => {
      const next = isRendererForegrounded()
      foregroundedRef.current = next
      setForegrounded(next)
    }
    window.addEventListener('focus', refreshForegroundState)
    window.addEventListener('blur', refreshForegroundState)
    document.addEventListener('visibilitychange', refreshForegroundState)

    return () => {
      window.removeEventListener('focus', refreshForegroundState)
      window.removeEventListener('blur', refreshForegroundState)
      document.removeEventListener('visibilitychange', refreshForegroundState)
    }
  }, [])

  useEffect(() => {
    return window.electronAPI.on('feedback:contact-initiated', () => {
      const current = reservationRef.current
      if (current && !current.confirmed) cancelReservation(current.id)
      finishPrompt()
    })
  }, [cancelReservation, finishPrompt])

  useEffect(() => {
    if (!foregrounded) return
    void window.electronAPI.invoke('feedback:observe-foreground').catch(() => {})
  }, [foregrounded])

  const reservePrompt = useCallback(async (): Promise<void> => {
    if (
      reservationRef.current !== null ||
      finishedRef.current ||
      suppressedRef.current ||
      !foregroundedRef.current ||
      reserveInFlightRef.current
    ) {
      return
    }

    reserveInFlightRef.current = true
    try {
      const result = await window.electronAPI.invoke('feedback:reserve-prompt', surface)
      if (result.status !== 'reserved') return

      if (
        !mountedRef.current ||
        finishedRef.current ||
        suppressedRef.current ||
        !foregroundedRef.current
      ) {
        cancelReservation(result.reservationId)
        return
      }

      replaceReservation({
        id: result.reservationId,
        appearance: result.appearance,
        confirmed: false
      })
    } catch {
      // Prompt state fails closed in main; renderer remains quiet as well.
    } finally {
      reserveInFlightRef.current = false
    }
  }, [cancelReservation, replaceReservation, surface])

  useEffect(() => {
    if (reservation !== null || finished || suppressed || !foregrounded) return

    void reservePrompt()
    const interval = window.setInterval(() => void reservePrompt(), PROMPT_RECHECK_INTERVAL_MS)
    return () => window.clearInterval(interval)
  }, [finished, foregrounded, reservation, reservePrompt, suppressed])

  useEffect(() => {
    if (!reservation || reservation.confirmed) return

    const reservationId = reservation.id
    let firstFrame = 0
    let secondFrame = 0
    let confirmationStarted = false

    const abandon = (): void => {
      if (reservationRef.current?.id !== reservationId) return
      cancelReservation(reservationId)
      replaceReservation(null)
    }

    if (finished || suppressed || !foregrounded) {
      abandon()
      return
    }

    firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        const element = promptElementRef.current
        if (
          reservationRef.current?.id !== reservationId ||
          finishedRef.current ||
          suppressedRef.current ||
          !foregroundedRef.current ||
          !element?.isConnected
        ) {
          abandon()
          return
        }

        confirmationStarted = true
        void window.electronAPI
          .invoke('feedback:confirm-prompt', reservationId, surface)
          .then((result) => {
            if (result.status !== 'confirmed') {
              if (mountedRef.current && reservationRef.current?.id === reservationId) {
                replaceReservation(null)
              }
              return
            }

            trackEvent('feedback_prompt_shown', {
              surface,
              appearance: reservation.appearance
            })
            if (mountedRef.current && reservationRef.current?.id === reservationId) {
              replaceReservation({ ...reservation, confirmed: true })
            }
          })
          .catch(() => {
            if (mountedRef.current && reservationRef.current?.id === reservationId) {
              replaceReservation(null)
            }
          })
      })
    })

    return () => {
      window.cancelAnimationFrame(firstFrame)
      window.cancelAnimationFrame(secondFrame)
      if (!confirmationStarted && reservationRef.current?.id === reservationId) {
        cancelReservation(reservationId)
      }
    }
  }, [
    cancelReservation,
    finished,
    foregrounded,
    replaceReservation,
    reservation,
    suppressed,
    surface
  ])

  const recordPromptAction = useCallback(
    async (
      analyticsAction: 'later' | 'dismiss' | 'dont_ask_again',
      stateAction: FeedbackPromptAction
    ): Promise<void> => {
      if (requestInFlightRef.current || !reservation?.confirmed) return

      requestInFlightRef.current = true
      setPending(true)
      trackEvent('feedback_prompt_action', {
        surface,
        appearance: reservation.appearance,
        action: analyticsAction
      })

      try {
        const recorded = await window.electronAPI.invoke(
          'feedback:record-action',
          reservation.id,
          stateAction
        )
        if (recorded) finishPrompt()
      } catch {
        // Keep the choice visible if its durable state could not be recorded.
      } finally {
        requestInFlightRef.current = false
        setPending(false)
      }
    },
    [finishPrompt, reservation, surface]
  )

  const shareFeedback = useCallback(async (): Promise<void> => {
    if (requestInFlightRef.current || !reservation?.confirmed) return

    requestInFlightRef.current = true
    setPending(true)
    setSupportResult(null)
    setCopyStatus('idle')
    trackEvent('feedback_prompt_action', {
      surface,
      appearance: reservation.appearance,
      action: 'share_feedback'
    })
    trackEvent('support_email_requested', { surface })

    try {
      const result = await window.electronAPI.invoke('support:open-email', surface)
      setSupportResult(result)

      if (result.status === 'opened') {
        trackSupportOutcome(surface, 'draft_opened')
        finishPrompt()
      } else if (result.status === 'copy-required') {
        trackSupportOutcome(surface, 'copy_required')
      } else {
        trackSupportOutcome(surface, 'unavailable')
      }
    } catch {
      setSupportResult({ status: 'unavailable' })
      trackSupportOutcome(surface, 'unavailable')
    } finally {
      requestInFlightRef.current = false
      setPending(false)
    }
  }, [finishPrompt, reservation, surface])

  const copySupportAddress = useCallback(async (): Promise<void> => {
    if (requestInFlightRef.current || !reservation?.confirmed) return

    requestInFlightRef.current = true
    setPending(true)
    try {
      const result = await window.electronAPI.invoke('support:copy-email', surface)
      if (result.status === 'copied') {
        setCopyStatus('copied')
        trackSupportOutcome(surface, 'address_copied')
        finishPrompt()
      } else if (result.status === 'copy-failed') {
        setCopyStatus('failed')
        trackSupportOutcome(surface, 'copy_failed')
      } else {
        setSupportResult({ status: 'unavailable' })
        trackSupportOutcome(surface, 'unavailable')
      }
    } catch {
      setCopyStatus('failed')
      trackSupportOutcome(surface, 'copy_failed')
    } finally {
      requestInFlightRef.current = false
      setPending(false)
    }
  }, [finishPrompt, reservation, surface])

  if (!reservation || finished || suppressed || !foregrounded) return null

  return (
    <div ref={promptElementRef} className="shrink-0 px-6 pt-4">
      <FeedbackPromptCard
        appearance={reservation.appearance}
        pending={pending || !reservation.confirmed}
        supportResult={supportResult}
        copyStatus={copyStatus}
        onShare={() => void shareFeedback()}
        onCopy={() => void copySupportAddress()}
        onLater={() => void recordPromptAction('later', 'later')}
        onNever={() => void recordPromptAction('dont_ask_again', 'never')}
        onDismiss={() => void recordPromptAction('dismiss', 'dismiss')}
      />
    </div>
  )
}
