import { useT } from '../services/i18n'
import type { MessageKey } from '../../../shared/i18n'
import { useState, useEffect } from 'react'
import { NOTES_WRITER_PROGRESS_END } from '../../../shared/constants'
import type { SegmentationStatus, OllamaSetupStatus } from '../../../shared/types'
import { getOllamaSetupLabel } from '../services/setup-status-labels'

const STATUS_CONFIG: Record<SegmentationStatus, { label: MessageKey; className: string }> = {
  pending: {
    label: 'ui.awaitingNotes',
    className: 'text-ink-faint bg-bg-accent'
  },
  queued: {
    label: 'ui.queuedForNotes',
    className: 'text-ink-faint bg-bg-accent'
  },
  'downloading-model': {
    label: 'ui.settingUpOllamaAndNotesModel',
    className: 'text-ink-muted bg-bg-accent'
  },
  segmenting: {
    label: 'meeting.generatingNotes',
    className: 'text-ink-secondary bg-bg-accent'
  },
  'no-notes': {
    label: 'ui.noNotesGenerated',
    className: 'text-clay-dark bg-clay-light'
  },
  complete: {
    label: 'ui.notesReady',
    className: 'text-sage-dark bg-sage-light'
  },
  failed: {
    label: 'ui.notesFailedRetry',
    className: 'text-clay-dark bg-clay-light'
  }
}

interface SegmentationBadgeProps {
  status: SegmentationStatus
  progress?: number
  errorCode?: string
  hasMemoryFailure?: boolean
  onRetry?: () => void
}

export function SegmentationBadge({
  status,
  progress,
  errorCode,
  hasMemoryFailure,
  onRetry
}: SegmentationBadgeProps) {
  const t = useT()
  const config = STATUS_CONFIG[status]
  const [ollamaProgress, setOllamaProgress] = useState<OllamaSetupStatus | null>(null)

  useEffect(() => {
    if (status !== 'downloading-model') {
      return
    }
    window.electronAPI.invoke('ollama:get-setup-status').then(setOllamaProgress)
    const unsub = window.electronAPI.on('ollama:setup-progress', setOllamaProgress)
    return unsub
  }, [status])

  const activeOllamaProgress = status === 'downloading-model' ? ollamaProgress : null
  const isInsufficientMemory =
    status === 'failed' && (hasMemoryFailure ?? errorCode === 'ollama-insufficient-memory')
  let label = isInsufficientMemory ? t('ui.notEnoughMemory') : t(config.label)
  if (status === 'failed' && errorCode === 'llm-empty-output') label = t('ui.noNotesFoundRetry')
  if (status === 'segmenting' && progress == null) {
    label = t('meeting.preparingNotes')
  } else if (status === 'segmenting' && progress != null) {
    label =
      progress >= NOTES_WRITER_PROGRESS_END
        ? t('ui.shapingNotesPercent', { percent: progress })
        : t('ui.generatingNotesPercent', { percent: progress })
  }
  if (activeOllamaProgress) {
    label = getOllamaSetupLabel(activeOllamaProgress, t) ?? label
  }

  const showProgress = status === 'segmenting' && progress != null
  const canRetry = status === 'failed' && !isInsufficientMemory

  return (
    <span
      className={`relative max-w-full text-[10px] font-medium leading-snug px-2 py-0.5 rounded-full overflow-hidden text-pretty [overflow-wrap:anywhere] ${config.className} ${isInsufficientMemory ? 'cursor-default' : canRetry ? 'cursor-pointer hover:bg-bg-card' : ''}`}
      onClick={canRetry ? onRetry : undefined}
    >
      {showProgress && (
        <span
          className="absolute inset-0 bg-sage/20 transition-[width] duration-500 ease-linear"
          style={{ width: `${progress}%` }}
        />
      )}
      <span className="relative">{label}</span>
    </span>
  )
}
