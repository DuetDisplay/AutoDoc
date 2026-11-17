import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useI18n } from '../services/i18n'

// One-time heads-up on the first visit to Ask AI. It waits for any other dialog to close.
export function AskAiBetaNotice({ onClosed }: { onClosed: () => void }): ReactElement | null {
  const { t } = useI18n()
  const dialog = useRef<HTMLDialogElement>(null)
  const [pending, setPending] = useState(false)
  const [otherModalOpen, setOtherModalOpen] = useState(false)
  const visible = pending && !otherModalOpen

  useEffect(() => {
    let active = true
    void window.electronAPI.invoke('prefs:get-ask-ai-beta-notice-pending').then(
      (value) => {
        if (active) setPending(value === true)
      },
      () => {}
    )
    const check = () =>
      setOtherModalOpen(
        Array.from(document.querySelectorAll('dialog[open], [role="dialog"]')).some(
          (element) => element !== dialog.current
        )
      )
    const observer = new MutationObserver(check)
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['open', 'role']
    })
    check()
    return () => {
      active = false
      observer.disconnect()
    }
  }, [])

  useEffect(() => {
    const element = dialog.current
    if (!visible || !element) return
    element.showModal()
    return () => element.close()
  }, [visible])

  const dismiss = async () => {
    try {
      await window.electronAPI.invoke('prefs:dismiss-ask-ai-beta-notice')
    } catch {
      // Not saving only means it may reappear next time; it still closes for this session.
    }
    dialog.current?.close()
    setPending(false)
    onClosed()
  }

  if (!pending) return null
  return (
    <dialog
      ref={dialog}
      data-ask-ai-beta-notice
      aria-labelledby="ask-ai-beta-title"
      aria-describedby="ask-ai-beta-body"
      onCancel={(event) => {
        event.preventDefault()
        void dismiss()
      }}
      className="fixed inset-0 m-auto max-h-[calc(100%-32px)] w-[400px] max-w-[calc(100%-32px)] flex-col overflow-y-auto rounded-2xl border border-border bg-bg-card p-6 text-ink shadow-xl backdrop:bg-ink/20 open:flex"
    >
      <h2
        id="ask-ai-beta-title"
        className="text-[16px] font-semibold tracking-[-0.02em] text-pretty [overflow-wrap:anywhere]"
      >
        {t('askAi.betaNoticeTitle')}
      </h2>
      <p
        id="ask-ai-beta-body"
        className="mt-2 text-[13px] leading-relaxed text-ink-secondary text-pretty [overflow-wrap:anywhere]"
      >
        {t('askAi.betaNoticeBody')}
      </p>
      <div className="mt-5 flex justify-end">
        <button
          type="button"
          autoFocus
          onClick={() => void dismiss()}
          className="i18n-btn rounded-lg bg-sage-dark px-4 py-2 text-[13px] font-semibold text-on-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sage"
        >
          {t('ui.gotIt')}
        </button>
      </div>
    </dialog>
  )
}
