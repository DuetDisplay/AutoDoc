import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../services/i18n'
import { UiLanguagePicker } from './UiLanguagePicker'
import { AppearanceSwitch } from './AppearanceSwitch'
import type { UiLanguageCode } from '../../../shared/ui-language'
import { AnnouncementMeetingLanguage } from './AnnouncementMeetingLanguage'

export function UiAppearanceAnnouncement({
  visible,
  includeMeetingLanguage,
  onDismiss
}: {
  visible: boolean
  includeMeetingLanguage: boolean
  onDismiss: () => void
}) {
  const { t, language, setLanguage } = useI18n()
  const dialog = useRef<HTMLDialogElement>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(false)
  const [meetingLanguageBusy, setMeetingLanguageBusy] = useState(false)
  const busy = saving || meetingLanguageBusy
  useEffect(() => {
    const element = dialog.current
    if (!visible || !element) return
    // A native modal traps keyboard focus, makes the background inert, and restores focus on close.
    element.showModal()
    return () => element.close()
  }, [visible])
  const dismiss = async () => {
    if (busy) return
    setSaving(true)
    setError(false)
    try {
      await window.electronAPI.invoke('prefs:dismiss-ui-appearance-announcement')
      if (includeMeetingLanguage) {
        await window.electronAPI.invoke('prefs:dismiss-meeting-language-announcement')
      }
      onDismiss()
    } catch {
      setError(true)
    } finally {
      setSaving(false)
    }
  }
  const postpone = () => {
    if (!busy) onDismiss()
  }
  const chooseLanguage = async (next: UiLanguageCode) => {
    setError(false)
    try {
      await setLanguage(next)
    } catch {
      setError(true)
    }
  }
  return (
    <dialog
      ref={dialog}
      data-announcement="ui-appearance"
      aria-labelledby="ui-appearance-title"
      aria-describedby="ui-appearance-body"
      onCancel={(event) => {
        event.preventDefault()
        postpone()
      }}
      className="fixed inset-0 m-auto max-h-[calc(100%-32px)] w-[440px] max-w-[calc(100%-32px)] flex-col overflow-hidden rounded-2xl border border-border bg-bg-card text-ink shadow-xl backdrop:bg-ink/20 open:flex"
    >
      <h2
        id="ui-appearance-title"
        className="shrink-0 px-6 pt-6 font-sans text-[22px] font-semibold leading-tight tracking-[-0.02em] text-sage-dark"
      >
        {t('ui.new')}
      </h2>
      <div className="min-h-0 overflow-y-auto px-6">
        {includeMeetingLanguage && (
          <AnnouncementMeetingLanguage visible={visible} onBusyChange={setMeetingLanguageBusy} />
        )}
        <section className="mt-4" aria-labelledby="announcement-app-language">
          <h3 id="announcement-app-language" className="text-[13px] font-semibold">
            {t('uiLanguage.title')}
          </h3>
          <p
            id="ui-appearance-body"
            className="mt-1 text-[13px] leading-relaxed text-ink-secondary"
          >
            {t('announcement.uiLanguageBody')}
          </p>
          <div className="mt-3">
            <UiLanguagePicker
              value={language}
              onChange={(next) => void chooseLanguage(next)}
              label={t('uiLanguage.title')}
            />
          </div>
        </section>
        <section
          className="mt-4 flex items-center justify-between gap-4 border-t border-border-subtle pt-4"
          aria-labelledby="announcement-appearance"
        >
          <div>
            <h3 id="announcement-appearance" className="text-[13px] font-semibold">
              {t('appearance.title')}
            </h3>
            <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">
              {t('appearance.description')}
            </p>
          </div>
          <AppearanceSwitch />
        </section>
        {error && (
          <p role="alert" className="mt-3 text-[12px] text-clay-dark">
            {t('ui.couldNotSaveThisPreferenceTryAgain')}
          </p>
        )}
      </div>
      <div
        data-announcement-actions
        className="flex shrink-0 flex-wrap justify-end gap-2 px-6 pb-6 pt-5"
      >
        <button
          type="button"
          disabled={busy}
          onClick={postpone}
          className="i18n-btn rounded-lg px-4 py-2 text-[13px] font-medium text-ink-muted hover:bg-bg-accent focus-visible:outline-2 focus-visible:outline-sage disabled:opacity-50"
        >
          {t('ui.later')}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void dismiss()}
          className="i18n-btn rounded-lg bg-sage-dark px-4 py-2 text-[13px] font-semibold text-on-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sage disabled:opacity-50"
        >
          {t('announcement.done')}
        </button>
      </div>
    </dialog>
  )
}
