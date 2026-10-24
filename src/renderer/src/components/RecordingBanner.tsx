import { useT } from '../services/i18n'
interface RecordingBannerProps {
  isRecording: boolean
  videoDisabled: boolean
  elapsedSeconds: number
  sourceName: string | null
  onStop: () => void
}

export function RecordingBanner({
  isRecording,
  videoDisabled,
  elapsedSeconds,
  sourceName,
  onStop
}: RecordingBannerProps) {
  const t = useT()

  if (!isRecording) return null

  const minutes = Math.floor(elapsedSeconds / 60)
  const seconds = elapsedSeconds % 60
  const timeStr = `${minutes}:${seconds.toString().padStart(2, '0')}`

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-5 py-2.5 bg-bg-accent border-b border-border min-w-0">
      <div className="w-2 h-2 rounded-full bg-status-recording animate-pulse" />
      <span className="text-[12px] font-medium text-ink">
        {videoDisabled ? t('ui.recordingAudioOnly') : t('ui.recording')}
      </span>
      {sourceName && (
        <span className="i18n-ellipsis max-w-xs text-[11px] text-ink-muted" title={sourceName}>
          {sourceName}
        </span>
      )}
      <span className="text-[12px] font-mono text-ink-secondary ml-auto">{timeStr}</span>
      <button
        onClick={onStop}
        className="text-[11px] font-medium text-status-recording hover:opacity-80 transition-opacity"
      >
        {t('recording.stop')}
      </button>
    </div>
  )
}
