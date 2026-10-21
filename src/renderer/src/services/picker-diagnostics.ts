import { recordPersistentDiagnosticAction } from './diagnostic-trail'
import type { PickerDiagnosticTrigger } from '../stores/recording-picker'

// Ids, booleans and counts only. Window and event titles must never be logged here.

// Diagnostics must never get in the way of the user picking a window.
function safeRecord(action: string, details: Record<string, unknown>): void {
  try {
    recordPersistentDiagnosticAction({ category: 'recording', action, details })
  } catch {
    // Ignore: the picker keeps working without the log line.
  }
}

export function logPickerOpened(params: {
  trigger: PickerDiagnosticTrigger
  requestId: number | null
  eventId: string | null
  sourceCount: number
  suggestionHighlighted: boolean
}): void {
  safeRecord('recording_picker_opened', { ...params })
}

export function logPickerResult(params: {
  trigger: PickerDiagnosticTrigger
  requestId: number | null
  eventId: string | null
  result: 'picked' | 'cancelled'
  /** Index of the picked source in the scored list, or null when it was not scored. */
  pickedIndex?: number | null
  pickedWasSuggested?: boolean
  sourceType?: 'window' | 'screen'
}): void {
  safeRecord('recording_picker_result', { ...params })
}
