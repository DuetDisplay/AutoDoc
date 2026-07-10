import type { TranscriptionStatusPayload } from '../../../shared/types'

function formatEtaLabel(etaSeconds: number | null | undefined): string | null {
  if (etaSeconds == null || !Number.isFinite(etaSeconds) || etaSeconds <= 0) {
    return null
  }

  if (etaSeconds < 60) {
    return 'less than a minute left'
  }

  const minutes = Math.max(1, Math.round(etaSeconds / 60))
  return `about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} left`
}

export function formatTranscriptionStatusText(
  payload: Pick<TranscriptionStatusPayload, 'status' | 'progress' | 'etaSeconds'>
): string | null {
  if (payload.status !== 'transcribing') {
    return null
  }

  const eta = formatEtaLabel(payload.etaSeconds)
  const base =
    payload.progress != null ? `Transcribing ${payload.progress}%` : 'Transcribing...'

  return eta ? `${base} — ${eta}` : base
}
