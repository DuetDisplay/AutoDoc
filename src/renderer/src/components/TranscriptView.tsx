import type { Transcript, TranscriptionStatus } from '../../../shared/types'

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

interface TranscriptViewProps {
  segments: Transcript[]
  status: TranscriptionStatus
  onSeek?: (ms: number) => void
}

export function TranscriptView({ segments, status, onSeek }: TranscriptViewProps) {
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

  return (
    <div className="flex flex-col gap-3">
      {segments.map((seg) => (
        <div key={seg.id} className="flex gap-3">
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
          <p className="text-[12.5px] text-ink leading-relaxed">
            {seg.text}
          </p>
        </div>
      ))}
    </div>
  )
}
