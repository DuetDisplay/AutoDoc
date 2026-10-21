import type { MutableRefObject } from 'react'
import { recordPersistentDiagnosticAction } from './diagnostic-trail'

/** How often the renderer looks again for the meeting window while it is still missing. */
export const AUTO_RECORD_WINDOW_POLL_MS = 2_000
/** How long it keeps looking before falling back to asking the user to pick a window. */
export const AUTO_RECORD_WINDOW_WAIT_MS = 30_000

/**
 * A pending wait for a meeting window to appear after an auto-record request. Slack turns the mic
 * on in its pre-join preview, before the huddle window exists, so Slack requests wait here
 * instead of escalating to window selection straight away.
 */
export interface AutoRecordWindowWait {
  requestId: number
  eventId: string | null
  attempt: number
  cancelled: boolean
  /** Ends the current sleep early; set only while sleeping. */
  wake: (() => void) | null
}

export type AutoRecordWaitCancelReason =
  | 'mic_inactive'
  | 'superseded'
  | 'recording_started'
  | 'unmounted'

export function sleepForAutoRecordWait(wait: AutoRecordWindowWait, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wait.wake = null
      resolve()
    }, ms)
    wait.wake = () => {
      clearTimeout(timer)
      wait.wake = null
      resolve()
    }
  })
}

/** Cancels the active wait, if any, and returns whether there was one. */
export function cancelAutoRecordWait(
  ref: MutableRefObject<AutoRecordWindowWait | null>,
  reason: AutoRecordWaitCancelReason
): boolean {
  const wait = ref.current
  if (!wait) return false
  ref.current = null
  wait.cancelled = true
  wait.wake?.()
  if (reason !== 'unmounted') {
    recordPersistentDiagnosticAction({
      category: 'recording',
      action: 'auto_record_decision',
      details: {
        requestId: wait.requestId,
        outcome: 'wait_cancelled',
        reason,
        attempt: wait.attempt,
        waitingForMeetingWindow: false,
        eventId: wait.eventId
      }
    })
  }
  return true
}
