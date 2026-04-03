import { useMemo, useState } from 'react'
import type { RecordingSource } from '../../../shared/types'
import { useCalendarStore } from '../stores/calendar'
import { useRecordingPickerStore } from '../stores/recording-picker'
import {
  buildRecordingSelectionContext,
  chooseAutoRecordSource,
  findActiveCalendarEvent,
} from '../services/window-detection'
import { getSavedSourcePreference } from '../services/recording-source-preferences'

interface RecordingControlsProps {
  isRecording: boolean
  onStopRecording: () => void
  onFetchSources: () => Promise<RecordingSource[]>
}

export function RecordingControls({
  isRecording,
  onStopRecording,
  onFetchSources,
}: RecordingControlsProps) {
  const [loading, setLoading] = useState(false)
  const events = useCalendarStore((state) => state.events)
  const {
    openPicker,
  } = useRecordingPickerStore()
  const selectionContext = useMemo(
    () => buildRecordingSelectionContext(findActiveCalendarEvent(events)),
    [events],
  )

  const handleRecordClick = async () => {
    setLoading(true)
    try {
      const fetchedSources = await onFetchSources()
      const selection = chooseAutoRecordSource(
        fetchedSources,
        selectionContext,
        getSavedSourcePreference(selectionContext),
      )

      openPicker({
        title: 'Select a window to record',
        subtitle: selection.source && selection.confidence === 'high'
          ? 'AutoDoc highlighted the most likely meeting window.'
          : null,
        sources: fetchedSources,
        detectedId: selection.source?.id ?? null,
        selectionContext,
      })
    } finally {
      setLoading(false)
    }
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
    <div>
      <button
        onClick={handleRecordClick}
        disabled={loading}
        className="text-[11px] font-medium text-white bg-sage px-3 py-1.5 rounded-md hover:opacity-90 transition-opacity disabled:opacity-50"
      >
        {loading ? 'Loading...' : 'Record'}
      </button>
    </div>
  )
}
