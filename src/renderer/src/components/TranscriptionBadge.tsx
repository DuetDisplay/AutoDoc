import type { TranscriptionStatus } from '../../../shared/types'

const STATUS_CONFIG: Record<TranscriptionStatus, { label: string; className: string }> = {
  pending: {
    label: 'Awaiting transcription',
    className: 'text-ink-faint bg-bg-accent',
  },
  queued: {
    label: 'Awaiting transcription',
    className: 'text-ink-faint bg-bg-accent',
  },
  downloading: {
    label: 'Downloading model...',
    className: 'text-ink-muted bg-bg-accent animate-pulse',
  },
  transcribing: {
    label: 'Transcribing...',
    className: 'text-ink-muted bg-bg-accent animate-pulse',
  },
  complete: {
    label: 'Transcribed',
    className: 'text-green-700 bg-green-50',
  },
  failed: {
    label: 'Failed — Retry',
    className: 'text-red-700 bg-red-50 cursor-pointer hover:bg-red-100',
  },
}

interface TranscriptionBadgeProps {
  status: TranscriptionStatus
  onRetry?: () => void
}

export function TranscriptionBadge({ status, onRetry }: TranscriptionBadgeProps) {
  const config = STATUS_CONFIG[status]

  return (
    <span
      className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${config.className}`}
      onClick={status === 'failed' ? onRetry : undefined}
    >
      {config.label}
    </span>
  )
}
