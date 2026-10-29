import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useI18n } from '../services/i18n'
import { UiLanguagePicker } from './UiLanguagePicker'
import { AppearanceSwitch } from './AppearanceSwitch'
import type { UiLanguageCode } from '../../../shared/ui-language'
import { ROUTES } from '../../../shared/constants'

export function UiAppearanceAnnouncement({
  visible,
  onDismiss
}: {
  visible: boolean
  onDismiss: () => void
}) {
  const { t, language, setLanguage } = useI18n()
  const navigate = useNavigate()
  const dialog = useRef<HTMLDialogElement>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(false)
  useEffect(() => {
    const element = dialog.current
    if (!visible || !element) return
    // A native modal traps keyboard focus, makes the background inert, and restores focus on close.
    element.showModal()
    return () => element.close()
  }, [visible])
  const dismiss = async (openSettings: boolean) => {
    if (saving) return
    setSaving(true)
    setError(false)
    try {
      await window.electronAPI.invoke('prefs:dismiss-ui-appearance-announcement')
      onDismiss()
      if (openSettings) navigate(ROUTES.settings)
    } catch {
      setError(true)
    } finally {
      setSaving(false)
    }
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
        void dismiss(false)
      }}
      className="fixed inset-0 m-auto max-h-[calc(100%-32px)] w-[440px] max-w-[calc(100%-32px)] overflow-y-auto rounded-2xl border border-border bg-bg-card p-6 text-ink shadow-xl backdrop:bg-ink/20"
    >
      <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-sage-dark">
        {t('ui.new')}
      </p>
      <h2 id="ui-appearance-title" className="text-[24px] font-serif leading-tight">
        {t('announcement.uiAppearanceTitle')}
      </h2>
      <p id="ui-appearance-body" className="mt-3 text-[14px] leading-relaxed text-ink-secondary">
        {t('announcement.uiLanguageBody')}
      </p>
      <div className="mt-4">
        <UiLanguagePicker
          value={language}
          onChange={(next) => void chooseLanguage(next)}
          label={t('uiLanguage.title')}
        />
      </div>
      <p className="mt-4 text-[14px] leading-relaxed text-ink-secondary">
        {t('announcement.darkModeBody')}
      </p>
      <div className="mt-2">
        <AppearanceSwitch />
      </div>
      {error && (
        <p role="alert" className="mt-3 text-[12px] text-clay-dark">
          {t('ui.couldNotSaveThisPreferenceTryAgain')}
        </p>
      )}
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          disabled={saving}
          onClick={() => void dismiss(true)}
          className="i18n-btn rounded-lg px-4 py-2 text-[13px] font-medium text-ink-muted hover:bg-bg-accent focus-visible:outline-2 focus-visible:outline-sage disabled:opacity-50"
        >
          {t('upcoming.openSettings')}
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => void dismiss(false)}
          className="i18n-btn rounded-lg bg-sage-dark px-4 py-2 text-[13px] font-semibold text-on-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sage disabled:opacity-50"
        >
          {t('announcement.done')}
        </button>
      </div>
    </dialog>
  )
}
