import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { MEETING_LANGUAGE_DEFINITIONS } from '../../../shared/meeting-language'
import { ROUTES } from '../../../shared/constants'

export function MeetingLanguageAnnouncement({
  suppressed,
  onVisibilityChange
}: {
  suppressed: boolean
  onVisibilityChange: (visible: boolean) => void
}) {
  const navigate = useNavigate()
  const dialog = useRef<HTMLDialogElement>(null)
  const chooseButton = useRef<HTMLButtonElement>(null)
  const [pending, setPending] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const visible = pending && !suppressed

  useEffect(() => {
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
  }, [])

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
    setError(null)
    try {
      await window.electronAPI.invoke('prefs:dismiss-meeting-language-announcement')
      setPending(false)
      if (chooseLanguage) navigate(`${ROUTES.settings}?section=meeting-language`)
    } catch {
      setError('Could not save this preference. Try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <dialog
      ref={dialog}
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
        Your meetings, in your language
      </h2>
      <p
        id="meeting-language-announcement-body"
        className="mt-3 text-[14px] leading-relaxed text-ink-secondary"
      >
        AutoDoc now supports {MEETING_LANGUAGE_DEFINITIONS.length} meeting languages. Choose the
        language spoken in your meetings in Settings. New transcripts and notes will use that
        language.
      </p>
      <p className="mt-3 text-[12px] leading-relaxed text-ink-muted">
        Changing languages may need a one-time speech model download.
      </p>
      {error && (
        <p role="alert" className="mt-3 text-[12px] text-clay-dark">
          {error}
        </p>
      )}
      <div className="mt-6 flex justify-end gap-3">
        <button
          type="button"
          disabled={saving}
          onClick={() => void dismiss(false)}
          className="rounded-lg px-4 py-2 text-[13px] font-medium text-ink-muted hover:bg-bg-accent focus-visible:outline-2 focus-visible:outline-sage-dark disabled:opacity-50"
        >
          Got it
        </button>
        <button
          type="button"
          ref={chooseButton}
          disabled={saving}
          onClick={() => void dismiss(true)}
          className="rounded-lg bg-sage-dark px-4 py-2 text-[13px] font-semibold text-white hover:bg-sage-dark/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sage-dark disabled:opacity-50"
        >
          Choose language
        </button>
      </div>
    </dialog>
  )
}
