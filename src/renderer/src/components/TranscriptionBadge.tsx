import { useT } from '../services/i18n'
import type { MessageKey } from '../../../shared/i18n'
import { useEffect, useRef, useState } from 'react'
import type { TranscriptionStatus, TranscriptionStatusPayload } from '../../../shared/types'
import { getWhisperSetupLabel } from '../services/setup-status-labels'
import { formatTranscriptionStatusText } from '../services/transcription-status-labels'

const STATUS_CONFIG: Record<TranscriptionStatus, { label: MessageKey; className: string }> = {
  pending: {
    label: 'ui.awaitingTranscription',
    className: 'text-ink-faint bg-bg-accent'
  },
  queued: {
    label: 'ui.awaitingTranscription',
    className: 'text-ink-faint bg-bg-accent'
  },
  downloading: {
    label: 'ui.downloadingModel',
    className: 'text-ink-muted bg-bg-accent'
  },
  transcribing: {
    label: 'ui.transcribing',
    className: 'text-ink-secondary bg-bg-accent'
  },
  diarizing: {
    label: 'ui.identifyingSpeakers',
    className: 'text-ink-muted bg-bg-accent'
  },
  complete: {
    label: 'ui.transcribed',
    className: 'text-sage-dark bg-sage-light'
  },
  failed: {
    label: 'ui.failedRetry',
    className: 'text-clay-dark bg-clay-light'
  }
}

interface TranscriptionBadgeProps {
  status: TranscriptionStatus
  progress?: number
  backendLabel?: string
  hasMemoryFailure?: boolean
  onRetry?: () => void
}

export function TranscriptionBadge({
  status,
  progress,
  onRetry,
  hasMemoryFailure
}: TranscriptionBadgeProps) {
  const t = useT()
  const config = STATUS_CONFIG[status]
  const isMemoryFailure = status === 'failed' && hasMemoryFailure
  const [retryPending, setRetryPending] = useState(false)
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (retryTimer.current) clearTimeout(retryTimer.current)
    },
    []
  )
  const [setupStatus, setSetupStatus] = useState<
    import('../../../shared/types').WhisperSetupStatus | null
  >(null)

  useEffect(() => {
    if (status !== 'downloading') {
      return
    }

    window.electronAPI.invoke('whisper:get-setup-status').then(setSetupStatus)
    const unsub = window.electronAPI.on('whisper:setup-progress', setSetupStatus)
    return unsub
  }, [status])

  const showProgress = status === 'transcribing' && progress != null
  const activeSetupStatus = status === 'downloading' ? setupStatus : null
  const setupLabel = getWhisperSetupLabel(activeSetupStatus, t)
  const transcribingLabel =
    status === 'transcribing'
      ? formatTranscriptionStatusText(
          {
            status,
            progress
          } satisfies Pick<TranscriptionStatusPayload, 'status' | 'progress'>,
          t
        )
      : null

  const Tag = status === 'failed' && !isMemoryFailure && onRetry ? 'button' : 'span'
  return (
    <Tag
      {...(Tag === 'button' ? { type: 'button' as const, disabled: retryPending } : {})}
      className={`relative max-w-full text-[10px] font-medium leading-snug px-2 py-0.5 rounded-full overflow-hidden text-pretty [overflow-wrap:anywhere] ${config.className} ${isMemoryFailure ? 'cursor-default' : status === 'failed' ? 'cursor-pointer hover:bg-bg-card' : ''}`}
      onClick={
        Tag === 'button'
          ? () => {
              if (retryTimer.current) return
              setRetryPending(true)
              retryTimer.current = setTimeout(() => {
                retryTimer.current = null
                setRetryPending(false)
              }, 1500)
              onRetry?.()
            }
          : undefined
      }
    >
      {showProgress && (
        <span
          className="absolute inset-0 bg-sage/20 transition-[width] duration-500 ease-linear"
          style={{ width: `${progress}%` }}
        />
      )}
      <span className="relative">
        {isMemoryFailure
          ? t('ui.notEnoughMemory')
          : (transcribingLabel ??
            (showProgress
              ? t('ui.transcribingPercent', { percent: progress })
              : (setupLabel ?? t(config.label))))}
      </span>
    </Tag>
  )
}
