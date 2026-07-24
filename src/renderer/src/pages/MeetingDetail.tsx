import { useState, useEffect, useRef, useCallback } from 'react'
import type { SyntheticEvent } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { SEGMENT_LABELS } from '../../../shared/constants'
import type {
  SegmentCategory,
  Segment,
  MeetingSegments,
  Transcript,
  TranscriptionStatus,
  SegmentationStatus,
  SpeakerMap
} from '../../../shared/types'
import { TranscriptView } from '../components/TranscriptView'
import { TranscriptionBadge } from '../components/TranscriptionBadge'
import { SegmentationBadge } from '../components/SegmentationBadge'
import { SpeakerLegend } from '../components/SpeakerLegend'
import { MEDIA_DEBUG_PREFIX, snapshotMediaElement } from '../lib/mediaDiagnostics'
import { trackEvent } from '../services/analytics'

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

function mergeProgress(
  status: TranscriptionStatus,
  current: number | undefined,
  next: number | undefined
): number | undefined {
  if (status !== 'transcribing') return undefined
  if (next == null) return current
  if (current == null) return next
  return Math.max(current, next)
}

const CATEGORY_ORDER: SegmentCategory[] = [
  'information',
  'decision',
  'action_item',
  'discussion',
  'status_update'
]

const CATEGORY_TO_KEY: Record<SegmentCategory, keyof MeetingSegments> = {
  decision: 'decisions',
  action_item: 'actionItems',
  information: 'information',
  discussion: 'discussion',
  status_update: 'statusUpdates'
}

