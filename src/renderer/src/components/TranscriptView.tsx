import type { Transcript, TranscriptionStatus, SpeakerMap } from '../../../shared/types'
import { SPEAKER_COLORS } from '../../../shared/constants'

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

interface TranscriptViewProps {
  segments: Transcript[]
  status: TranscriptionStatus
  onSeek?: (ms: number) => void
  speakers?: SpeakerMap
}

export function TranscriptView({ segments, status, onSeek, speakers }: TranscriptViewProps) {
  if (status === 'pending' || status === 'queued') {
    return (
      <p className="text-[12px] text-ink-muted">
        Awaiting transcription. This will begin automatically.
      </p>
    )
  }

  if (status === 'downloading') {
    return (
      <div className="flex items-center gap-2">
        <div className="w-2 h-2 rounded-full bg-ink-muted animate-pulse" />
        <p className="text-[12px] text-ink-muted">
          Downloading transcription model...
        </p>
      </div>
    )
  }

  if (status === 'transcribing') {
    return (
      <div className="flex items-center gap-2">
        <div className="w-2 h-2 rounded-full bg-ink-muted animate-pulse" />
        <p className="text-[12px] text-ink-muted">
          Transcribing audio...
        </p>
      </div>
    )
  }

  if (status === 'diarizing') {
    return (
      <div className="flex items-center gap-2">
        <div className="w-2 h-2 rounded-full bg-ink-muted animate-pulse" />
        <p className="text-[12px] text-ink-muted">
          Identifying speakers...
        </p>
      </div>
    )
  }

  if (status === 'failed') {
    return (
      <p className="text-[12px] text-red-600">
        Transcription failed. Use the retry button to try again.
      </p>
    )
  }

  if (segments.length === 0) {
    return (
      <p className="text-[12px] text-ink-muted">
        No transcript segments found.
      </p>
    )
  }

  const speakerIds = speakers ? Object.keys(speakers) : []

  return (
    <div className="flex flex-col gap-1">
      {segments.map((seg) => {
        const color = speakers ? getSpeakerColor(seg.speaker, speakerIds) : null
        const speakerLabel = speakers?.[seg.speaker]?.label ?? null

        return (
          <div
            key={seg.id}
            className="flex gap-3"
            style={color ? { borderLeft: `3px solid ${color.border}`, backgroundColor: color.bg, paddingLeft: '8px', paddingTop: '4px', paddingBottom: '4px' } : undefined}
          >
            {onSeek ? (
              <button
                onClick={() => onSeek(seg.startMs)}
                className="text-[11px] text-ink-faint font-mono w-10 shrink-0 pt-0.5 text-left hover:text-ink hover:underline transition-colors cursor-pointer"
              >
                {formatTimestamp(seg.startMs)}
              </button>
            ) : (
              <span className="text-[11px] text-ink-faint font-mono w-10 shrink-0 pt-0.5">
                {formatTimestamp(seg.startMs)}
              </span>
            )}
            <div className="flex flex-col">
              {speakerLabel && (
                <span
                  className="text-[11px] font-bold mb-0.5"
                  style={color ? { color: color.border } : undefined}
                >
                  {speakerLabel}
                </span>
              )}
              <p className="text-[12.5px] text-ink leading-relaxed">
                {seg.text}
              </p>
            </div>
          </div>
        )
      })}
    </div>
  )
}
