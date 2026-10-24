import type { MessageKey } from '../../../../shared/i18n'
import { useT } from '../../services/i18n'
import { useEffect, useState } from 'react'
import {
  defaultMeetingLanguageForLocale,
  normalizeMeetingLanguage,
  isMeetingLanguageAvailable,
  type MeetingLanguageAvailability,
  type MeetingLanguageCode
} from '../../../../shared/meeting-language'
import { MeetingLanguagePicker } from '../MeetingLanguagePicker'
import { loadMeetingLanguageAvailability } from '../../services/meeting-language-setup'
import { formatMeetingLanguageFirstUseDownload } from '../../services/format-bytes'
import { useOnlineStatus } from '../../hooks/useOnlineStatus'

export function MeetingLanguageStep({ onNext }: { onNext: () => void }) {
  const t = useT()

  const online = useOnlineStatus()
  const [availability, setAvailability] = useState<MeetingLanguageAvailability | null>(null)
  const [language, setLanguage] = useState<MeetingLanguageCode>('en')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<MessageKey | null>(null)

  const load = async () => {
    setError(null)
    try {
      const [available, saved, confirmed, locale] = await Promise.all([
        loadMeetingLanguageAvailability(),
        window.electronAPI.invoke('prefs:get-meeting-language'),
        window.electronAPI.invoke('prefs:get-onboarding-language-confirmed'),
        window.electronAPI.invoke('app:get-locale')
      ])
      const previous = normalizeMeetingLanguage(saved)
      setLanguage(
        confirmed && isMeetingLanguageAvailable(previous, available)
          ? previous
          : defaultMeetingLanguageForLocale(locale || navigator.language, available)
      )
      setAvailability(available)
    } catch {
      setError('ui.couldNotLoadMeetingLanguages')
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const continueSetup = async () => {
    setSaving(true)
    setError(null)
    try {
      await window.electronAPI.invoke('prefs:set-meeting-language', language)
      await window.electronAPI.invoke('prefs:confirm-onboarding-language')
      onNext()
    } catch {
      setError('settings.saveMeetingLanguageFailed')
    } finally {
      setSaving(false)
    }
  }

  const download = formatMeetingLanguageFirstUseDownload(
    availability?.languageStates?.[language]?.firstUseDownloadBytes ?? 0
  )
  return (
    <div className="text-center">
      <h2 className="text-[20px] font-bold text-ink tracking-[-0.02em] mb-2">
        {t('onboarding.chooseMeetingLanguage')}
      </h2>
      <p className="text-[14px] text-ink-muted leading-relaxed mb-7">
        {t('ui.chooseTheLanguageSpokenInYourMeetingsThisSetsTheSpeechModelWeDownloadNextYo')}
      </p>
      {availability && (
        <div className="flex justify-center mb-5">
          <MeetingLanguagePicker
            value={language}
            onChange={setLanguage}
            availability={availability}
            disabled={saving}
            offline={!online}
          />
        </div>
      )}
      {download && <p className="text-[12px] text-ink-faint mb-5">{download}</p>}
      {availability?.restricted && (
        <p className="text-[12px] text-ink-muted mb-5">
          {navigator.userAgent.includes('Windows')
            ? t('ui.languagesOtherThanEnglishNeedLargerAIModelsThanThisPCHasTheMemoryAndProcess')
            : t('ui.languagesOtherThanEnglishNeedLargerAIModelsThanThisMacS8GBOfMemoryCanRun')}
        </p>
      )}
      {error && (
        <p role="alert" className="text-[13px] text-clay-dark mb-5">
          {t(error)}
        </p>
      )}
      {!availability && error ? (
        <button
          onClick={() => void load()}
          className="i18n-btn px-6 py-2.5 bg-sage text-on-brand rounded-[10px] text-[14px] font-semibold"
        >
          {t('ui.retry')}
        </button>
      ) : (
        <button
          onClick={() => void continueSetup()}
          disabled={!availability || saving}
          className="i18n-btn px-6 py-2.5 bg-sage text-on-brand rounded-[10px] text-[14px] font-semibold hover:opacity-90 transition-opacity disabled:opacity-60"
        >
          {saving ? t('ui.saving') : availability ? t('ui.continue') : t('ui.loadingLanguages')}
        </button>
      )}
    </div>
  )
}
