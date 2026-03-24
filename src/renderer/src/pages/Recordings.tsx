import { useState, useEffect } from 'react'
import { PageHeader } from '../components/PageHeader'
import type { RecordingEntry } from '../../../shared/types'

export function Recordings() {
  const [recordings, setRecordings] = useState<RecordingEntry[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    window.electronAPI.invoke('recording:list').then((entries) => {
      setRecordings(entries)
    }).catch((err) => {
      console.error('Failed to list recordings:', err)
    }).finally(() => {
      setLoading(false)
    })
  }, [])

  return (
    <div className="flex flex-col h-full">
      <PageHeader title="Recordings" />

      {loading ? (
        <div className="flex-1 flex items-center justify-center p-6">
          <p className="text-ink-muted text-[13px]">Loading...</p>
        </div>
      ) : recordings.length === 0 ? (
        <div className="flex-1 flex items-center justify-center p-6">
          <p className="text-ink-muted text-[13px]">
            No recordings yet. Start a meeting to begin.
          </p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-6">
          <div className="flex flex-col gap-2">
            {recordings.map((rec) => (
              <div
                key={rec.meetingId}
                className="px-4 py-3.5 bg-bg-card border border-border rounded-xl"
              >
                <div className="flex justify-between items-center">
                  <div>
                    <div className="text-[13.5px] font-semibold text-ink tracking-[-0.01em]">
                      {rec.title}
                    </div>
                    <div className="text-[11.5px] text-ink-faint mt-0.5 flex items-center gap-2">
                      <span>
                        {new Date(rec.date).toLocaleDateString('en-US', {
                          weekday: 'short',
                          month: 'short',
                          day: 'numeric',
                        })}
                      </span>
                      <span className="text-border">|</span>
                      <span className="flex items-center gap-1">
                        {rec.hasAudio && <span>Audio</span>}
                        {rec.hasAudio && rec.hasVideo && <span>+</span>}
                        {rec.hasVideo && <span>Video</span>}
                      </span>
                    </div>
                  </div>
                  <span className="text-[10px] font-medium text-ink-faint bg-bg-accent px-2 py-0.5 rounded-full">
                    Awaiting transcription
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
