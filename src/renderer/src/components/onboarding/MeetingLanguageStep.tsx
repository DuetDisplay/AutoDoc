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

export function MeetingLanguageStep({ onNext }: { onNext: () => void }) {
  const [availability, setAvailability] = useState<MeetingLanguageAvailability | null>(null)
  const [language, setLanguage] = useState<MeetingLanguageCode>('en')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load meeting languages.')
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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the meeting language.')
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
        Choose your meeting language
      </h2>
      <p className="text-[14px] text-ink-muted leading-relaxed mb-7">
        Choose the language spoken in your meetings. This sets the speech model we download next.
        You can change it later in Settings.
      </p>
      {availability && (
        <div className="flex justify-center mb-5">
          <MeetingLanguagePicker
            value={language}
            onChange={setLanguage}
            availability={availability}
            disabled={saving}
          />
        </div>
      )}
      {download && <p className="text-[12px] text-ink-faint mb-5">{download}</p>}
      {availability?.restricted && (
        <p className="text-[12px] text-ink-muted mb-5">
          {navigator.userAgent.includes('Windows')
            ? 'Languages other than English need larger AI models than this PC has the memory and processing power to run.'
            : 'Languages other than English need larger AI models than this Mac’s 8 GB of memory can run.'}
        </p>
      )}
      {error && (
        <p role="alert" className="text-[13px] text-clay-dark mb-5">
          {error}
        </p>
      )}
      {!availability && error ? (
        <button
          onClick={() => void load()}
          className="px-6 py-2.5 bg-sage text-white rounded-[10px] text-[14px] font-semibold"
        >
          Retry
        </button>
      ) : (
        <button
          onClick={() => void continueSetup()}
          disabled={!availability || saving}
          className="px-6 py-2.5 bg-sage text-white rounded-[10px] text-[14px] font-semibold hover:opacity-90 transition-opacity disabled:opacity-60"
        >
          {saving ? 'Saving…' : availability ? 'Continue' : 'Loading languages…'}
        </button>
      )}
    </div>
  )
}
