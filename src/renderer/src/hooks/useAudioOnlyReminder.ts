import { useCallback, useEffect, useState } from 'react'
import { useT } from '../services/i18n'

/** How long a recording may run audio-only before the user is reminded. */
export const AUDIO_ONLY_REMINDER_DELAY_MS = 5 * 60 * 1000

interface AudioOnlyReminderOptions {
  isRecording: boolean
  meetingId: string | null
  videoDisabled: boolean
  delayMs?: number
}

/**
 * Starts a timer when a recording continues audio-only (video stopped) and reveals a reminder
 * once it elapses. The timer is tied to one video-stop: it is cancelled when the recording ends
 * or video returns, and a later video-stop starts a fresh timer. Dismissing suppresses further
 * reminders for the current video-stop only.
 */
export function useAudioOnlyReminder({
  isRecording,
  meetingId,
  videoDisabled,
  delayMs = AUDIO_ONLY_REMINDER_DELAY_MS
}: AudioOnlyReminderOptions): { visible: boolean; minutes: number; dismiss: () => void } {
  const t = useT()
  const [visible, setVisible] = useState(false)
  const minutes = Math.round(delayMs / 60_000)
  const audioOnly = isRecording && videoDisabled && meetingId !== null
  const title = t('ui.recordingAudioOnly')
  const body = t('recording.audioOnlyReminderBody', { minutes })

  useEffect(() => {
    if (!audioOnly) return
    const timer = setTimeout(() => {
      setVisible(true)
      window.electronAPI.send('recording:audio-only-reminder', title, body)
    }, delayMs)
    return () => {
      clearTimeout(timer)
      setVisible(false)
    }
    // title/body are only read when the timer fires; a language change must not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioOnly, meetingId, delayMs])

  const dismiss = useCallback(() => setVisible(false), [])
  return { visible: visible && audioOnly, minutes, dismiss }
}
