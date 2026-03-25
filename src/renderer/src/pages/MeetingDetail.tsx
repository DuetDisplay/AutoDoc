import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { SEGMENT_LABELS } from '../../../shared/constants'
import type { SegmentCategory, Segment, MeetingSegments, Transcript, TranscriptionStatus, SegmentationStatus } from '../../../shared/types'
import { TranscriptView } from '../components/TranscriptView'
import { TranscriptionBadge } from '../components/TranscriptionBadge'
import { SegmentationBadge } from '../components/SegmentationBadge'

type Tab = 'notes' | 'transcript'

const CATEGORY_ORDER: SegmentCategory[] = [
  'decision',
  'action_item',
  'information',
  'discussion',
  'status_update',
]

const CATEGORY_TO_KEY: Record<SegmentCategory, keyof MeetingSegments> = {
  decision: 'decisions',
  action_item: 'actionItems',
  information: 'information',
  discussion: 'discussion',
  status_update: 'statusUpdates',
}

export function MeetingDetail() {
  const { id } = useParams<{ id: string }>()
  const [activeTab, setActiveTab] = useState<Tab>('notes')
  const [transcript, setTranscript] = useState<Transcript[]>([])
  const [transcriptionStatus, setTranscriptionStatus] = useState<TranscriptionStatus>('pending')
  const [segments, setSegments] = useState<MeetingSegments | null>(null)
  const [segmentationStatus, setSegmentationStatus] = useState<SegmentationStatus>('pending')
  const [media, setMedia] = useState<{ hasVideo: boolean; hasAudio: boolean } | null>(null)

  useEffect(() => {
    if (!id) return

    window.electronAPI.invoke('transcription:get-status', id).then(setTranscriptionStatus)
    window.electronAPI.invoke('transcription:get-transcript', id).then(setTranscript)
    window.electronAPI.invoke('segmentation:get-status', id).then(setSegmentationStatus)
    window.electronAPI.invoke('segmentation:get-segments', id).then(setSegments)
    window.electronAPI.invoke('recording:get-media', id).then(setMedia)

    const unsubTranscription = window.electronAPI.on(
      'transcription:status-changed',
      (payload) => {
        if (payload.meetingId === id) {
          setTranscriptionStatus(payload.status)
          if (payload.status === 'complete') {
            window.electronAPI.invoke('transcription:get-transcript', id).then(setTranscript)
          }
        }
      }
    )

    const unsubSegmentation = window.electronAPI.on(
      'segmentation:status-changed',
      (payload) => {
        if (payload.meetingId === id) {
          setSegmentationStatus(payload.status)
          if (payload.status === 'complete') {
            window.electronAPI.invoke('segmentation:get-segments', id).then(setSegments)
          }
        }
      }
    )

    return () => {
      unsubTranscription()
      unsubSegmentation()
    }
  }, [id])

  const handleRetryTranscription = () => {
    if (id) window.electronAPI.invoke('transcription:retry', id)
  }

  const handleRetrySegmentation = () => {
    if (id) window.electronAPI.invoke('segmentation:retry', id)
  }

  const getSegmentsForCategory = (category: SegmentCategory): Segment[] => {
    if (!segments) return []
    return segments[CATEGORY_TO_KEY[category]] ?? []
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-4 border-b border-border flex items-center justify-between">
        <div>
          <h1 className="text-[16px] font-bold text-ink tracking-[-0.02em]">
            Meeting
          </h1>
          <p className="text-[11px] text-ink-faint mt-0.5">ID: {id}</p>
        </div>
        <div className="flex items-center gap-2">
          <TranscriptionBadge status={transcriptionStatus} onRetry={handleRetryTranscription} />
          <SegmentationBadge status={segmentationStatus} onRetry={handleRetrySegmentation} />
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border px-6">
        {(['notes', 'transcript'] as Tab[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-3.5 py-2.5 text-[11.5px] font-semibold transition-colors ${
              activeTab === tab
                ? 'text-ink border-b-2 border-ink -mb-px'
                : 'text-ink-faint hover:text-ink-muted'
            }`}
          >
            {tab === 'notes' ? 'Notes' : 'Transcript'}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {activeTab === 'notes' ? (
          <div className="flex flex-col gap-4">
            {CATEGORY_ORDER.map((category) => {
              const items = getSegmentsForCategory(category)
              return (
                <div
                  key={category}
                  className="bg-bg-card border border-border rounded-xl p-4"
                >
                  <div className="flex items-center gap-1.5 mb-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-ink" />
                    <span className="text-[11px] font-bold text-ink tracking-[0.03em] uppercase">
                      {SEGMENT_LABELS[category]}
                    </span>
                    {items.length > 0 && (
                      <span className="text-[10px] text-ink-faint ml-1">
                        ({items.length})
                      </span>
                    )}
                  </div>
                  {items.length === 0 ? (
                    <p className="text-[12px] text-ink-muted leading-relaxed">
                      {segmentationStatus === 'segmenting'
                        ? 'Analyzing transcript...'
                        : segmentationStatus === 'failed'
                          ? 'Segmentation failed. Try retrying above.'
                          : `No ${SEGMENT_LABELS[category].toLowerCase()} recorded yet.`}
                    </p>
                  ) : (
                    <div className="flex flex-col gap-2.5">
                      {items.map((item) => (
                        <div key={item.id} className="flex flex-col gap-0.5">
                          <span className="text-[12.5px] font-semibold text-ink">
                            {item.title}
                          </span>
                          <span className="text-[12px] text-ink-muted leading-relaxed">
                            {item.content}
                          </span>
                          {(item.assignee || item.deadline) && (
                            <div className="flex gap-3 mt-0.5">
                              {item.assignee && (
                                <span className="text-[11px] text-ink-faint">
                                  Owner: {item.assignee}
                                </span>
                              )}
                              {item.deadline && (
                                <span className="text-[11px] text-ink-faint">
                                  Due: {item.deadline}
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {media?.hasVideo && (
              <div className="bg-bg-card border border-border rounded-xl overflow-hidden">
                <video
                  controls
                  className="w-full"
                  src={`autodoc-media://${id}/screen.webm`}
                />
              </div>
            )}
            {media?.hasAudio && !media?.hasVideo && (
              <div className="bg-bg-card border border-border rounded-xl p-4">
                <audio
                  controls
                  className="w-full"
                  src={`autodoc-media://${id}/audio.webm`}
                />
              </div>
            )}
            <TranscriptView segments={transcript} status={transcriptionStatus} />
          </div>
        )}
      </div>
    </div>
  )
}
