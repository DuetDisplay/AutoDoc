import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { SEGMENT_LABELS } from '../../../shared/constants'
import type { SegmentCategory, Segment, MeetingSegments, Transcript, TranscriptionStatus, SegmentationStatus, SpeakerMap } from '../../../shared/types'
import { TranscriptView } from '../components/TranscriptView'
import { TranscriptionBadge } from '../components/TranscriptionBadge'
import { SegmentationBadge } from '../components/SegmentationBadge'
import { SpeakerLegend } from '../components/SpeakerLegend'

type Tab = 'notes' | 'transcript' | 'settings'

function formatDuration(seconds: number): string {
  const mins = Math.ceil(seconds / 60)
  if (mins >= 60) {
    const h = Math.floor(mins / 60)
    const m = mins % 60
    return m > 0 ? `${h}h ${m}m` : `${h}h`
  }
  return `${mins}m`
}

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

function EditableText({
  value,
  onSave,
  className,
  as: Tag = 'span',
}: {
  value: string
  onSave: (newValue: string) => void
  className?: string
  as?: 'span' | 'div'
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    setDraft(value)
  }, [value])

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.selectionStart = inputRef.current.value.length
      // Auto-resize
      inputRef.current.style.height = 'auto'
      inputRef.current.style.height = inputRef.current.scrollHeight + 'px'
    }
  }, [editing])

  const handleBlur = () => {
    setEditing(false)
    const trimmed = draft.trim()
    if (trimmed && trimmed !== value) {
      onSave(trimmed)
    } else {
      setDraft(value)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      inputRef.current?.blur()
    }
    if (e.key === 'Escape') {
      setDraft(value)
      setEditing(false)
    }
  }

  if (editing) {
    return (
      <textarea
        ref={inputRef}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          e.target.style.height = 'auto'
          e.target.style.height = e.target.scrollHeight + 'px'
        }}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        className={`${className} bg-transparent border-b border-sage/40 focus:border-sage outline-none resize-none w-full`}
        rows={1}
      />
    )
  }

  return (
    <Tag
      onClick={() => setEditing(true)}
      className={`${className} cursor-text hover:bg-bg-accent/60 rounded px-0.5 -mx-0.5 transition-colors`}
    >
      {value}
    </Tag>
  )
}

