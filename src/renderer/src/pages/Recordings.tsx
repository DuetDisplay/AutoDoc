import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { PageHeader } from '../components/PageHeader'
import { TranscriptionBadge } from '../components/TranscriptionBadge'
import { SegmentationBadge } from '../components/SegmentationBadge'
import type { RecordingEntry, SegmentationStatus, TranscriptionStatus } from '../../../shared/types'

const ACTIVE_TRANSCRIPTION_STATUSES: TranscriptionStatus[] = [
  'queued',
  'downloading',
  'transcribing',
  'diarizing'
]
const ACTIVE_SEGMENTATION_STATUSES: SegmentationStatus[] = [
  'queued',
  'downloading-model',
  'segmenting'
]

function formatDuration(seconds: number): string {
  const mins = Math.ceil(seconds / 60)
  if (mins >= 60) {
    const h = Math.floor(mins / 60)
    const m = mins % 60
    return m > 0 ? `${h}h ${m}m` : `${h}h`
  }
  return `${mins}m`
}

function mergeRecordIfChanged<T>(
  prev: Record<string, T>,
  updates: Record<string, T>
): Record<string, T> {
  const changed = Object.entries(updates).some(([key, value]) => prev[key] !== value)
  if (!changed) return prev
  return { ...prev, ...updates }
}

function mergeTranscriptionProgress(
  prev: Record<string, number | undefined>,
  updates: Record<string, { status: TranscriptionStatus; progress?: number }>
): Record<string, number | undefined> {
  let changed = false
  const next = { ...prev }

  for (const [key, update] of Object.entries(updates)) {
    if (update.status !== 'transcribing') {
      if (prev[key] !== undefined) {
        next[key] = undefined
        changed = true
      }
      continue
    }

    if (update.progress == null) continue

    const existing = prev[key]
    const merged = existing == null ? update.progress : Math.max(existing, update.progress)
    if (existing !== merged) {
      next[key] = merged
      changed = true
    }
  }

  return changed ? next : prev
}

function areRecordingsEqual(prev: RecordingEntry[], next: RecordingEntry[]): boolean {
  if (prev.length !== next.length) return false
  return prev.every((recording, index) => {
    const other = next[index]
    return (
      recording.meetingId === other.meetingId &&
      recording.title === other.title &&
      recording.date === other.date &&
      recording.duration === other.duration &&
      recording.hasVideo === other.hasVideo &&
      recording.hasAudio === other.hasAudio &&
      recording.isFinalizing === other.isFinalizing &&
      recording.transcriptionStatus === other.transcriptionStatus
    )
  })
}

