import { useState, useEffect } from 'react'
import type { SegmentationStatus, OllamaSetupStatus } from '../../../shared/types'

const STATUS_CONFIG: Record<SegmentationStatus, { label: string; className: string }> = {
  pending: {
    label: 'Awaiting notes',
    className: 'text-ink-faint bg-bg-accent',
  },
  queued: {
    label: 'Queued for notes',
    className: 'text-ink-faint bg-bg-accent',
  },
  'downloading-model': {
    label: 'Downloading AI model...',
    className: 'text-ink-muted bg-bg-accent animate-pulse',
  },
  segmenting: {
    label: 'Generating notes...',
    className: 'text-ink-muted bg-bg-accent',
  },
  complete: {
    label: 'Notes ready',
    className: 'text-green-700 bg-green-50',
  },
  failed: {
    label: 'Notes failed — Retry',
    className: 'text-red-700 bg-red-50 cursor-pointer hover:bg-red-100',
  },
}

interface SegmentationBadgeProps {
  status: SegmentationStatus
  progress?: number
  onRetry?: () => void
}

export function SegmentationBadge({ status, progress, onRetry }: SegmentationBadgeProps) {
  const config = STATUS_CONFIG[status]
  const [ollamaProgress, setOllamaProgress] = useState<OllamaSetupStatus | null>(null)

  useEffect(() => {
    if (status !== 'downloading-model') {
      setOllamaProgress(null)
      return
    }
    window.electronAPI.invoke('ollama:get-setup-status').then(setOllamaProgress)
    const unsub = window.electronAPI.on('ollama:setup-progress', setOllamaProgress)
    return unsub
  }, [status])

  let label = config.label
  if (status === 'segmenting' && progress != null) {
    label = `Generating notes... ${progress}%`
  }
  if (status === 'downloading-model' && ollamaProgress) {
    const pct = ollamaProgress.percent ?? 0
    if (ollamaProgress.phase === 'downloading') {
      label = `Downloading Ollama... ${pct}%`
    } else if (ollamaProgress.phase === 'pulling') {
      label = `Downloading AI model... ${pct}%`
    }
  }

  const showProgress = status === 'segmenting' && progress != null

  return (
    <span
      className={`relative text-[10px] font-medium px-2 py-0.5 rounded-full overflow-hidden ${config.className} ${status === 'segmenting' && !showProgress ? 'animate-pulse' : ''}`}
      onClick={status === 'failed' ? onRetry : undefined}
    >
      {showProgress && (
        <span
          className="absolute inset-0 bg-sage/20 transition-[width] duration-500 ease-linear"
          style={{ width: `${progress}%` }}
        />
      )}
      <span className="relative">
        {label}
      </span>
    </span>
  )
}
