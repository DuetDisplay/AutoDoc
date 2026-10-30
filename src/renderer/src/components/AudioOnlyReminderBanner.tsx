import type { ReactElement } from 'react'
import { useT } from '../services/i18n'

interface AudioOnlyReminderBannerProps {
  visible: boolean
  minutes: number
  onStop: () => void
  onKeep: () => void
}

export function AudioOnlyReminderBanner({
  visible,
  minutes,
  onStop,
  onKeep
}: AudioOnlyReminderBannerProps): ReactElement | null {
  const t = useT()

  if (!visible) return null

  return (
    <div
      className="app-banner mx-6 mt-2 mb-0 rounded-xl border border-border bg-bg-card px-4 py-3 shadow-sm animate-[slideDown_300ms_ease]"
      role="alert"
    >
      <div className="app-banner-row">
        <div className="app-banner-copy">
          <h2 className="text-[12.5px] font-semibold text-ink">{t('ui.recordingAudioOnly')}</h2>
          <p className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
            {t('recording.audioOnlyReminderBody', { minutes })}
          </p>
        </div>
        <div className="app-banner-actions">
          <button
            onClick={onKeep}
            className="i18n-btn text-[12px] font-semibold text-ink-secondary transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sage"
          >
            {t('recording.audioOnlyReminderKeep')}
          </button>
          <button
            onClick={onStop}
            className="i18n-btn text-[12px] font-semibold text-status-recording hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-status-recording"
          >
            {t('recording.audioOnlyReminderStop')}
          </button>
        </div>
      </div>
    </div>
  )
}
