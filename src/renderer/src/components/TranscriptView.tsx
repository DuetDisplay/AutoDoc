import { displaySpeakerLabel } from '../services/speaker-label'
import { useT } from '../services/i18n'
import { useEffect, useState } from 'react'
import type { Transcript, TranscriptionStatus, SpeakerMap } from '../../../shared/types'
import { SPEAKER_COLORS } from '../../../shared/constants'
import { getWhisperSetupLabel } from '../services/setup-status-labels'
import { formatTranscriptionStatusText } from '../services/transcription-status-labels'

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

function getSpeakerColor(speakerId: string, speakerIds: string[]): { border: string; bg: string } {
  if (speakerId === 'me') {
    return SPEAKER_COLORS[0]
  }
  const nonMeIds = speakerIds.filter((id) => id !== 'me')
  const index = nonMeIds.indexOf(speakerId)
  const colorIndex = index === -1 ? 1 : (index % (SPEAKER_COLORS.length - 1)) + 1
  return SPEAKER_COLORS[colorIndex]
}

function endsSentence(text: string): boolean {
  return /[.!?]["']?$/.test(text.trim())
}

interface TranscriptViewProps {
  segments: Transcript[]
  status: TranscriptionStatus
  onSeek?: (ms: number) => void
  speakers?: SpeakerMap
  transcriptionProgress?: number
  transcriptionBackendLabel?: string
}

export function TranscriptView({
  segments,
  status,
  onSeek,
  speakers,
  transcriptionProgress
}: TranscriptViewProps) {
  const t = useT()

  const [setupStatus, setSetupStatus] = useState<
    import('../../../shared/types').WhisperSetupStatus | null
  >(null)

  useEffect(() => {
    if (status !== 'downloading') {
      return
    }

    window.electronAPI.invoke('whisper:get-setup-status').then(setSetupStatus)
    const unsub = window.electronAPI.on('whisper:setup-progress', setSetupStatus)
    return unsub
  }, [status])

  const activeSetupStatus = status === 'downloading' ? setupStatus : null

  if (status === 'pending' || status === 'queued') {
    return (
      <p className="text-[12px] text-ink-muted">
        {t('ui.awaitingTranscriptionThisWillBeginAutomatically')}
      </p>
    )
  }

  if (status === 'downloading') {
    return (
      <div className="flex items-center gap-2">
        <div className="w-2 h-2 rounded-full bg-ink-muted animate-pulse" />
        <p className="text-[12px] text-ink-muted">
          {getWhisperSetupLabel(activeSetupStatus, t) ?? t('ui.preparingTranscriptionEngine')}
        </p>
      </div>
    )
  }

  if (status === 'transcribing') {
    const statusText =
      formatTranscriptionStatusText(
        {
          status,
          progress: transcriptionProgress
        },
        t
      ) ?? t('ui.transcribingAudio')

    return (
      <div className="flex items-center gap-2">
        <div className="w-2 h-2 rounded-full bg-ink-muted animate-pulse" />
        <p className="text-[12px] text-ink-muted">{statusText}</p>
      </div>
    )
  }

  if (status === 'diarizing') {
    return (
      <div className="flex items-center gap-2">
        <div className="w-2 h-2 rounded-full bg-ink-muted animate-pulse" />
        <p className="text-[12px] text-ink-muted">{t('ui.identifyingSpeakers')}</p>
      </div>
    )
  }

  if (status === 'failed') {
    return (
      <p className="text-[12px] text-clay-dark">
        {t('ui.transcriptionFailedUseTheRetryButtonToTryAgain')}
      </p>
    )
  }

  if (segments.length === 0) {
    return <p className="text-[12px] text-ink-muted">{t('ui.noTranscriptSegmentsFound')}</p>
  }

  const hasSpeakers = speakers != null && Object.keys(speakers).length > 0
  const speakerIds = hasSpeakers ? Object.keys(speakers) : []

  // Merge short same-speaker fragments into readable sentence-like blocks,
  // but stop before they turn into wall-of-text paragraphs.
  const TIME_GAP_MS = 2_500
  const MAX_GROUP_DURATION_MS = 20_000
  const MAX_GROUP_SEGMENTS = 6
  const MAX_GROUP_CHARACTERS = 220
  const MIN_COMPLETE_GROUP_CHARACTERS = 90
  const merged: { speaker: string; startMs: number; endMs: number; texts: string[] }[] = []
  for (const seg of segments) {
    const last = merged[merged.length - 1]
    const currentGroupText = last?.texts.join(' ') ?? ''
    const nextGroupText = currentGroupText ? `${currentGroupText} ${seg.text}` : seg.text
    const groupLooksComplete =
      currentGroupText.length >= MIN_COMPLETE_GROUP_CHARACTERS && endsSentence(currentGroupText)
    const shouldMerge =
      last &&
      last.speaker === seg.speaker &&
      seg.startMs - last.endMs < TIME_GAP_MS &&
      seg.endMs - last.startMs <= MAX_GROUP_DURATION_MS &&
      last.texts.length < MAX_GROUP_SEGMENTS &&
      nextGroupText.length <= MAX_GROUP_CHARACTERS &&
      !groupLooksComplete

    if (shouldMerge) {
      last.texts.push(seg.text)
      last.endMs = seg.endMs
    } else {
      merged.push({
        speaker: seg.speaker,
        startMs: seg.startMs,
        endMs: seg.endMs,
        texts: [seg.text]
      })
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {merged.map((group, i) => {
        const color = hasSpeakers ? getSpeakerColor(group.speaker, speakerIds) : null
        const speakerLabel = hasSpeakers
          ? displaySpeakerLabel(group.speaker, speakers![group.speaker], t)
          : null

        return (
          <div
            key={i}
            className="flex gap-3 rounded-lg transition-shadow"
            data-searchable
            style={
              color
                ? {
                    borderLeft: `3px solid ${color.border}`,
                    backgroundColor: color.bg,
                    paddingLeft: '8px',
                    paddingTop: '6px',
                    paddingBottom: '6px'
                  }
                : undefined
            }
          >
            {onSeek ? (
              <button
                onClick={() => onSeek(group.startMs)}
                className="text-[11px] text-ink-faint font-mono w-10 shrink-0 pt-0.5 text-left hover:text-ink hover:underline transition-colors cursor-pointer"
              >
                {formatTimestamp(group.startMs)}
              </button>
            ) : (
              <span className="text-[11px] text-ink-faint font-mono w-10 shrink-0 pt-0.5">
                {formatTimestamp(group.startMs)}
              </span>
            )}
            <div className="flex min-w-0 flex-1 flex-col">
              {speakerLabel && (
                <span
                  className="text-[11px] font-bold mb-0.5 [overflow-wrap:anywhere]"
                  style={color ? { color: color.border } : undefined}
                >
                  {speakerLabel}
                </span>
              )}
              <p className="text-[12.5px] text-ink leading-relaxed [overflow-wrap:anywhere]">
                {group.texts.join(' ')}
              </p>
            </div>
          </div>
        )
      })}
    </div>
  )
}
