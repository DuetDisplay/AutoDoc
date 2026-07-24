import type { TranscriptionStatusPayload } from '../../../shared/types'

export function formatTranscriptionStatusText(
  payload: Pick<TranscriptionStatusPayload, 'status' | 'progress'>
): string | null {
  if (payload.status !== 'transcribing') {
    return null
  }

  return payload.progress != null ? `Transcribing ${payload.progress}%` : 'Transcribing...'
}