function EditableText({
  value,
  onSave,
  className,
  as: Tag = 'span'
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
  const [transcriptionBackendLabel, setTranscriptionBackendLabel] = useState<string | undefined>()
  const [transcriptionQualityMode, setTranscriptionQualityMode] = useState<
    'fast' | 'balanced' | undefined
  >()
  const [segments, setSegments] = useState<MeetingSegments | null>(null)
  const [segmentationStatus, setSegmentationStatus] = useState<SegmentationStatus>('pending')
  const [segmentationProgress, setSegmentationProgress] = useState<number | undefined>()
  const [segmentationErrorCode, setSegmentationErrorCode] = useState<string | undefined>()
  const [detail, setDetail] = useState<{
    title: string
    sourceName: string | null
    date: number
    durationSeconds: number | null
    isFinalizing?: boolean
    videoProcessingFailed?: boolean
    videoStatus?: 'processing' | 'ready' | 'failed'
  } | null>(null)
  const [media, setMedia] = useState<{
    hasVideo: boolean
    hasAudio: boolean
    audioFile?: string
    videoStatus?: 'processing' | 'ready' | 'failed'
    mediaBaseUrl?: string
  } | null>(null)
  const [videoRetryPending, setVideoRetryPending] = useState(false)
  const [speakers, setSpeakers] = useState<SpeakerMap>({})
  const contentScrollRef = useRef<HTMLDivElement | null>(null)
  const transcriptTopRef = useRef<HTMLDivElement | null>(null)
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null)
  /** Dedupe identical `<video>`/`<audio>` `error` bursts (same code + URL) within this window. */
  const mediaPlayerErrorLastAtRef = useRef<Map<string, number>>(new Map())
  const activeTabRef = useRef<Tab>('notes')
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const lastProgressLogAtRef = useRef(0)
  const lastTimeUpdateLogAtRef = useRef(0)
  const [playbackRate, setPlaybackRate] = useState(1)

  const PLAYBACK_RATES = [1, 1.25, 1.5, 1.75, 2]

  useEffect(() => {
    activeTabRef.current = activeTab
  }, [activeTab])

  useEffect(() => {
    mediaPlayerErrorLastAtRef.current.clear()
  }, [id])

  const reportRendererMediaError = useCallback(
    (kind: 'video' | 'audio') => (e: SyntheticEvent<HTMLVideoElement | HTMLAudioElement>) => {
      if (!id) return
      const el = e.currentTarget
      const me = el.error
      const code = me?.code ?? -1
      const dedupeKey = `${kind}:${code}:${el.currentSrc}`
      const now = Date.now()
      const prev = mediaPlayerErrorLastAtRef.current.get(dedupeKey) ?? 0
      const dedupeMs = 60_000
      if (now - prev < dedupeMs) return
      mediaPlayerErrorLastAtRef.current.set(dedupeKey, now)

      void window.electronAPI.invoke('recording:report-media-player-error', {
        meetingId: id,
        kind,
        mediaErrorCode: me?.code ?? null,
        mediaErrorMessage: me?.message ?? null,
        currentSrc: el.currentSrc,
        networkState: el.networkState,
        readyState: el.readyState
      })
    },
    [id]
  )

  const handleSeek = useCallback(
    (ms: number) => {
      const el = mediaRef.current
      const seconds = ms / 1000
      console.log(MEDIA_DEBUG_PREFIX, 'handleSeek:requested', {
        meetingId: id,
        activeTab: activeTabRef.current,
        targetMs: ms,
        targetSec: seconds,
        mediaMissing: !el,
        ...(el ? snapshotMediaElement(el) : {})
      })
      if (!el) {
        console.warn(
          MEDIA_DEBUG_PREFIX,
          'handleSeek:aborted — no media element (wrong tab or not mounted?)'
        )
        return
      }
      try {
        el.currentTime = seconds
        console.log(MEDIA_DEBUG_PREFIX, 'handleSeek:setCurrentTime', {
          afterAssign: el.currentTime,
          seekableEmpty: el.seekable.length === 0
        })
      } catch (e) {
        console.warn(MEDIA_DEBUG_PREFIX, 'handleSeek:setCurrentTime threw', e)
      }
      void el.play().catch((err) => {
        console.warn(MEDIA_DEBUG_PREFIX, 'handleSeek:play() rejected', err)
      })
    },
    [id]
  )

  const scrollTranscriptIntoView = useCallback(() => {
    if (contentScrollRef.current) {
      contentScrollRef.current.scrollTop = 0
    }
    transcriptTopRef.current?.scrollIntoView({ block: 'start' })
  }, [])

  const seekToSegment = useCallback(
    (ms: number) => {
      const seconds = ms / 1000
      const fromTab = activeTabRef.current
      console.log(MEDIA_DEBUG_PREFIX, 'seekToSegment:requested', {
        meetingId: id,
        fromTab,
        targetMs: ms,
        targetSec: seconds,
        note:
          fromTab !== 'transcript'
            ? 'switching to transcript tab — media may not exist until after React commit'
            : undefined
      })
      setActiveTab('transcript')
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          scrollTranscriptIntoView()
          const el = mediaRef.current
          if (!el) {
            console.warn(MEDIA_DEBUG_PREFIX, 'seekToSegment:post-rAF — media ref still null', {
              meetingId: id,
              fromTab,
              likelyCause:
                'video/audio not mounted yet (tab switch race) or no media for this recording'
            })
            return
          }
          console.log(MEDIA_DEBUG_PREFIX, 'seekToSegment:post-rAF', {
            meetingId: id,
            ...snapshotMediaElement(el)
          })
          try {
            el.currentTime = seconds
            console.log(MEDIA_DEBUG_PREFIX, 'seekToSegment:setCurrentTime', {
              afterAssign: el.currentTime,
              seekableEmpty: el.seekable.length === 0
            })
          } catch (e) {
            console.warn(MEDIA_DEBUG_PREFIX, 'seekToSegment:setCurrentTime threw', e)
          }
          void el.play().catch((err) => {
            console.warn(MEDIA_DEBUG_PREFIX, 'seekToSegment:play() rejected', err)
          })
        })
      })
    },
    [id, scrollTranscriptIntoView]
  )

  const cyclePlaybackRate = useCallback(() => {
    const el = mediaRef.current
    if (!el) {
      console.warn(MEDIA_DEBUG_PREFIX, 'cyclePlaybackRate:no media element')
      return
    }
    const currentIdx = PLAYBACK_RATES.indexOf(playbackRate)
    const nextIdx = (currentIdx + 1) % PLAYBACK_RATES.length
    const newRate = PLAYBACK_RATES[nextIdx]
    console.log(MEDIA_DEBUG_PREFIX, 'cyclePlaybackRate', { from: playbackRate, to: newRate })
    el.playbackRate = newRate
    setPlaybackRate(newRate)
  }, [playbackRate])

  /** Console diagnostics for HTMLMediaElement lifecycle (load, buffer, seek, stall). */
  useEffect(() => {
    if (activeTab !== 'transcript' || !id || !media) return
    const el = mediaRef.current
    if (!el) return

    const log = (event: string, extra?: Record<string, unknown>) => {
      console.log(MEDIA_DEBUG_PREFIX, `media:${event}`, {
        meetingId: id,
        activeTab,
        ...extra,
        ...(el.isConnected ? snapshotMediaElement(el) : { detached: true })
      })
    }

    const onLoadStart = () => log('loadstart')
    const onLoadedMeta = () => log('loadedmetadata')
    const onLoadedData = () => log('loadeddata')
    const onCanPlay = () => log('canplay')
    const onCanPlayThrough = () => log('canplaythrough')
    const onPlay = () => log('play')
    const onPlaying = () => log('playing')
    const onPause = () => log('pause')
    const onWaiting = () => log('waiting')
    const onStalled = () => log('stalled')
    const onSuspend = () => log('suspend')
    const onEmptied = () => log('emptied')
    const onEnded = () => log('ended')
    const onError = () => {
      log('error', {
        error: el.error ? { code: el.error.code, message: el.error.message } : null
      })
    }
    const onSeeking = () => log('seeking')
    const onSeeked = () => log('seeked')
    const onProgress = () => {
      const now = Date.now()
      if (now - lastProgressLogAtRef.current < 2000) return
      lastProgressLogAtRef.current = now
      log('progress (throttled ~2s)', { bufferedRanges: snapshotMediaElement(el).buffered })
    }
    const onTimeUpdate = () => {
      const now = Date.now()
      if (now - lastTimeUpdateLogAtRef.current < 8000) return
      lastTimeUpdateLogAtRef.current = now
      log('timeupdate (throttled ~8s)', { currentTime: el.currentTime })
    }
    const onRateChange = () => log('ratechange', { playbackRate: el.playbackRate })

    el.addEventListener('loadstart', onLoadStart)
    el.addEventListener('loadedmetadata', onLoadedMeta)
    el.addEventListener('loadeddata', onLoadedData)
    el.addEventListener('canplay', onCanPlay)
    el.addEventListener('canplaythrough', onCanPlayThrough)
    el.addEventListener('play', onPlay)
    el.addEventListener('playing', onPlaying)
    el.addEventListener('pause', onPause)
    el.addEventListener('waiting', onWaiting)
    el.addEventListener('stalled', onStalled)
    el.addEventListener('suspend', onSuspend)
    el.addEventListener('emptied', onEmptied)
    el.addEventListener('ended', onEnded)
    el.addEventListener('error', onError)
    el.addEventListener('seeking', onSeeking)
    el.addEventListener('seeked', onSeeked)
    el.addEventListener('progress', onProgress)
    el.addEventListener('timeupdate', onTimeUpdate)
    el.addEventListener('ratechange', onRateChange)

    console.log(MEDIA_DEBUG_PREFIX, 'media:lifecycle listeners attached', {
      meetingId: id,
      tag: el.tagName,
      src: (el as HTMLMediaElement).currentSrc?.slice(0, 160)
    })

    return () => {
      el.removeEventListener('loadstart', onLoadStart)
      el.removeEventListener('loadedmetadata', onLoadedMeta)
      el.removeEventListener('loadeddata', onLoadedData)
      el.removeEventListener('canplay', onCanPlay)
      el.removeEventListener('canplaythrough', onCanPlayThrough)
      el.removeEventListener('play', onPlay)
      el.removeEventListener('playing', onPlaying)
      el.removeEventListener('pause', onPause)
      el.removeEventListener('waiting', onWaiting)
      el.removeEventListener('stalled', onStalled)
      el.removeEventListener('suspend', onSuspend)
      el.removeEventListener('emptied', onEmptied)
      el.removeEventListener('ended', onEnded)
      el.removeEventListener('error', onError)
      el.removeEventListener('seeking', onSeeking)
      el.removeEventListener('seeked', onSeeked)
      el.removeEventListener('progress', onProgress)
      el.removeEventListener('timeupdate', onTimeUpdate)
      el.removeEventListener('ratechange', onRateChange)
      console.log(MEDIA_DEBUG_PREFIX, 'media:lifecycle listeners detached', { meetingId: id })
    }
  }, [activeTab, id, media])

  const handleRenameSpeaker = useCallback(
    async (speakerId: string, newLabel: string) => {
      if (!id) return
      await window.electronAPI.invoke('speakers:rename', id, speakerId, newLabel)
      setSpeakers((prev) => ({
        ...prev,
        [speakerId]: { ...prev[speakerId], label: newLabel }
      }))
    },
    [id]
  )

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
    [id]
  )

  const updateSegmentField = useCallback(
    (category: SegmentCategory, index: number, field: 'title' | 'content', value: string) => {
      if (!segments) return
      const key = CATEGORY_TO_KEY[category]
      const updated = {
        ...segments,
        [key]: segments[key].map((item, i) => (i === index ? { ...item, [field]: value } : item))
      }
      saveSegments(updated)
    },
    [segments, saveSegments]
  )

  const deleteSegment = useCallback(
    (category: SegmentCategory, index: number) => {
      if (!segments) return
      const key = CATEGORY_TO_KEY[category]
      const updated = {
        ...segments,
        [key]: segments[key].filter((_, i) => i !== index)
      }
      saveSegments(updated)
    },
    [segments, saveSegments]
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
        sourceEndMs: 0
      }
      const updated = {
        ...segments,
        [key]: [...segments[key], newItem]
      }
      saveSegments(updated)
    },
    [segments, id, saveSegments]
  )

  useEffect(() => {
    if (!id) return

    const refreshDetail = () =>
      window.electronAPI.invoke('recording:get-detail', id).then((nextDetail) => {
        console.info('[meeting-detail] refreshDetail resolved', {
          at: new Date().toISOString(),
          meetingId: id,
          isFinalizing: nextDetail?.isFinalizing ?? false,
          videoStatus: nextDetail?.videoStatus ?? null
        })
        setDetail(nextDetail)
        if (nextDetail?.videoStatus === 'ready' || nextDetail?.videoStatus === 'failed') {
          setVideoRetryPending(false)
        }
      })
    const refreshMedia = () => window.electronAPI.invoke('recording:get-media', id).then(setMedia)

    refreshDetail()
    refreshMedia()
    void Promise.all([
      window.electronAPI.invoke('transcription:get-status', id),
      window.electronAPI.invoke('transcription:get-progress', id),
      window.electronAPI.invoke('segmentation:get-status', id),
      window.electronAPI.invoke('segmentation:get-progress', id),
      window.electronAPI.invoke('segmentation:get-error-code', id)
    ]).then(
      ([
        status,
        progress,
        nextSegmentationStatus,
        nextSegmentationProgress,
        nextSegmentationErrorCode
      ]) => {
        setTranscriptionStatus(status)
        setTranscriptionProgress((current) => mergeProgress(status, current, progress))
        setSegmentationStatus(nextSegmentationStatus)
        setSegmentationProgress(nextSegmentationProgress)
        setSegmentationErrorCode(
          nextSegmentationStatus === 'failed' ? nextSegmentationErrorCode : undefined
        )
        if (nextSegmentationStatus === 'complete') {
          window.electronAPI.invoke('segmentation:get-segments', id).then(setSegments)
        } else {
          setSegments(null)
        }
      }
    )
    window.electronAPI.invoke('transcription:get-transcript', id).then(setTranscript)
    window.electronAPI.invoke('speakers:get', id).then((s) => s && setSpeakers(s))

    const unsubTranscription = window.electronAPI.on('transcription:status-changed', (payload) => {
      if (payload.meetingId === id) {
        setTranscriptionStatus(payload.status)
        setTranscriptionProgress((current) =>
          mergeProgress(payload.status, current, payload.progress)
        )
        setTranscriptionBackendLabel(payload.backendLabel)
        setTranscriptionQualityMode(payload.qualityMode)
        if (payload.status === 'complete') {
          window.electronAPI.invoke('transcription:get-transcript', id).then(setTranscript)
          window.electronAPI.invoke('speakers:get', id).then((s) => s && setSpeakers(s))
        }
      }
    })

    const unsubSegmentation = window.electronAPI.on('segmentation:status-changed', (payload) => {
      if (payload.meetingId === id) {
        setSegmentationStatus(payload.status)
        setSegmentationProgress(payload.progress)
        setSegmentationErrorCode(payload.status === 'failed' ? payload.errorCode : undefined)
        if (payload.status === 'complete') {
          window.electronAPI.invoke('segmentation:get-segments', id).then(setSegments)
        } else {
          setSegments(null)
        }
      }
    })

    const unsubRecordingEntryUpdated = window.electronAPI.on(
      'recording:entry-updated',
      (payload) => {
        if (payload.meetingId === id) {
          refreshDetail()
          refreshMedia()
        }
      }
    )

    return () => {
      unsubRecordingEntryUpdated()
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

  const handleRetryVideo = () => {
    if (!id) return
    setVideoRetryPending(true)
    void window.electronAPI
      .invoke('recording:retry-video', id)
      .then(() => {
        setDetail((current) =>
          current
            ? { ...current, videoStatus: 'processing', videoProcessingFailed: undefined }
            : current
        )
        setMedia((current) =>
          current ? { ...current, hasVideo: false, videoStatus: 'processing' } : current
        )
      })
      .catch((error) => {
        console.error('Failed to retry video processing:', error)
        setVideoRetryPending(false)
      })
  }

  const handleReprocessTranscript = () => {
    if (!id) return
    setTranscriptionStatus('queued')
    setTranscriptionProgress(undefined)
    setTranscript([])
    setSegments(null)
    setSegmentationStatus('pending')
    setSegmentationErrorCode(undefined)
    window.electronAPI.invoke('transcription:retry', id)
  }

  const handleReprocessNotes = () => {
    if (!id) return
    setSegmentationStatus('queued')
    setSegmentationErrorCode(undefined)
    setSegments(null)
    window.electronAPI.invoke('segmentation:retry', id)
  }

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  useEffect(() => {
    if (!id) return

    const isTranscriptionActive =
      transcriptionStatus === 'queued' ||
      transcriptionStatus === 'downloading' ||
      transcriptionStatus === 'transcribing' ||
      transcriptionStatus === 'diarizing'
    const isSegmentationActive =
      segmentationStatus === 'queued' ||
      segmentationStatus === 'downloading-model' ||
      segmentationStatus === 'segmenting'

    if (!isTranscriptionActive && !isSegmentationActive) return

    let cancelled = false

    const refreshProcessingState = async () => {
      try {
        const [
          latestTranscriptionStatus,
          latestTranscriptionProgress,
          latestSegmentationStatus,
          latestSegmentationProgress,
          latestSegmentationErrorCode
        ] = await Promise.all([
          window.electronAPI.invoke('transcription:get-status', id),
          window.electronAPI.invoke('transcription:get-progress', id),
          window.electronAPI.invoke('segmentation:get-status', id),
          window.electronAPI.invoke('segmentation:get-progress', id),
          window.electronAPI.invoke('segmentation:get-error-code', id)
        ])

        if (cancelled) return

        setTranscriptionStatus(latestTranscriptionStatus)
        setTranscriptionProgress((current) =>
          mergeProgress(latestTranscriptionStatus, current, latestTranscriptionProgress)
        )
        setSegmentationStatus(latestSegmentationStatus)
        setSegmentationProgress(latestSegmentationProgress)
        setSegmentationErrorCode(
          latestSegmentationStatus === 'failed' ? latestSegmentationErrorCode : undefined
        )

        if (latestTranscriptionStatus === 'complete') {
          window.electronAPI.invoke('transcription:get-transcript', id).then((nextTranscript) => {
            if (!cancelled) setTranscript(nextTranscript)
          })
          window.electronAPI.invoke('speakers:get', id).then((nextSpeakers) => {
            if (!cancelled && nextSpeakers) setSpeakers(nextSpeakers)
          })
        }

        if (latestSegmentationStatus === 'complete') {
          window.electronAPI.invoke('segmentation:get-segments', id).then((nextSegments) => {
            if (!cancelled) setSegments(nextSegments)
          })
        } else {
          setSegments(null)
        }
      } catch (err) {
        console.error('Failed to refresh processing state:', err)
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
  }, [id, transcriptionStatus, segmentationStatus])

  const handleDelete = async () => {
    if (!id) return
    await window.electronAPI.invoke('recording:delete', id)
    trackEvent('recording_deleted')
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

  const formatTimestamp = (ms: number): string => {
    const totalSec = Math.floor(ms / 1000)
    const h = Math.floor(totalSec / 3600)
    const m = Math.floor((totalSec % 3600) / 60)
    const s = totalSec % 60
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    return `${m}:${String(s).padStart(2, '0')}`
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-4 border-b border-border flex items-center justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-1.5 text-[12px]">
            <button
              onClick={() => navigate('/recordings')}
              className="text-ink-faint hover:text-ink transition-colors shrink-0"
            >
              AI Notes
            </button>
            <span className="text-ink-faint shrink-0">/</span>
            <EditableText
              value={detail?.title ?? 'Meeting'}
              onSave={(newTitle) => {
                if (!id) return
                window.electronAPI.invoke('recording:update-title', id, newTitle).then(() => {
                  setDetail((prev) => (prev ? { ...prev, title: newTitle } : prev))
                })
              }}
              className="text-ink font-semibold flex-1 min-w-0"
            />
          </div>
          {detail && (
            <div className="flex items-center gap-2 mt-0.5 text-[11px] text-ink-faint">
              <span>
                {new Date(detail.date).toLocaleDateString('en-US', {
                  weekday: 'short',
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit'
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
          <TranscriptionBadge
            status={transcriptionStatus}
            progress={transcriptionProgress}
            backendLabel={transcriptionBackendLabel}
            qualityMode={transcriptionQualityMode}
            onRetry={handleRetryTranscription}
          />
          <SegmentationBadge
            status={segmentationStatus}
            progress={segmentationProgress}
            errorCode={segmentationErrorCode}
            onRetry={handleRetrySegmentation}
          />
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
      <div ref={contentScrollRef} className="flex-1 overflow-y-auto p-6" data-content-scroll>
        {detail?.isFinalizing && (
          <div className="mb-4 rounded-xl border border-border bg-bg-card px-4 py-3 text-[12px] text-ink-muted">
            Wrapping up this recording. It should finish appearing in a moment.
          </div>
        )}
        {activeTab === 'notes' ? (
          <div ref={transcriptTopRef} className="flex flex-col gap-4">
            {CATEGORY_ORDER.map((category) => {
              const items = getSegmentsForCategory(category)
              return (
                <div key={category} className="bg-bg-card border border-border rounded-xl p-4">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-1.5">
                      <div className="w-1.5 h-1.5 rounded-full bg-ink" />
                      <span className="text-[11px] font-bold text-ink tracking-[0.03em] uppercase">
                        {SEGMENT_LABELS[category]}
                      </span>
                      {items.length > 0 && (
                        <span className="text-[10px] text-ink-faint ml-1">({items.length})</span>
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
                        : segmentationStatus === 'no-notes'
                          ? 'AutoDoc could not turn this transcript into structured notes. The transcript is still available below.'
                          : segmentationStatus === 'failed'
                            ? segmentationErrorCode === 'ollama-insufficient-memory'
                              ? 'AutoDoc could not generate notes because Ollama did not have enough available RAM.'
                              : 'Segmentation failed. Try retrying above.'
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
                                <div
                                  key={item.id}
                                  className="group flex flex-col gap-0.5 pl-2"
                                  data-searchable
                                >
                                  <div className="flex items-start justify-between gap-2">
                                    <EditableText
                                      value={item.title}
                                      onSave={(v) =>
                                        updateSegmentField(category, globalIndex, 'title', v)
                                      }
                                      className="text-[12.5px] font-semibold text-ink flex-1"
                                    />
                                    <div className="flex items-center gap-1 shrink-0">
                                      {(media?.hasVideo || media?.hasAudio) &&
                                        item.sourceStartMs > 0 && (
                                          <button
                                            onClick={() => seekToSegment(item.sourceStartMs)}
                                            className="opacity-0 group-hover:opacity-100 text-[11px] text-ink-faint hover:text-ink transition-all mt-0.5"
                                            title={`Jump to ${formatTimestamp(item.sourceStartMs)}`}
                                          >
                                            ▶ {formatTimestamp(item.sourceStartMs)}
                                          </button>
                                        )}
                                      <button
                                        onClick={() => deleteSegment(category, globalIndex)}
                                        className="opacity-0 group-hover:opacity-100 text-[11px] text-ink-faint hover:text-clay transition-all mt-0.5"
                                        title="Delete"
                                      >
                                        &times;
                                      </button>
                                    </div>
                                  </div>
                                  <EditableText
                                    value={item.content}
                                    onSave={(v) =>
                                      updateSegmentField(category, globalIndex, 'content', v)
                                    }
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
            {(detail?.videoStatus === 'processing' || videoRetryPending) && (
              <div className="bg-bg-card border border-border rounded-xl px-4 py-6 text-center">
                <p className="text-[13px] text-ink-muted animate-pulse">
                  Finishing up your video…
                </p>
                <p className="text-[11.5px] text-ink-faint mt-1">
                  Your transcript and notes are ready to use.
                </p>
              </div>
            )}
            {detail?.videoStatus === 'failed' && !videoRetryPending && (
              <div className="bg-bg-card border border-border rounded-xl px-4 py-6 text-center">
                <p className="text-[13px] text-ink-muted">Video processing failed</p>
                <button
                  onClick={handleRetryVideo}
                  className="mt-3 text-[11.5px] font-semibold text-sage hover:text-ink transition-colors"
                >
                  Retry
                </button>
              </div>
            )}
            {media?.hasVideo && media.mediaBaseUrl && (
              <div className="bg-bg-card border border-border rounded-xl overflow-hidden">
                <video
                  ref={mediaRef as React.RefObject<HTMLVideoElement>}
                  controls
                  className="w-full"
                  src={`${media.mediaBaseUrl}/media/${id}/screen.webm`}
                  onError={reportRendererMediaError('video')}
                />
                <div className="flex justify-end px-3 py-1.5 border-t border-border">
                  <button
                    onClick={cyclePlaybackRate}
                    className="text-[11px] font-semibold text-ink-muted hover:text-ink bg-bg-accent px-2 py-0.5 rounded transition-colors"
                  >
                    {playbackRate}x
                  </button>
                </div>
              </div>
            )}
            {media?.hasAudio && !media?.hasVideo && media.mediaBaseUrl && (
              <div className="bg-bg-card border border-border rounded-xl p-4">
                <div className="flex items-center gap-3">
                  <audio
                    ref={mediaRef as React.RefObject<HTMLAudioElement>}
                    controls
                    className="flex-1"
                    src={`${media.mediaBaseUrl}/media/${id}/${media?.audioFile ?? 'audio.webm'}`}
                    onError={reportRendererMediaError('audio')}
                  />
                  <button
                    onClick={cyclePlaybackRate}
                    className="text-[11px] font-semibold text-ink-muted hover:text-ink bg-bg-accent px-2 py-0.5 rounded transition-colors shrink-0"
                  >
                    {playbackRate}x
                  </button>
                </div>
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
              transcriptionProgress={transcriptionProgress}
              transcriptionBackendLabel={transcriptionBackendLabel}
              transcriptionQualityMode={transcriptionQualityMode}
              onSeek={media?.hasVideo || media?.hasAudio ? handleSeek : undefined}
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
                      Re-transcribe audio and regenerate notes from the new transcript
                    </div>
                  </div>
                  <button
                    onClick={handleReprocessTranscript}
                    disabled={
                      transcriptionStatus === 'transcribing' ||
                      transcriptionStatus === 'queued' ||
                      transcriptionStatus === 'downloading' ||
                      transcriptionStatus === 'diarizing'
                    }
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
                      : segmentationStatus === 'queued' ||
                          segmentationStatus === 'downloading-model'
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
              <p className="text-[11.5px] text-ink-muted mb-4">This action cannot be undone.</p>
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
