import { useT } from '../services/i18n'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { MEETING_LANGUAGE_DEFINITIONS } from '../../../shared/meeting-language'
import { ROUTES } from '../../../shared/constants'

export function MeetingLanguageAnnouncement({
  suppressed,
  onVisibilityChange,
  pending: queuedPending,
  onDismiss
}: {
  suppressed: boolean
  onVisibilityChange: (visible: boolean) => void
  pending?: boolean
  onDismiss?: () => void
}) {
  const t = useT()

  const navigate = useNavigate()
  const dialog = useRef<HTMLDialogElement>(null)
  const chooseButton = useRef<HTMLButtonElement>(null)
  const [pending, setPending] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(false)
  const visible = (queuedPending ?? pending) && !suppressed

  useEffect(() => {
    if (queuedPending !== undefined) return
    let active = true
    void window.electronAPI
      .invoke('prefs:get-meeting-language-announcement-pending')
      .then((value) => {
        if (active) setPending(value === true)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [queuedPending])

  useEffect(() => {
    const element = dialog.current
    if (visible && element && !element.open) {
      element.showModal()
      chooseButton.current?.focus()
    }
    if (!visible && element?.open) element.close()
    onVisibilityChange(visible)
    return () => onVisibilityChange(false)
  }, [visible, onVisibilityChange])

  const dismiss = async (chooseLanguage: boolean) => {
    if (saving) return
    setSaving(true)
    setError(false)
    try {
      await window.electronAPI.invoke('prefs:dismiss-meeting-language-announcement')
      setPending(false)
      onDismiss?.()
      if (chooseLanguage) navigate(`${ROUTES.settings}?section=meeting-language`)
    } catch {
      setError(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <dialog
      ref={dialog}
      data-announcement="meeting-language"
      aria-labelledby="meeting-language-announcement-title"
      aria-describedby="meeting-language-announcement-body"
      onCancel={(event) => {
        event.preventDefault()
        void dismiss(false)
      }}
      className="fixed inset-0 m-auto w-[420px] max-w-[calc(100%-48px)] rounded-2xl border border-border bg-bg-card p-7 text-ink shadow-xl backdrop:bg-ink/20"
    >
      <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-sage-dark">
        New
      </p>
      <h2 id="meeting-language-announcement-title" className="text-[24px] font-serif leading-tight">
        {t('ui.yourMeetingsInYourLanguage')}
      </h2>
      <p
        id="meeting-language-announcement-body"
        className="mt-3 text-[14px] leading-relaxed text-ink-secondary"
      >
        {t('ui.autoDocNowSupportsCountMeetingLanguagesChooseTheLanguageSpokenInYourMeeting', {
          count: MEETING_LANGUAGE_DEFINITIONS.length
        })}
      </p>
      <p className="mt-3 text-[12px] leading-relaxed text-ink-muted">
        {t('ui.changingLanguagesMayNeedAOneTimeSpeechModelDownload')}
      </p>
      {error && (
        <p role="alert" className="mt-3 text-[12px] text-clay-dark">
          {t('ui.couldNotSaveThisPreferenceTryAgain')}
        </p>
      )}
      <div className="mt-6 flex justify-end gap-3">
        <button
          type="button"
          disabled={saving}
          onClick={() => void dismiss(false)}
          className="rounded-lg px-4 py-2 text-[13px] font-medium text-ink-muted hover:bg-bg-accent focus-visible:outline-2 focus-visible:outline-sage-dark disabled:opacity-50"
        >
          {t('ui.gotIt')}
        </button>
        <button
          type="button"
          ref={chooseButton}
          disabled={saving}
          onClick={() => void dismiss(true)}
          className="i18n-btn rounded-lg bg-sage-dark px-4 py-2 text-[13px] font-semibold text-on-brand hover:bg-sage-dark/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sage-dark disabled:opacity-50"
        >
          {t('ui.chooseLanguage')}
        </button>
      </div>
    </dialog>
  )
}
