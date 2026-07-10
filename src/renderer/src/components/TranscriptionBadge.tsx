import { useEffect, useState } from 'react'
import type { TranscriptionStatus, TranscriptionStatusPayload } from '../../../shared/types'
import { getWhisperSetupLabel } from '../services/setup-status-labels'
import { formatTranscriptionStatusText } from '../services/transcription-status-labels'

const STATUS_CONFIG: Record<TranscriptionStatus, { label: string; className: string }> = {
  pending: {
    label: 'Awaiting transcription',
    className: 'text-ink-faint bg-bg-accent'
  },
  queued: {
    label: 'Awaiting transcription',
    className: 'text-ink-faint bg-bg-accent'
  },
  downloading: {
    label: 'Downloading model...',
    className: 'text-ink-muted bg-bg-accent animate-pulse'
  },
  transcribing: {
    label: 'Transcribing...',
    className: 'text-ink-muted bg-bg-accent'
  },
  diarizing: {
    label: 'Identifying speakers...',
    className: 'text-ink-muted bg-bg-accent animate-pulse'
  },
  complete: {
    label: 'Transcribed',
    className: 'text-green-700 bg-green-50'
  },
  failed: {
    label: 'Failed — Retry',
    className: 'text-red-700 bg-red-50 cursor-pointer hover:bg-red-100'
  }
}

interface TranscriptionBadgeProps {
  status: TranscriptionStatus
  progress?: number
  backendLabel?: string
  qualityMode?: 'fast' | 'balanced'
  etaSeconds?: number | null
  onRetry?: () => void
}

export function TranscriptionBadge({
  status,
  progress,
  etaSeconds,
  onRetry
}: TranscriptionBadgeProps) {
  const config = STATUS_CONFIG[status]
  const [setupStatus, setSetupStatus] = useState<
    import('../../../shared/types').WhisperSetupStatus | null
  >(null)

  useEffect(() => {
    if (status !== 'downloading') {
      setSetupStatus(null)
      return
    }

    window.electronAPI.invoke('whisper:get-setup-status').then(setSetupStatus)
    const unsub = window.electronAPI.on('whisper:setup-progress', setSetupStatus)
    return unsub
  }, [status])

  const showProgress = status === 'transcribing' && progress != null
  const setupLabel = status === 'downloading' ? getWhisperSetupLabel(setupStatus) : null
  const transcribingLabel =
    status === 'transcribing'
      ? formatTranscriptionStatusText({
          status,
          progress,
          etaSeconds
        } satisfies Pick<TranscriptionStatusPayload, 'status' | 'progress' | 'etaSeconds'>)
      : null

  return (
    <span
      className={`relative text-[10px] font-medium px-2 py-0.5 rounded-full overflow-hidden ${config.className}`}
      onClick={status === 'failed' ? onRetry : undefined}
    >
      {showProgress && (
        <span
          className="absolute inset-0 bg-sage/20 transition-[width] duration-500 ease-linear"
          style={{ width: `${progress}%` }}
        />
      )}
      <span className="relative">
        {transcribingLabel ??
          (showProgress ? `Transcribing ${progress}%` : (setupLabel ?? config.label))}
      </span>
    </span>
  )
}
