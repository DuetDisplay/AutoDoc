import { createPortal } from 'react-dom'
import { useEffect, useId, useRef, useState } from 'react'
import { useAnchoredPopover } from '../hooks/useAnchoredPopover'
import { useT } from '../services/i18n'

/** Passive status line shown while a recording is transcribed on the CPU instead of the GPU. */
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
    <div className="mb-3 flex items-center gap-1.5 text-[11.5px] text-ink-muted">
      <span role="status">{t('ui.usingCPUForThisRecordingSoItWillTakeLonger')}</span>
      <button
        ref={triggerRef}
        type="button"
        aria-label={t('ui.whyIsThisTakingLonger')}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
        onClick={() => setOpen((current) => !current)}
        className="flex size-5 shrink-0 items-center justify-center rounded-full text-ink-faint transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage"
      >
        <svg
          aria-hidden="true"
          focusable="false"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          className="size-3.5"
        >
          <circle cx="8" cy="8" r="6.25" />
          <path d="M8 7.25v3.5M8 5h.01" />
        </svg>
      </button>
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
