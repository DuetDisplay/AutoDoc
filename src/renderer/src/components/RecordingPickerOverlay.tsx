import { useEffect, useState } from 'react'
import type { RecordingSource } from '../../../shared/types'
import type { RecordingSelectionContext } from '../services/window-detection'
import { useRecordingPickerStore } from '../stores/recording-picker'

interface RecordingPickerOverlayProps {
  onStartRecording: (
    sourceId: string,
    sourceName: string,
    selectionContext?: RecordingSelectionContext,
  ) => Promise<unknown>
}

export function RecordingPickerOverlay({ onStartRecording }: RecordingPickerOverlayProps) {
  const {
    isOpen,
    title,
    subtitle,
    sources,
    detectedId,
    selectionContext,
    closePicker,
  } = useRecordingPickerStore()
  const [startingSourceId, setStartingSourceId] = useState<string | null>(null)

  useEffect(() => {
    if (!isOpen) {
      setStartingSourceId(null)
    }
  }, [isOpen])

  if (!isOpen) return null

  const handleSourceSelect = async (source: RecordingSource) => {
    if (startingSourceId) return

    setStartingSourceId(source.id)
    try {
      await onStartRecording(source.id, source.name, selectionContext ?? undefined)
      closePicker()
    } catch (err) {
      console.error('Failed to start recording from picker:', err)
      setStartingSourceId(null)
    }
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/35 px-6 py-10">
      <button
        aria-label="Close recording picker"
        className="absolute inset-0 cursor-default"
        onClick={closePicker}
      />
      <div className="relative z-10 w-full max-w-3xl overflow-hidden rounded-2xl border border-border bg-bg-card shadow-[0_28px_80px_rgba(0,0,0,0.22)]">
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div>
            <p className="text-[13px] font-semibold text-ink">{title}</p>
            {subtitle && (
              <p className="mt-1 text-[11px] leading-5 text-ink-faint">
                {subtitle}
              </p>
            )}
          </div>
          <button
            onClick={closePicker}
            title="Close"
            className="text-[18px] leading-none text-ink-faint transition-colors hover:text-ink"
          >
            ×
          </button>
        </div>

        <div className="grid max-h-[70vh] gap-3 overflow-y-auto p-5 sm:grid-cols-2">
          {sources.map((source) => {
            const isDetected = source.id === detectedId
            const isStarting = source.id === startingSourceId

            return (
              <button
                key={source.id}
                onClick={() => void handleSourceSelect(source)}
                disabled={startingSourceId !== null}
                className={`overflow-hidden rounded-xl border text-left transition-colors ${
                  isDetected
                    ? 'border-ink bg-bg-accent shadow-[0_0_0_1px_rgba(0,0,0,0.04)]'
                    : 'border-border hover:border-border-subtle hover:bg-bg-accent'
                } disabled:cursor-wait disabled:opacity-70`}
              >
                <img
                  src={source.thumbnailDataUrl}
                  alt={source.name}
                  className="h-40 w-full border-b border-border object-cover"
                />
                <div className="space-y-1 px-4 py-3">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-medium text-ink">
                      {source.name}
                    </span>
                    {isDetected && (
                      <span className="rounded-full bg-sage/12 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.04em] text-sage">
                        Suggested
                      </span>
                    )}
                  </div>
                  {isStarting && (
                    <p className="text-[11px] text-ink-faint">Starting recording…</p>
                  )}
                </div>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
