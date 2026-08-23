import { useCallback, useEffect, useId, useRef, useState, type ReactElement } from 'react'
import type {
  MeetingExportFormat,
  MeetingExportResult,
  MeetingExportVariant
} from '../../../shared/types'

export interface MeetingExportMenuProps {
  disabled: boolean
  disabledReason?: string
  onExport: (
    format: MeetingExportFormat,
    variant: MeetingExportVariant
  ) => Promise<MeetingExportResult>
}

type ExportFeedback =
  | { kind: 'saved'; message: 'Exported' }
  | { kind: 'failed'; message: string }
  | null

interface ExportFormatOption {
  format: MeetingExportFormat
  label: string
  extension: string
  description: string
}

const EXPORT_FORMATS: readonly ExportFormatOption[] = [
  { format: 'pdf', label: 'PDF', extension: '.pdf', description: 'Best for sharing' },
  { format: 'docx', label: 'Word', extension: '.docx', description: 'Editable document' },
  { format: 'markdown', label: 'Markdown', extension: '.md', description: 'Plain text' }
]

const SUCCESS_VISIBLE_MS = 2_400

function failureMessage(result: Extract<MeetingExportResult, { status: 'failed' }>): string {
  switch (result.code) {
    case 'disk-full':
      return 'Not enough disk space to export. Choose another location or free up space.'
    case 'nothing-to-export':
      return 'There’s nothing ready to export for this meeting.'
    case 'permission-denied':
      return 'AutoDoc couldn’t save to that location. Choose another location and try again.'
    case 'invalid-request':
    case 'render-failed':
    case 'write-failed':
      return 'AutoDoc couldn’t export this meeting. Try again.'
  }
}

