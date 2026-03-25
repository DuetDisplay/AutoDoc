import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { PageHeader } from '../components/PageHeader'
import { TranscriptionBadge } from '../components/TranscriptionBadge'
import { SegmentationBadge } from '../components/SegmentationBadge'
import type { RecordingEntry, SegmentationStatus } from '../../../shared/types'

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

export function Recordings() {
  const [recordings, setRecordings] = useState<RecordingEntry[]>([])
  const [segmentationStatuses, setSegmentationStatuses] = useState<Record<string, SegmentationStatus>>({})
  const [transcriptionProgress, setTranscriptionProgress] = useState<Record<string, number | undefined>>({})
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()

  useEffect(() => {
    window.electronAPI
      .invoke('recording:list')
      .then(async (entries) => {
        setRecordings(entries)
        const statuses: Record<string, SegmentationStatus> = {}
        await Promise.all(
          entries.map(async (entry) => {
            statuses[entry.meetingId] = await window.electronAPI.invoke(
              'segmentation:get-status',
              entry.meetingId,
            )
          }),
        )
        setSegmentationStatuses(statuses)
      })
      .catch((err) => {
        console.error('Failed to list recordings:', err)
      })
      .finally(() => {
        setLoading(false)
      })
  }, [])

  useEffect(() => {
    const unsubTranscription = window.electronAPI.on(
      'transcription:status-changed',
      (payload) => {
        setRecordings((prev) =>
          prev.map((rec) =>
            rec.meetingId === payload.meetingId
              ? { ...rec, transcriptionStatus: payload.status }
              : rec
          )
        )
        setTranscriptionProgress((prev) => ({
          ...prev,
          [payload.meetingId]: payload.progress,
        }))
      }
    )
    const unsubSegmentation = window.electronAPI.on(
      'segmentation:status-changed',
      (payload) => {
        setSegmentationStatuses((prev) => ({
          ...prev,
          [payload.meetingId]: payload.status,
        }))
      }
    )
    return () => {
      unsubTranscription()
      unsubSegmentation()
    }
  }, [])

  const handleRetryTranscription = (meetingId: string) => {
    window.electronAPI.invoke('transcription:retry', meetingId)
  }

  const handleRetrySegmentation = (meetingId: string) => {
    window.electronAPI.invoke('segmentation:retry', meetingId)
  }

  return (
    <div className="flex flex-col h-full">
      <PageHeader title="AI Notes" />

      {loading ? (
        <div className="flex-1 flex items-center justify-center p-6">
          <p className="text-ink-muted text-[13px]">Loading...</p>
        </div>
      ) : recordings.length === 0 ? (
        <div className="flex-1 flex items-center justify-center p-6">
          <p className="text-ink-muted text-[13px]">
            No notes yet. Start a meeting to begin.
          </p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-6">
          <div className="flex flex-col gap-2">
            {recordings.map((rec) => (
              <div
                key={rec.meetingId}
                className="px-4 py-3.5 bg-bg-card border border-border rounded-xl cursor-pointer hover:border-ink-muted transition-colors"
                onClick={() => navigate(`/recordings/${rec.meetingId}`)}
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
                      {rec.duration != null && (
                        <>
                          <span>{formatDuration(rec.duration)}</span>
                          <span className="text-border">|</span>
                        </>
                      )}
                      <span className="flex items-center gap-1">
                        {rec.hasAudio && <span>Audio</span>}
                        {rec.hasAudio && rec.hasVideo && <span>+</span>}
                        {rec.hasVideo && <span>Video</span>}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <TranscriptionBadge
                      status={rec.transcriptionStatus}
                      progress={transcriptionProgress[rec.meetingId]}
                      onRetry={() => handleRetryTranscription(rec.meetingId)}
                    />
                    {segmentationStatuses[rec.meetingId] && (
                      <SegmentationBadge
                        status={segmentationStatuses[rec.meetingId]}
                        onRetry={() => handleRetrySegmentation(rec.meetingId)}
                      />
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
