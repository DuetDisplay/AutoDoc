import { createPortal } from 'react-dom'
import { useEffect, useId, useRef, useState } from 'react'
import { useAnchoredPopover } from '../hooks/useAnchoredPopover'
import { useT } from '../services/i18n'

/** Informational card shown while a recording is transcribed on the CPU instead of the GPU. */
export function CpuFallbackNotice() {
  const t = useT()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const placement = useAnchoredPopover(open, triggerRef, 288, 320, 'start')
  const headingId = useId()
  const bodyId = useId()
  const dialogId = useId()

  useEffect(() => {
    if (!open) return
    const handleOutsideClick = (event: MouseEvent): void => {
      const target = event.target as Node
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return
      setOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('click', handleOutsideClick)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('click', handleOutsideClick)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  return (
    <div
      className="app-banner mx-6 mt-3 mb-0 rounded-xl border border-sage/20 bg-bg-card px-4 py-3 shadow-sm"
      role="status"
    >
      <div className="app-banner-row">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-sage/20 bg-sage-light text-sage">
          <svg
            aria-hidden="true"
            focusable="false"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-4 w-4"
          >
            <rect x="5.5" y="5.5" width="9" height="9" rx="1.75" />
            <path d="M8.5 2.75v2.75M11.5 2.75v2.75M8.5 14.5v2.75M11.5 14.5v2.75M2.75 8.5h2.75M2.75 11.5h2.75M14.5 8.5h2.75M14.5 11.5h2.75" />
          </svg>
        </div>
        <div className="app-banner-copy">
          <h2 className="text-[12.5px] font-semibold text-ink">
            {t('ui.usingCPUForThisRecording')}
          </h2>
          <p className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
            {t('ui.thisTranscriptionWillTakeLongerThanUsual')}
          </p>
        </div>
        <div className="app-banner-actions">
          <button
            ref={triggerRef}
            type="button"
            aria-label={t('ui.whyIsThisTakingLonger')}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-controls={open ? dialogId : undefined}
            onClick={() => setOpen((current) => !current)}
            className="i18n-btn text-[12px] font-semibold text-sage transition-colors hover:text-sage-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage"
          >
            {t('ui.why')}
          </button>
        </div>
      </div>
      {open
        ? createPortal(
            <div
              ref={panelRef}
              style={placement}
              id={dialogId}
              role="dialog"
              aria-modal="false"
              aria-labelledby={headingId}
              aria-describedby={bodyId}
              className="z-50 overflow-y-auto rounded-xl border border-border bg-bg-card p-3 shadow-lg"
            >
              <h2 id={headingId} className="text-[12px] font-semibold text-ink">
                {t('ui.whyIsThisTakingLonger')}
              </h2>
              <p id={bodyId} className="mt-1 text-[11.5px] leading-relaxed text-ink-muted">
                {t('ui.autoDocUsuallyUsesYourGraphicsChipToTranscribeQuicklyThisTimeItCouldnT')}
              </p>
            </div>,
            document.body
          )
        : null}
    </div>
  )
}
