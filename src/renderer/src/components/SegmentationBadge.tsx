import { useState, useEffect } from 'react'
import type { SegmentationStatus, OllamaSetupStatus } from '../../../shared/types'
import { getOllamaSetupLabel } from '../services/setup-status-labels'

const STATUS_CONFIG: Record<SegmentationStatus, { label: string; className: string }> = {
  pending: {
    label: 'Awaiting notes',
    className: 'text-ink-faint bg-bg-accent'
  },
  queued: {
    label: 'Queued for notes',
    className: 'text-ink-faint bg-bg-accent'
  },
  'downloading-model': {
    label: 'Setting up Ollama and notes model...',
    className: 'text-ink-muted bg-bg-accent animate-pulse'
  },
  segmenting: {
    label: 'Generating notes...',
    className: 'text-ink-muted bg-bg-accent'
  },
  'no-notes': {
    label: 'Transcript only',
    className: 'text-amber-800 bg-amber-50'
  },
  complete: {
    label: 'Notes ready',
    className: 'text-green-700 bg-green-50'
  },
  failed: {
    label: 'Notes failed — Retry',
    className: 'text-red-700 bg-red-50 cursor-pointer hover:bg-red-100'
  }
}

interface SegmentationBadgeProps {
  status: SegmentationStatus
  progress?: number
  errorCode?: string
  onRetry?: () => void
}

export function SegmentationBadge({ status, progress, errorCode, onRetry }: SegmentationBadgeProps) {
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

  const isInsufficientMemory = status === 'failed' && errorCode === 'ollama-insufficient-memory'
  let label = isInsufficientMemory ? 'Not enough memory' : config.label
  if (status === 'segmenting' && progress == null) {
    label = 'Preparing notes...'
  } else if (status === 'segmenting' && progress != null) {
    label = `Generating notes... ${progress}%`
  }
  if (status === 'downloading-model' && ollamaProgress) {
    label = getOllamaSetupLabel(ollamaProgress) ?? label
  }

  const showProgress = status === 'segmenting' && progress != null
  const canRetry = status === 'failed' && !isInsufficientMemory

  return (
    <span
      className={`relative text-[10px] font-medium px-2 py-0.5 rounded-full overflow-hidden ${config.className} ${status === 'segmenting' && !showProgress ? 'animate-pulse' : ''} ${isInsufficientMemory ? 'cursor-default hover:bg-red-50' : ''}`}
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
