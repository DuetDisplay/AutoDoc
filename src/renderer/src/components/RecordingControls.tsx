import { useMemo, useState } from 'react'
import type { RecordingSource, RecordingTrackingContext } from '../../../shared/types'
import { useCalendarStore } from '../stores/calendar'
import { useRecordingPickerStore } from '../stores/recording-picker'
import { useToastStore } from '../stores/toast'
import {
  buildRecordingSelectionContext,
  buildRecordingTrackingContext,
  chooseAutoRecordSource,
  findActiveCalendarEvent
} from '../services/window-detection'
import { getSavedSourcePreference } from '../services/recording-source-preferences'

const SCREEN_RECORDING_PERMISSION_MESSAGE =
  'AutoDoc needs Screen Recording access. If you just enabled it, fully quit and reopen AutoDoc, then press Record again.'

interface RecordingControlsProps {
  isRecording: boolean
  onStartRecording: (
    sourceId: string,
    sourceName: string,
    selectionContext?: ReturnType<typeof buildRecordingSelectionContext>,
    trackingContext?: RecordingTrackingContext | null
  ) => Promise<unknown>
  onStopRecording: () => void
  onFetchSources: () => Promise<RecordingSource[]>
}

export function RecordingControls({
  isRecording,
  onStartRecording,
  onStopRecording,
  onFetchSources
}: RecordingControlsProps) {
  const [loading, setLoading] = useState(false)
  const events = useCalendarStore((state) => state.events)
  const {
    isOpen: showPicker,
    title,
    subtitle,
    sources,
    detectedId,
    suggestionLabel,
    openPicker,
    closePicker
  } = useRecordingPickerStore()
  const orderedSources = useMemo(() => {
    if (!detectedId) return sources

    const detectedSource = sources.find((source) => source.id === detectedId)
    if (!detectedSource) return sources

    return [detectedSource, ...sources.filter((source) => source.id !== detectedId)]
  }, [detectedId, sources])
  const selectionContext = useMemo(
    () => buildRecordingSelectionContext(findActiveCalendarEvent(events)),
    [events]
  )

  const handleRecordClick = async () => {
    setLoading(true)
    try {
      const fetchedSources = await onFetchSources()
      if (fetchedSources.length === 0) {
        throw new Error('No capture sources were available. Screen recording permission may be missing.')
      }
      const selection = chooseAutoRecordSource(
        fetchedSources,
        selectionContext,
        getSavedSourcePreference(selectionContext)
      )

      openPicker({
        title: 'Select a window to record',
        subtitle:
          selection.source && selection.confidence === 'high'
            ? 'AutoDoc highlighted the most likely meeting window.'
            : null,
        sources: fetchedSources,
        detectedId: selection.source?.id ?? null,
        suggestionLabel: selection.source
          ? selection.confidence === 'high'
            ? 'Detected meeting'
            : 'Suggested window'
          : null
      })
    } catch (err) {
      console.warn('Failed to list recording sources:', err)
      useToastStore.getState().showToast({
        type: 'screen',
        message: SCREEN_RECORDING_PERMISSION_MESSAGE,
        action: {
          label: 'Open Settings',
          type: 'open-settings',
          target: 'screen'
        }
      })
    } finally {
      setLoading(false)
    }
  }

  const handleSourceSelect = (source: RecordingSource) => {
    closePicker()
    const detectedSource = detectedId
      ? (sources.find((candidate) => candidate.id === detectedId) ?? null)
      : null
    void onStartRecording(
      source.id,
      source.name,
      selectionContext,
      buildRecordingTrackingContext(source, detectedSource, selectionContext)
    )
  }

  if (isRecording) {
    return (
      <button
        onClick={onStopRecording}
        className="text-[11px] font-medium text-white bg-status-recording px-3 py-1.5 rounded-md hover:opacity-90 transition-opacity"
      >
        Stop Recording
      </button>
    )
  }

  return (
    <div className="relative">
      <button
        onClick={handleRecordClick}
        disabled={loading}
        className="text-[11px] font-medium text-white bg-sage px-3 py-1.5 rounded-md hover:opacity-90 transition-opacity disabled:opacity-50"
      >
        {loading ? 'Loading...' : 'Record'}
      </button>

      {showPicker && (
        <>
          <div className="fixed inset-0 z-40" onClick={closePicker} />
          <div className="absolute right-0 top-full mt-2 z-50 w-80 bg-bg-card border border-border rounded-xl shadow-lg p-3 max-h-96 overflow-y-auto">
            <p className="text-[11px] font-medium text-ink-muted mb-1">{title}</p>
            {subtitle && <p className="text-[10px] text-ink-faint mb-2">{subtitle}</p>}
            <div className="flex flex-col gap-1.5">
              {orderedSources.map((source) => (
                <button
                  key={source.id}
                  onClick={() => handleSourceSelect(source)}
                  className={`flex items-center gap-3 p-2 rounded-lg hover:bg-bg-accent transition-colors text-left ${
                    source.id === detectedId ? 'ring-2 ring-ink bg-bg-accent' : ''
                  }`}
                >
                  <img
                    src={source.thumbnailDataUrl}
                    alt={source.name}
                    className="w-20 h-12 object-cover rounded border border-border-subtle"
                  />
                  <div className="flex flex-col flex-1 min-w-0">
                    <span className="text-[12px] text-ink truncate">{source.name}</span>
                    {source.id === detectedId && suggestionLabel && (
                      <span className="text-[10px] text-status-connected font-medium">
                        {suggestionLabel}
                      </span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
