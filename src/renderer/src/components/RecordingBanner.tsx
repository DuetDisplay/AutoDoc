interface RecordingBannerProps {
  isRecording: boolean
  elapsedSeconds: number
  sourceName: string | null
  onStop: () => void
}

export function RecordingBanner({ isRecording, elapsedSeconds, sourceName, onStop }: RecordingBannerProps) {
  if (!isRecording) return null

  const minutes = Math.floor(elapsedSeconds / 60)
  const seconds = elapsedSeconds % 60
  const timeStr = `${minutes}:${seconds.toString().padStart(2, '0')}`

  return (
    <div className="flex items-center gap-3 px-5 py-2.5 bg-bg-accent border-b border-border">
      <div className="w-2 h-2 rounded-full bg-status-recording animate-pulse" />
      <span className="text-[12px] font-medium text-ink">Recording</span>
      {sourceName && (
        <span className="text-[11px] text-ink-muted truncate max-w-xs">
          {sourceName}
        </span>
      )}
      <span className="text-[12px] font-mono text-ink-secondary ml-auto">
        {timeStr}
      </span>
      <button
        onClick={onStop}
        className="text-[11px] font-medium text-status-recording hover:opacity-80 transition-opacity"
      >
        Stop
      </button>
    </div>
  )
}