export function Recordings() {
  const [recordings, setRecordings] = useState<RecordingEntry[]>([])
  const [segmentationStatuses, setSegmentationStatuses] = useState<
    Record<string, SegmentationStatus>
  >({})
  const [segmentationProgress, setSegmentationProgress] = useState<
    Record<string, number | undefined>
  >({})
  const [segmentationErrorCodes, setSegmentationErrorCodes] = useState<
    Record<string, string | undefined>
  >({})
  const [transcriptionProgress, setTranscriptionProgress] = useState<
    Record<string, number | undefined>
  >({})
  const [transcriptionStatusDetails, setTranscriptionStatusDetails] = useState<
    Record<
      string,
      {
        backendLabel?: string
        qualityMode?: 'fast' | 'balanced'
      }
    >
  >({})
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()
  const knownMeetingIdsRef = useRef<Set<string>>(new Set())

  const refreshRecordings = useCallback(async () => {
    const refreshStartedAt = performance.now()
    const entries = await window.electronAPI.invoke('recording:list')
    console.info('[recordings-page] refreshRecordings resolved', {
      at: new Date().toISOString(),
      elapsedMs: Math.round(performance.now() - refreshStartedAt),
      entryCount: entries.length,
      finalizingMeetingIds: entries
        .filter((entry) => entry.isFinalizing)
        .map((entry) => entry.meetingId)
    })

    setRecordings((prev) => (areRecordingsEqual(prev, entries) ? prev : entries))
    knownMeetingIdsRef.current = new Set(entries.map((entry) => entry.meetingId))

    if (entries.length === 0) return

    const updates = await Promise.all(
      entries.map(async (entry) => ({
        meetingId: entry.meetingId,
        transcriptionProgress: await window.electronAPI.invoke(
          'transcription:get-progress',
          entry.meetingId
        ),
        segmentationStatus: await window.electronAPI.invoke(
          'segmentation:get-status',
          entry.meetingId
        ),
        segmentationProgress: await window.electronAPI.invoke(
          'segmentation:get-progress',
          entry.meetingId
        ),
        segmentationErrorCode: await window.electronAPI.invoke(
          'segmentation:get-error-code',
          entry.meetingId
        )
      }))
    )

    const transcriptionProgressByMeetingId = Object.fromEntries(
      updates.map((update) => [
        update.meetingId,
        {
          status:
            entries.find((entry) => entry.meetingId === update.meetingId)?.transcriptionStatus ??
            'pending',
          progress: update.transcriptionProgress
        }
      ])
    )
    const segmentationStatusesByMeetingId = Object.fromEntries(
      updates.map((update) => [update.meetingId, update.segmentationStatus])
    )
    const segmentationProgressByMeetingId = Object.fromEntries(
      updates.map((update) => [update.meetingId, update.segmentationProgress])
    )
    const segmentationErrorCodesByMeetingId = Object.fromEntries(
      updates.map((update) => [
        update.meetingId,
        update.segmentationStatus === 'failed' ? update.segmentationErrorCode : undefined
      ])
    )

    setTranscriptionProgress((prev) =>
      mergeTranscriptionProgress(prev, transcriptionProgressByMeetingId)
    )
    setSegmentationStatuses((prev) => mergeRecordIfChanged(prev, segmentationStatusesByMeetingId))
    setSegmentationProgress((prev) => mergeRecordIfChanged(prev, segmentationProgressByMeetingId))
    setSegmentationErrorCodes((prev) =>
      mergeRecordIfChanged(prev, segmentationErrorCodesByMeetingId)
    )
  }, [])

  useEffect(() => {
    refreshRecordings()
      .catch((err) => {
        console.error('Failed to list recordings:', err)
      })
      .finally(() => {
        setLoading(false)
      })
  }, [refreshRecordings])

  useEffect(() => {
    const refreshIfUnknownMeeting = (meetingId: string) => {
      if (!knownMeetingIdsRef.current.has(meetingId)) {
        void refreshRecordings().catch((err) => {
          console.error('Failed to refresh recordings after new processing event:', err)
        })
      }
    }

    const unsubRecording = window.electronAPI.on('recording:status-changed', () => {
      void refreshRecordings().catch((err) => {
        console.error('Failed to refresh recordings after recording status change:', err)
      })
    })
    const unsubRecordingEntryUpdated = window.electronAPI.on('recording:entry-updated', () => {
      void refreshRecordings().catch((err) => {
        console.error('Failed to refresh recordings after recording entry update:', err)
      })
    })

    const unsubTranscription = window.electronAPI.on('transcription:status-changed', (payload) => {
      setRecordings((prev) =>
        prev.map((rec) =>
          rec.meetingId === payload.meetingId
            ? { ...rec, transcriptionStatus: payload.status }
            : rec
        )
      )
      setTranscriptionProgress((prev) =>
        mergeTranscriptionProgress(prev, {
          [payload.meetingId]: { status: payload.status, progress: payload.progress }
        })
      )
      setTranscriptionStatusDetails((prev) => ({
        ...prev,
        [payload.meetingId]: {
          backendLabel: payload.backendLabel,
          qualityMode: payload.qualityMode
        }
      }))
      refreshIfUnknownMeeting(payload.meetingId)
    })
    const unsubSegmentation = window.electronAPI.on('segmentation:status-changed', (payload) => {
      setSegmentationStatuses((prev) => ({
        ...prev,
        [payload.meetingId]: payload.status
      }))
      setSegmentationProgress((prev) => ({
        ...prev,
        [payload.meetingId]: payload.progress
      }))
      setSegmentationErrorCodes((prev) => ({
        ...prev,
        [payload.meetingId]: payload.status === 'failed' ? payload.errorCode : undefined
      }))
      refreshIfUnknownMeeting(payload.meetingId)
    })

    const interval = setInterval(() => {
      void refreshRecordings().catch((err) => {
        console.error('Failed to refresh recordings list:', err)
      })
    }, 2000)

    return () => {
      unsubRecording()
      unsubRecordingEntryUpdated()
      unsubTranscription()
      unsubSegmentation()
      clearInterval(interval)
    }
  }, [refreshRecordings])

  useEffect(() => {
    const activeMeetingIds = recordings
      .filter((rec) => {
        const segmentationStatus = segmentationStatuses[rec.meetingId]
        return (
          ACTIVE_TRANSCRIPTION_STATUSES.includes(rec.transcriptionStatus) ||
          (segmentationStatus != null && ACTIVE_SEGMENTATION_STATUSES.includes(segmentationStatus))
        )
      })
      .map((rec) => rec.meetingId)

    if (activeMeetingIds.length === 0) return

    let cancelled = false

    const refreshProcessingState = async () => {
      try {
        const updates = await Promise.all(
          activeMeetingIds.map(async (meetingId) => ({
            meetingId,
            transcriptionStatus: await window.electronAPI.invoke(
              'transcription:get-status',
              meetingId
            ),
            transcriptionProgress: await window.electronAPI.invoke(
              'transcription:get-progress',
              meetingId
            ),
            segmentationStatus: await window.electronAPI.invoke(
              'segmentation:get-status',
              meetingId
            ),
            segmentationProgress: await window.electronAPI.invoke(
              'segmentation:get-progress',
              meetingId
            ),
            segmentationErrorCode: await window.electronAPI.invoke(
              'segmentation:get-error-code',
              meetingId
            )
          }))
        )

        if (cancelled) return

        const updatesByMeetingId = new Map(updates.map((update) => [update.meetingId, update]))

        setRecordings((prev) => {
          let changed = false
          const next = prev.map((rec) => {
            const update = updatesByMeetingId.get(rec.meetingId)
            if (!update || rec.transcriptionStatus === update.transcriptionStatus) {
              return rec
            }
            changed = true
            return {
              ...rec,
              transcriptionStatus: update.transcriptionStatus
            }
          })
          return changed ? next : prev
        })

        const transcriptionProgressByMeetingId = Object.fromEntries(
          updates.map((update) => [
            update.meetingId,
            { status: update.transcriptionStatus, progress: update.transcriptionProgress }
          ])
        )
        const segmentationStatusesByMeetingId = Object.fromEntries(
          updates.map((update) => [update.meetingId, update.segmentationStatus])
        )
        const segmentationProgressByMeetingId = Object.fromEntries(
          updates.map((update) => [update.meetingId, update.segmentationProgress])
        )
        const segmentationErrorCodesByMeetingId = Object.fromEntries(
          updates.map((update) => [
            update.meetingId,
            update.segmentationStatus === 'failed' ? update.segmentationErrorCode : undefined
          ])
        )

        setTranscriptionProgress((prev) =>
          mergeTranscriptionProgress(prev, transcriptionProgressByMeetingId)
        )

        setSegmentationStatuses((prev) =>
          mergeRecordIfChanged(prev, segmentationStatusesByMeetingId)
        )

        setSegmentationProgress((prev) =>
          mergeRecordIfChanged(prev, segmentationProgressByMeetingId)
        )

        setSegmentationErrorCodes((prev) =>
          mergeRecordIfChanged(prev, segmentationErrorCodesByMeetingId)
        )
      } catch (err) {
        console.error('Failed to refresh recording processing state:', err)
      }
    }

    void refreshProcessingState()
    const interval = setInterval(() => {
      void refreshProcessingState()
    }, 5000)

    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [recordings, segmentationStatuses])

  const handleRetryTranscription = (meetingId: string) => {
    window.electronAPI.invoke('transcription:retry', meetingId)
  }

  const handleRetrySegmentation = (meetingId: string) => {
    setSegmentationErrorCodes((prev) => ({ ...prev, [meetingId]: undefined }))
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
          <p className="text-ink-muted text-[13px]">No notes yet. Start a meeting to begin.</p>
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
                          day: 'numeric'
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
                    {rec.isFinalizing ? (
                      <span className="text-[11px] text-ink-faint">Wrapping up recording...</span>
                    ) : (
                      <>
                        <TranscriptionBadge
                          status={rec.transcriptionStatus}
                          progress={transcriptionProgress[rec.meetingId]}
                          backendLabel={transcriptionStatusDetails[rec.meetingId]?.backendLabel}
                          qualityMode={transcriptionStatusDetails[rec.meetingId]?.qualityMode}
                          onRetry={() => handleRetryTranscription(rec.meetingId)}
                        />
                        {segmentationStatuses[rec.meetingId] && (
                          <SegmentationBadge
                            status={segmentationStatuses[rec.meetingId]}
                            progress={segmentationProgress[rec.meetingId]}
                            errorCode={segmentationErrorCodes[rec.meetingId]}
                            onRetry={() => handleRetrySegmentation(rec.meetingId)}
                          />
                        )}
                      </>
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
