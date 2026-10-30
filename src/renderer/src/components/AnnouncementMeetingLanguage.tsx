import { useEffect, useState } from 'react'
import { isDiskFullError } from '../../../shared/disk-full'
import type { MessageKey } from '../../../shared/i18n'
import {
  MEETING_LANGUAGE_DEFINITIONS,
  normalizeMeetingLanguage,
  type MeetingLanguageAvailability,
  type MeetingLanguageCode
} from '../../../shared/meeting-language'
import type { WhisperSetupStatus } from '../../../shared/types'
import { useOnlineStatus } from '../hooks/useOnlineStatus'
import { formatMeetingLanguageFirstUseDownload } from '../services/format-bytes'
import { useT } from '../services/i18n'
import { meetingLanguageName } from '../services/meeting-language-name'
import { loadMeetingLanguageAvailability } from '../services/meeting-language-setup'
import { isNetworkErrorMessage } from '../services/network-errors'
import { getWhisperSetupLabel } from '../services/setup-status-labels'
import { AnnouncementRow } from './AnnouncementRow'
import { MeetingLanguagePicker } from './MeetingLanguagePicker'

export function AnnouncementMeetingLanguage({
  visible,
  onBusyChange
}: {
  visible: boolean
  onBusyChange: (busy: boolean) => void
}) {
  const t = useT()
  const online = useOnlineStatus()
  const [availability, setAvailability] = useState<MeetingLanguageAvailability | null>(null)
  const [language, setLanguage] = useState<MeetingLanguageCode>('en')
  const [preparing, setPreparing] = useState<MeetingLanguageCode | null>(null)
  const [status, setStatus] = useState<WhisperSetupStatus | null>(null)
  const [error, setError] = useState<MessageKey | null>(null)
  const [errorLanguage, setErrorLanguage] = useState<MeetingLanguageCode>('en')
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    if (!visible) return
    let active = true
    setError(null)
    void Promise.all([
      loadMeetingLanguageAvailability(),
      window.electronAPI.invoke('prefs:get-meeting-language')
    ]).then(
      ([available, saved]) => {
        if (!active) return
        setAvailability(available)
        setLanguage(normalizeMeetingLanguage(saved))
      },
      () => {
        if (active) setError('ui.couldNotLoadMeetingLanguages')
      }
    )
    return () => {
      active = false
    }
  }, [visible, retry])

  useEffect(() => {
    if (!preparing) return
    return window.electronAPI.on('whisper:setup-progress', (next) => {
      if (!next.meetingLanguage || next.meetingLanguage === preparing) setStatus(next)
    })
  }, [preparing])

  const choose = async (next: MeetingLanguageCode) => {
    if (preparing) return
    setPreparing(next)
    onBusyChange(true)
    setStatus({ phase: 'checking', percent: 0 })
    setError(null)
    try {
      // Use the same setup and persistence IPC as Settings; save only after setup succeeds.
      await window.electronAPI.invoke('whisper:prepare-meeting-language', next)
      await window.electronAPI.invoke('prefs:set-meeting-language', next)
      setLanguage(next)
      await window.electronAPI.invoke('prefs:confirm-onboarding-language')
    } catch (cause) {
      try {
        setLanguage(
          normalizeMeetingLanguage(await window.electronAPI.invoke('prefs:get-meeting-language'))
        )
      } catch {
        /* Keep the last saved selection. */
      }
      const message = cause instanceof Error ? cause.message : ''
      setErrorLanguage(next)
      setError(
        isDiskFullError(cause)
          ? 'ui.notEnoughDiskSpaceFreeUpSpaceAndTryAgain'
          : isNetworkErrorMessage(message)
            ? 'ui.youReOfflineConnectToTheInternetToDownloadTheLanguageSpeechModel'
            : 'settings.saveMeetingLanguageFailed'
      )
    } finally {
      // Failed setup can update a language's lock reason or the remaining download size.
      try {
        setAvailability(await loadMeetingLanguageAvailability())
      } catch {
        /* Retain known limits. */
      }
      setPreparing(null)
      setStatus(null)
      onBusyChange(false)
    }
  }
  const download = formatMeetingLanguageFirstUseDownload(
    availability?.languageStates?.[preparing ?? language]?.firstUseDownloadBytes ?? 0
  )
  const setupLabel = getWhisperSetupLabel(status, t)

  return (
    <AnnouncementRow
      icon="microphone"
      headingId="announcement-meeting-language"
      title={t('settings.meetingLanguage')}
      control={
        <MeetingLanguagePicker
          value={language}
          onChange={(next) => void choose(next)}
          disabled={!availability || !!preparing}
          availability={availability ?? undefined}
          offline={!online}
        />
      }
    >
      <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">
        {t('announcement.meetingLanguageBody', { count: MEETING_LANGUAGE_DEFINITIONS.length })}
      </p>
      <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">
        {t('announcement.meetingLanguageDescription')}
      </p>
      {download && <p className="mt-2 text-[12px] text-ink-muted">{download}</p>}
      {setupLabel && (
        <p role="status" className="mt-2 text-[12px] text-ink-muted">
          {setupLabel}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-[12px] text-clay-dark">
          {t(error, { language: meetingLanguageName(errorLanguage) })}
        </p>
      )}
      {!availability && error && (
        <button
          type="button"
          onClick={() => setRetry((current) => current + 1)}
          className="mt-2 rounded-lg px-3 py-2 text-[12px] font-medium text-sage-dark hover:bg-bg-accent focus-visible:outline-2 focus-visible:outline-sage"
        >
          {t('ui.retry')}
        </button>
      )}
    </AnnouncementRow>
  )
}
