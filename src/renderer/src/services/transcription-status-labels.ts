import type { TranscriptionStatusPayload } from '../../../shared/types'

function formatQualityLabel(qualityMode: 'fast' | 'balanced' | undefined): string {
  if (qualityMode === 'fast') return 'Fast'
  return 'Balanced'
}

function formatBackendShortLabel(backendLabel: string | undefined): string | null {
  if (!backendLabel) return null
  const normalized = backendLabel.toLowerCase()
  if (normalized.includes('gpu') || normalized.includes('nvidia') || normalized.includes('cuda')) {
    return 'GPU'
  }
  if (normalized.includes('cpu')) {
    return 'CPU'
  }
  return backendLabel
}

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
  payload: Pick<
    TranscriptionStatusPayload,
    'status' | 'progress' | 'backendLabel' | 'qualityMode' | 'etaSeconds'
  >
): string | null {
  if (payload.status !== 'transcribing') {
    return null
  }

  const backend = formatBackendShortLabel(payload.backendLabel)
  const quality = formatQualityLabel(payload.qualityMode)
  const eta = formatEtaLabel(payload.etaSeconds)

  if (backend) {
    const base = `Transcribing on ${backend} (${quality})`
    return eta ? `${base} — ${eta}` : base
  }

  if (payload.progress != null) {
    return eta ? `Transcribing ${payload.progress}% — ${eta}` : `Transcribing ${payload.progress}%`
  }

  return eta ? `Transcribing... — ${eta}` : 'Transcribing...'
}