export function MeetingDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const initialTab = (searchParams.get('tab') as Tab) || 'notes'
  const highlightText = searchParams.get('highlight') || ''
  const [activeTab, setActiveTab] = useState<Tab>(initialTab)
  const [transcript, setTranscript] = useState<Transcript[]>([])
  const [transcriptionStatus, setTranscriptionStatus] = useState<TranscriptionStatus>('pending')
  const [transcriptionProgress, setTranscriptionProgress] = useState<number | undefined>()
  const [segments, setSegments] = useState<MeetingSegments | null>(null)
  const [segmentationStatus, setSegmentationStatus] = useState<SegmentationStatus>('pending')
  const [detail, setDetail] = useState<{ title: string; sourceName: string | null; date: number; durationSeconds: number | null } | null>(null)
  const [media, setMedia] = useState<{ hasVideo: boolean; hasAudio: boolean; audioFile?: string } | null>(null)
  const [speakers, setSpeakers] = useState<SpeakerMap>({})
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null)
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  const handleSeek = useCallback((ms: number) => {
    const el = mediaRef.current
    if (!el) return
    el.pause()
    el.currentTime = ms / 1000
    // webm from MediaRecorder may lack cue points — wait for seek to complete
    el.addEventListener('seeked', () => el.play(), { once: true })
  }, [])

  const handleRenameSpeaker = useCallback(async (speakerId: string, newLabel: string) => {
    if (!id) return
    await window.electronAPI.invoke('speakers:rename', id, speakerId, newLabel)
    setSpeakers((prev) => ({
      ...prev,
      [speakerId]: { ...prev[speakerId], label: newLabel },
    }))
  }, [id])

  const saveSegments = useCallback(
    (updated: MeetingSegments) => {
      setSegments(updated)
      // Debounce save to disk
      clearTimeout(saveTimeoutRef.current)
      saveTimeoutRef.current = setTimeout(() => {
        if (id) {
          window.electronAPI.invoke('segmentation:save-segments', id, updated)
        }
      }, 500)
    },
    [id],
  )

  const updateSegmentField = useCallback(
    (category: SegmentCategory, index: number, field: 'title' | 'content', value: string) => {
      if (!segments) return
      const key = CATEGORY_TO_KEY[category]
      const updated = {
        ...segments,
        [key]: segments[key].map((item, i) =>
          i === index ? { ...item, [field]: value } : item,
        ),
      }
      saveSegments(updated)
    },
    [segments, saveSegments],
  )

  const deleteSegment = useCallback(
    (category: SegmentCategory, index: number) => {
      if (!segments) return
      const key = CATEGORY_TO_KEY[category]
      const updated = {
        ...segments,
        [key]: segments[key].filter((_, i) => i !== index),
      }
      saveSegments(updated)
    },
    [segments, saveSegments],
  )

  const addSegment = useCallback(
    (category: SegmentCategory) => {
      if (!segments || !id) return
      const key = CATEGORY_TO_KEY[category]
      const newItem: Segment = {
        id: `${id}-${key}-${Date.now()}`,
        meetingId: id,
        category,
        topic: null,
        title: 'New item',
        content: 'Add details here...',
        assignee: null,
        deadline: null,
        sourceStartMs: 0,
        sourceEndMs: 0,
      }
      const updated = {
        ...segments,
        [key]: [...segments[key], newItem],
      }
      saveSegments(updated)
    },
    [segments, id, saveSegments],
  )

  useEffect(() => {
    if (!id) return

    window.electronAPI.invoke('recording:get-detail', id).then(setDetail)
    window.electronAPI.invoke('transcription:get-status', id).then(setTranscriptionStatus)
    window.electronAPI.invoke('transcription:get-transcript', id).then(setTranscript)
    window.electronAPI.invoke('segmentation:get-status', id).then(setSegmentationStatus)
    window.electronAPI.invoke('segmentation:get-segments', id).then(setSegments)
    window.electronAPI.invoke('recording:get-media', id).then(setMedia)
    window.electronAPI.invoke('speakers:get', id).then((s) => s && setSpeakers(s))

    const unsubTranscription = window.electronAPI.on(
      'transcription:status-changed',
      (payload) => {
        if (payload.meetingId === id) {
          setTranscriptionStatus(payload.status)
          setTranscriptionProgress(payload.progress)
          if (payload.status === 'complete') {
            window.electronAPI.invoke('transcription:get-transcript', id).then(setTranscript)
            window.electronAPI.invoke('speakers:get', id).then((s) => s && setSpeakers(s))
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
      clearTimeout(saveTimeoutRef.current)
    }
  }, [id])

  // Scroll to highlighted search result after content loads
  useEffect(() => {
    if (!highlightText) return
    const timer = setTimeout(() => {
      const container = document.querySelector('[data-content-scroll]')
      if (!container) return
      const elements = container.querySelectorAll('[data-searchable]')
      for (const el of elements) {
        const text = el.textContent ?? ''
        if (text.includes(highlightText)) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' })
          el.classList.add('ring-2', 'ring-sage/50', 'rounded-lg')
          setTimeout(() => el.classList.remove('ring-2', 'ring-sage/50', 'rounded-lg'), 3000)
          break
        }
      }
    }, 500)
    return () => clearTimeout(timer)
  }, [highlightText, transcript, segments])

  const handleRetryTranscription = () => {
    if (id) window.electronAPI.invoke('transcription:retry', id)
  }

  const handleRetrySegmentation = () => {
    if (id) window.electronAPI.invoke('segmentation:retry', id)
  }

  const handleReprocessTranscript = () => {
    if (!id) return
    setTranscriptionStatus('queued')
    setTranscript([])
    setSegments(null)
    setSegmentationStatus('pending')
    window.electronAPI.invoke('transcription:retry', id)
  }

  const handleReprocessNotes = () => {
    if (!id) return
    setSegmentationStatus('queued')
    setSegments(null)
    window.electronAPI.invoke('segmentation:retry', id)
  }

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  const handleDelete = async () => {
    if (!id) return
    await window.electronAPI.invoke('recording:delete', id)
    navigate('/recordings')
  }

  const getSegmentsForCategory = (category: SegmentCategory): Segment[] => {
    if (!segments) return []
    return segments[CATEGORY_TO_KEY[category]] ?? []
  }

  const groupByTopic = (items: Segment[]): { topic: string | null; items: Segment[] }[] => {
    const groups: { topic: string | null; items: Segment[] }[] = []
    const topicMap = new Map<string, Segment[]>()
    const ungrouped: Segment[] = []

    for (const item of items) {
      if (item.topic) {
        const existing = topicMap.get(item.topic)
        if (existing) {
          existing.push(item)
        } else {
          const group = [item]
          topicMap.set(item.topic, group)
          groups.push({ topic: item.topic, items: group })
        }
      } else {
        ungrouped.push(item)
      }
    }

    // Put ungrouped items at the end
    if (ungrouped.length > 0) {
      groups.push({ topic: null, items: ungrouped })
    }

    return groups
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-4 border-b border-border flex items-center justify-between">
        <div>
          <div className="flex items-center gap-1.5 text-[12px]">
            <button
              onClick={() => navigate('/recordings')}
              className="text-ink-faint hover:text-ink transition-colors"
            >
              AI Notes
            </button>
            <span className="text-ink-faint">/</span>
            <span className="text-ink font-semibold">{detail?.title ?? 'Meeting'}</span>
          </div>
          {detail && (
            <div className="flex items-center gap-2 mt-0.5 text-[11px] text-ink-faint">
              <span>
                {new Date(detail.date).toLocaleDateString('en-US', {
                  weekday: 'short',
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </span>
              {detail.durationSeconds != null && (
                <>
                  <span className="text-border">|</span>
                  <span>{formatDuration(detail.durationSeconds)}</span>
                </>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <TranscriptionBadge status={transcriptionStatus} progress={transcriptionProgress} onRetry={handleRetryTranscription} />
          <SegmentationBadge status={segmentationStatus} onRetry={handleRetrySegmentation} />
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border px-6">
        {(['notes', 'transcript', 'settings'] as Tab[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-3.5 py-2.5 text-[11.5px] font-semibold transition-colors ${
              activeTab === tab
                ? 'text-ink border-b-2 border-ink -mb-px'
                : 'text-ink-faint hover:text-ink-muted'
            }`}
          >
            {tab === 'notes' ? 'Notes' : tab === 'transcript' ? 'Transcript' : 'Settings'}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6" data-content-scroll>
        {activeTab === 'notes' ? (
          <div className="flex flex-col gap-4">
            {CATEGORY_ORDER.map((category) => {
              const items = getSegmentsForCategory(category)
              return (
                <div
                  key={category}
                  className="bg-bg-card border border-border rounded-xl p-4"
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-1.5">
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
                    {segmentationStatus === 'complete' && (
                      <button
                        onClick={() => addSegment(category)}
                        className="text-[11px] text-ink-faint hover:text-sage transition-colors"
                      >
                        + Add
                      </button>
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
                    <div className="flex flex-col gap-3">
                      {groupByTopic(items).map((group, groupIdx) => (
                        <div key={group.topic ?? `ungrouped-${groupIdx}`}>
                          {group.topic && (
                            <div className="flex items-center gap-2 mb-1.5">
                              <h4 className="text-[11.5px] font-semibold text-sage tracking-wide">
                                {group.topic}
                              </h4>
                              <div className="flex-1 h-px bg-border-subtle" />
                            </div>
                          )}
                          <div className="flex flex-col gap-2 pl-2 border-l-2 border-border-subtle">
                            {group.items.map((item) => {
                              const globalIndex = items.indexOf(item)
                              return (
                                <div key={item.id} className="group flex flex-col gap-0.5 pl-2" data-searchable>
                                  <div className="flex items-start justify-between gap-2">
                                    <EditableText
                                      value={item.title}
                                      onSave={(v) => updateSegmentField(category, globalIndex, 'title', v)}
                                      className="text-[12.5px] font-semibold text-ink flex-1"
                                    />
                                    <button
                                      onClick={() => deleteSegment(category, globalIndex)}
                                      className="shrink-0 opacity-0 group-hover:opacity-100 text-[11px] text-ink-faint hover:text-clay transition-all mt-0.5"
                                      title="Delete"
                                    >
                                      &times;
                                    </button>
                                  </div>
                                  <EditableText
                                    value={item.content}
                                    onSave={(v) => updateSegmentField(category, globalIndex, 'content', v)}
                                    className="text-[12px] text-ink-muted leading-relaxed"
                                    as="div"
                                  />
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
                              )
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        ) : activeTab === 'transcript' ? (
          <div className="flex flex-col gap-4">
            {media?.hasVideo && (
              <div className="bg-bg-card border border-border rounded-xl overflow-hidden">
                <video
                  ref={mediaRef as React.RefObject<HTMLVideoElement>}
                  controls
                  className="w-full"
                  src={`autodoc-media://${id}/screen.webm`}
                />
              </div>
            )}
            {media?.hasAudio && !media?.hasVideo && (
              <div className="bg-bg-card border border-border rounded-xl p-4">
                <audio
                  ref={mediaRef as React.RefObject<HTMLAudioElement>}
                  controls
                  className="w-full"
                  src={`autodoc-media://${id}/${media?.audioFile ?? 'audio.webm'}`}
                />
              </div>
            )}
            {Object.keys(speakers).length > 0 && (
              <SpeakerLegend
                speakers={speakers}
                speakerIds={[...new Set(transcript.map((t) => t.speaker))]}
                onRename={handleRenameSpeaker}
              />
            )}
            <TranscriptView
              segments={transcript}
              status={transcriptionStatus}
              speakers={speakers}
              onSeek={(media?.hasVideo || media?.hasAudio) ? handleSeek : undefined}
            />
          </div>
        ) : (
          <div className="flex flex-col gap-5 max-w-lg">
            {/* Reprocess section */}
            <div className="bg-bg-card border border-border rounded-xl p-5">
              <h3 className="text-[12px] font-bold text-ink tracking-[0.03em] uppercase mb-1">
                Reprocess
              </h3>
              <p className="text-[11.5px] text-ink-muted mb-4">
                Re-run transcription or note generation from the original audio.
              </p>
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-[12.5px] font-semibold text-ink">Transcript</div>
                    <div className="text-[11px] text-ink-faint">
                      Re-transcribe audio with whisper — also regenerates notes
                    </div>
                  </div>
                  <button
                    onClick={handleReprocessTranscript}
                    disabled={transcriptionStatus === 'transcribing' || transcriptionStatus === 'queued' || transcriptionStatus === 'downloading' || transcriptionStatus === 'diarizing'}
                    className="px-3 py-1.5 text-[11.5px] font-semibold rounded-lg bg-sage/15 text-sage hover:bg-sage/25 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    {transcriptionStatus === 'transcribing' || transcriptionStatus === 'diarizing'
                      ? 'Processing...'
                      : transcriptionStatus === 'queued' || transcriptionStatus === 'downloading'
                        ? 'Queued...'
                        : 'Reprocess'}
                  </button>
                </div>
                <div className="border-t border-border" />
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-[12.5px] font-semibold text-ink">Notes</div>
                    <div className="text-[11px] text-ink-faint">
                      Regenerate AI notes from the existing transcript
                    </div>
                  </div>
                  <button
                    onClick={handleReprocessNotes}
                    disabled={
                      transcriptionStatus !== 'complete' ||
                      segmentationStatus === 'segmenting' ||
                      segmentationStatus === 'queued' ||
                      segmentationStatus === 'downloading-model'
                    }
                    className="px-3 py-1.5 text-[11.5px] font-semibold rounded-lg bg-sage/15 text-sage hover:bg-sage/25 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    {segmentationStatus === 'segmenting'
                      ? 'Processing...'
                      : segmentationStatus === 'queued' || segmentationStatus === 'downloading-model'
                        ? 'Queued...'
                        : 'Reprocess'}
                  </button>
                </div>
              </div>
            </div>

            {/* Danger zone */}
            <div className="bg-bg-card border border-clay/20 rounded-xl p-5">
              <h3 className="text-[12px] font-bold text-clay tracking-[0.03em] uppercase mb-1">
                Danger Zone
              </h3>
              <p className="text-[11.5px] text-ink-muted mb-4">
                This action cannot be undone.
              </p>
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-[12.5px] font-semibold text-ink">Delete recording</div>
                  <div className="text-[11px] text-ink-faint">
                    Permanently remove all audio, video, transcript, and notes
                  </div>
                </div>
                {!showDeleteConfirm ? (
                  <button
                    onClick={() => setShowDeleteConfirm(true)}
                    className="px-3 py-1.5 text-[11.5px] font-semibold rounded-lg bg-clay/10 text-clay hover:bg-clay/20 transition-colors"
                  >
                    Delete
                  </button>
                ) : (
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setShowDeleteConfirm(false)}
                      className="px-3 py-1.5 text-[11.5px] font-semibold rounded-lg text-ink-faint hover:text-ink transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleDelete}
                      className="px-3 py-1.5 text-[11.5px] font-semibold rounded-lg bg-clay text-white hover:bg-clay/90 transition-colors"
                    >
                      Confirm Delete
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