function DownloadIcon(): ReactElement {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 16 16" fill="none" className="size-3.5">
      <path
        d="M8 2.25v7.1m0 0 2.55-2.55M8 9.35 5.45 6.8M3 11.5v1.25h10V11.5"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function CheckIcon(): ReactElement {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 16 16" fill="none" className="size-3.5">
      <path
        d="m3.4 8.2 2.7 2.7 6.5-6.3"
        stroke="currentColor"
        strokeWidth="1.55"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function MeetingExportMenu({
  disabled,
  disabledReason,
  onExport
}: MeetingExportMenuProps): ReactElement {
  const [open, setOpen] = useState(false)
  const [variant, setVariant] = useState<MeetingExportVariant>('full')
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<ExportFeedback>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const fullVariantRef = useRef<HTMLButtonElement>(null)
  const busyRef = useRef(false)
  const successTimerRef = useRef<number | null>(null)
  const dialogId = useId()
  const headingId = useId()
  const descriptionId = useId()
  const disabledReasonId = useId()

  const clearSuccessTimer = useCallback((): void => {
    if (successTimerRef.current == null) return
    window.clearTimeout(successTimerRef.current)
    successTimerRef.current = null
  }, [])

  const restoreTriggerFocus = useCallback((): void => {
    window.setTimeout(() => triggerRef.current?.focus(), 0)
  }, [])

  const closeAndRestoreFocus = useCallback((): void => {
    setOpen(false)
    restoreTriggerFocus()
  }, [restoreTriggerFocus])

  useEffect(() => {
    if (!open) return
    fullVariantRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return

    const handleOutsideClick = (event: MouseEvent): void => {
      if (rootRef.current?.contains(event.target as Node)) return
      setOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      closeAndRestoreFocus()
    }

    document.addEventListener('click', handleOutsideClick)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('click', handleOutsideClick)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [closeAndRestoreFocus, open])

  useEffect(() => {
    if (!disabled || !open) return
    setOpen(false)
  }, [disabled, open])

  useEffect(() => {
    return () => clearSuccessTimer()
  }, [clearSuccessTimer])

  const handleTriggerClick = (): void => {
    if (disabled || busyRef.current) return
    if (open) {
      setOpen(false)
      return
    }
    clearSuccessTimer()
    setFeedback(null)
    setVariant('full')
    setOpen(true)
  }

  const handleExport = async (format: MeetingExportFormat): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    clearSuccessTimer()
    setFeedback(null)
    setOpen(false)
    setBusy(true)

    try {
      const result = await onExport(format, variant)
      if (result.status === 'saved') {
        setFeedback({ kind: 'saved', message: 'Exported' })
        successTimerRef.current = window.setTimeout(() => {
          setFeedback(null)
          successTimerRef.current = null
        }, SUCCESS_VISIBLE_MS)
      } else if (result.status === 'failed') {
        setFeedback({ kind: 'failed', message: failureMessage(result) })
      }
    } catch {
      setFeedback({ kind: 'failed', message: 'AutoDoc couldn’t export this meeting. Try again.' })
    } finally {
      busyRef.current = false
      setBusy(false)
      restoreTriggerFocus()
    }
  }

  const triggerLabel = busy ? 'Exporting…' : feedback?.kind === 'saved' ? 'Exported' : 'Export'
  const variantDescription =
    variant === 'full'
      ? 'Every stored note and transcript detail.'
      : 'A polished summary for sharing.'

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled || busy}
        title={disabled ? disabledReason : undefined}
        aria-busy={busy}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
        aria-describedby={disabled && disabledReason ? disabledReasonId : undefined}
        onClick={handleTriggerClick}
        className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11.5px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/50 disabled:cursor-not-allowed disabled:opacity-45 ${
          feedback?.kind === 'saved'
            ? 'border-sage/25 bg-sage-light text-sage-dark'
            : 'border-border bg-bg-card text-ink-muted hover:border-border-strong hover:text-ink'
        }`}
      >
        {feedback?.kind === 'saved' && !busy ? <CheckIcon /> : <DownloadIcon />}
        <span>{triggerLabel}</span>
        {!busy && feedback?.kind !== 'saved' ? (
          <svg
            aria-hidden="true"
            focusable="false"
            viewBox="0 0 12 12"
            fill="none"
            className={`size-2.5 transition-transform ${open ? 'rotate-180' : ''}`}
          >
            <path
              d="m3 4.5 3 3 3-3"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : null}
      </button>

      {disabled && disabledReason ? (
        <span id={disabledReasonId} className="sr-only">
          {disabledReason}
        </span>
      ) : null}

      {open ? (
        <div
          id={dialogId}
          role="dialog"
          aria-modal="false"
          aria-labelledby={headingId}
          aria-describedby={descriptionId}
          aria-busy={busy}
          className="absolute right-0 top-full z-50 mt-1.5 w-72 rounded-xl border border-border bg-bg-card p-3 shadow-lg"
        >
          <h2 id={headingId} className="text-[12px] font-semibold text-ink">
            Export meeting
          </h2>
          <p id={descriptionId} className="mt-0.5 text-[10.5px] leading-4 text-ink-faint">
            Choose how much detail to include, then a file format.
          </p>

          <div
            role="group"
            aria-label="Export detail"
            className="mt-3 flex rounded-lg border border-border bg-bg-card p-0.5"
          >
            {(['full', 'concise'] as const).map((value) => (
              <button
                key={value}
                ref={value === 'full' ? fullVariantRef : undefined}
                type="button"
                aria-pressed={variant === value}
                onClick={() => setVariant(value)}
                className={`flex-1 rounded-md px-2.5 py-1 text-[11.5px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/50 ${
                  variant === value
                    ? 'bg-ink text-white'
                    : 'text-ink-muted hover:bg-bg-accent hover:text-ink'
                }`}
              >
                {value === 'full' ? 'Full' : 'Concise'}
              </button>
            ))}
          </div>
          <p className="mt-1.5 min-h-4 text-[10.5px] leading-4 text-ink-faint">
            {variantDescription}
          </p>

          <div className="mt-2 flex flex-col gap-1 border-t border-border-subtle pt-2">
            {EXPORT_FORMATS.map((option) => (
              <button
                key={option.format}
                type="button"
                onClick={() => void handleExport(option.format)}
                className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/50 disabled:cursor-wait disabled:opacity-50"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-[12px] font-medium text-ink">{option.label}</span>
                  <span className="block text-[10.5px] text-ink-faint">{option.description}</span>
                </span>
                <span className="font-mono text-[10px] text-ink-faint">{option.extension}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {feedback?.kind === 'saved' ? (
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="absolute right-0 top-full z-50 mt-1.5 inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-sage/25 bg-sage-light px-3 py-2 text-[11.5px] font-medium text-sage-dark shadow-sm"
        >
          <CheckIcon />
          Exported
        </div>
      ) : null}

      {feedback?.kind === 'failed' ? (
        <div
          role="alert"
          className="absolute right-0 top-full z-50 mt-1.5 flex w-72 items-start gap-2 rounded-xl border border-clay/25 bg-clay-light px-3 py-2.5 text-[11.5px] leading-relaxed text-clay-dark shadow-sm"
        >
          <span className="min-w-0 flex-1">{feedback.message}</span>
          <button
            type="button"
            aria-label="Dismiss export error"
            onClick={() => setFeedback(null)}
            className="flex size-5 shrink-0 items-center justify-center rounded text-[15px] leading-none text-clay-dark/70 transition-colors hover:bg-white/50 hover:text-clay-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay/40"
          >
            ×
          </button>
        </div>
      ) : null}
    </div>
  )
}
