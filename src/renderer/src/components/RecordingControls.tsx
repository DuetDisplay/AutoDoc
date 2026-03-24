import { useState } from 'react'
import type { RecordingSource } from '../../../shared/types'
import { detectMeetingWindow } from '../services/window-detection'

interface RecordingControlsProps {
  isRecording: boolean
  onStartRecording: (sourceId: string, sourceName: string) => void
  onStopRecording: () => void
  onFetchSources: () => Promise<RecordingSource[]>
}

export function RecordingControls({
  isRecording,
  onStartRecording,
  onStopRecording,
  onFetchSources,
}: RecordingControlsProps) {
  const [showPicker, setShowPicker] = useState(false)
  const [sources, setSources] = useState<RecordingSource[]>([])
  const [detectedId, setDetectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const handleRecordClick = async () => {
    setLoading(true)
    try {
      const fetchedSources = await onFetchSources()
      setSources(fetchedSources)

      // Auto-detect meeting window
      const detected = detectMeetingWindow(fetchedSources)
      setDetectedId(detected?.id ?? null)

      setShowPicker(true)
    } finally {
      setLoading(false)
    }
  }

  const handleSourceSelect = (source: RecordingSource) => {
    setShowPicker(false)
    onStartRecording(source.id, source.name)
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
        className="text-[11px] font-medium text-white bg-ink px-3 py-1.5 rounded-md hover:opacity-90 transition-opacity disabled:opacity-50"
      >
        {loading ? 'Loading...' : 'Record'}
      </button>

      {showPicker && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setShowPicker(false)}
          />
          <div className="absolute right-0 top-full mt-2 z-50 w-80 bg-bg-card border border-border rounded-xl shadow-lg p-3 max-h-96 overflow-y-auto">
            <p className="text-[11px] font-medium text-ink-muted mb-2">
              Select a window to record
            </p>
            <div className="flex flex-col gap-1.5">
              {sources.map((source) => (
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
                    <span className="text-[12px] text-ink truncate">
                      {source.name}
                    </span>
                    {source.id === detectedId && (
                      <span className="text-[10px] text-status-connected font-medium">
                        Detected meeting
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
