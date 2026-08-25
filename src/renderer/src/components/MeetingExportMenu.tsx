import { useCallback, useEffect, useId, useRef, useState, type ReactElement } from 'react'
import type {
  MeetingCopyNotesResult,
  MeetingExportFormat,
  MeetingExportResult
} from '../../../shared/types'

export interface MeetingExportMenuProps {
  disabled: boolean
  disabledReason?: string
  onCopyNotes: () => Promise<MeetingCopyNotesResult>
  onExport: (format: MeetingExportFormat) => Promise<MeetingExportResult>
}

type Action = 'copy' | 'export'

type ActionFeedback =
  | { action: Action; kind: 'success'; message: 'Copied' | 'Exported' }
  | { action: Action; kind: 'failed'; message: string }
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

function exportFailureMessage(result: Extract<MeetingExportResult, { status: 'failed' }>): string {
  switch (result.code) {
    case 'disk-full':
      return 'Not enough disk space to export. Choose another location or free up space.'
    case 'nothing-to-export':
      return 'There aren’t any notes to export yet.'
    case 'permission-denied':
      return 'AutoDoc couldn’t save the notes there. Choose another location and try again.'
    case 'invalid-request':
    case 'render-failed':
    case 'write-failed':
      return 'Couldn’t export notes. Try again.'
  }
}

function copyFailureMessage(result: Extract<MeetingCopyNotesResult, { status: 'failed' }>): string {
  return result.code === 'nothing-to-copy'
    ? 'There aren’t any notes to copy yet.'
    : 'Couldn’t copy notes. Try again.'
}

function CopyIcon(): ReactElement {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 16 16" fill="none" className="size-3.5">
      <rect
        x="5.25"
        y="4.75"
        width="7"
        height="7"
        rx="1.25"
        stroke="currentColor"
        strokeWidth="1.25"
      />
      <path
        d="M10.25 4.75V3.5c0-.7-.55-1.25-1.25-1.25H3.5c-.7 0-1.25.55-1.25 1.25V9c0 .7.55 1.25 1.25 1.25h1.75"
        stroke="currentColor"
        strokeWidth="1.25"
      />
    </svg>
  )
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
  onCopyNotes,
  onExport
}: MeetingExportMenuProps): ReactElement {
  const [open, setOpen] = useState(false)
  const [busyAction, setBusyAction] = useState<Action | null>(null)
  const [feedback, setFeedback] = useState<ActionFeedback>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const copyTriggerRef = useRef<HTMLButtonElement>(null)
  const exportTriggerRef = useRef<HTMLButtonElement>(null)
  const firstFormatRef = useRef<HTMLButtonElement>(null)
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

  const showSuccess = useCallback((action: Action, message: 'Copied' | 'Exported'): void => {
    setFeedback({ action, kind: 'success', message })
    successTimerRef.current = window.setTimeout(() => {
      setFeedback(null)
      successTimerRef.current = null
    }, SUCCESS_VISIBLE_MS)
  }, [])

  const restoreFocus = useCallback((action: Action): void => {
    window.setTimeout(() => {
      if (action === 'copy') copyTriggerRef.current?.focus()
      else exportTriggerRef.current?.focus()
    }, 0)
  }, [])

  const closeAndRestoreExportFocus = useCallback((): void => {
    setOpen(false)
    restoreFocus('export')
  }, [restoreFocus])

  useEffect(() => {
    if (open) firstFormatRef.current?.focus()
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
      closeAndRestoreExportFocus()
    }

    document.addEventListener('click', handleOutsideClick)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('click', handleOutsideClick)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [closeAndRestoreExportFocus, open])

  useEffect(() => {
    if (disabled && open) setOpen(false)
  }, [disabled, open])

  useEffect(() => {
    return () => clearSuccessTimer()
  }, [clearSuccessTimer])

  const beginAction = (action: Action): boolean => {
    if (disabled || busyRef.current) return false
    busyRef.current = true
    clearSuccessTimer()
    setFeedback(null)
    setOpen(false)
    setBusyAction(action)
    return true
  }

  const finishAction = (action: Action): void => {
    busyRef.current = false
    setBusyAction(null)
    restoreFocus(action)
  }

  const handleCopy = async (): Promise<void> => {
    if (!beginAction('copy')) return
    try {
      const result = await onCopyNotes()
      if (result.status === 'copied') showSuccess('copy', 'Copied')
      else setFeedback({ action: 'copy', kind: 'failed', message: copyFailureMessage(result) })
    } catch {
      setFeedback({ action: 'copy', kind: 'failed', message: 'Couldn’t copy notes. Try again.' })
    } finally {
      finishAction('copy')
    }
  }

  const handleExport = async (format: MeetingExportFormat): Promise<void> => {
    if (!beginAction('export')) return
    try {
      const result = await onExport(format)
      if (result.status === 'saved') showSuccess('export', 'Exported')
      else if (result.status === 'failed') {
        setFeedback({ action: 'export', kind: 'failed', message: exportFailureMessage(result) })
      }
    } catch {
      setFeedback({
        action: 'export',
        kind: 'failed',
        message: 'Couldn’t export notes. Try again.'
      })
    } finally {
      finishAction('export')
    }
  }

  const handleExportTriggerClick = (): void => {
    if (disabled || busyRef.current) return
    if (open) {
      setOpen(false)
      return
    }
    clearSuccessTimer()
    setFeedback(null)
    setOpen(true)
  }

  const copySucceeded = feedback?.kind === 'success' && feedback.action === 'copy'
  const exportSucceeded = feedback?.kind === 'success' && feedback.action === 'export'
  const copyLabel = busyAction === 'copy' ? 'Copying…' : copySucceeded ? 'Copied' : 'Copy notes'
  const exportLabel =
    busyAction === 'export' ? 'Exporting…' : exportSucceeded ? 'Exported' : 'Export'
  const controlsDisabled = disabled || busyAction !== null
  const baseButtonClass =
    'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11.5px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/50 disabled:cursor-not-allowed disabled:opacity-45'
  const normalButtonClass =
    'border-border bg-bg-card text-ink-muted hover:border-border-strong hover:text-ink'
  const successButtonClass = 'border-sage/25 bg-sage-light text-sage-dark'

  return (
    <div ref={rootRef} className="relative flex items-center gap-1.5">
      <button
        ref={copyTriggerRef}
        type="button"
        disabled={controlsDisabled}
        title={disabled ? disabledReason : undefined}
        aria-busy={busyAction === 'copy'}
        aria-describedby={disabled && disabledReason ? disabledReasonId : undefined}
        onClick={() => void handleCopy()}
        className={`${baseButtonClass} ${copySucceeded ? successButtonClass : normalButtonClass}`}
      >
        {copySucceeded ? <CheckIcon /> : <CopyIcon />}
        <span>{copyLabel}</span>
      </button>

      <button
        ref={exportTriggerRef}
        type="button"
        disabled={controlsDisabled}
        title={disabled ? disabledReason : undefined}
        aria-busy={busyAction === 'export'}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
        aria-describedby={disabled && disabledReason ? disabledReasonId : undefined}
        onClick={handleExportTriggerClick}
        className={`${baseButtonClass} ${exportSucceeded ? successButtonClass : normalButtonClass}`}
      >
        {exportSucceeded ? <CheckIcon /> : <DownloadIcon />}
        <span>{exportLabel}</span>
        {busyAction !== 'export' && !exportSucceeded ? (
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
          className="absolute right-0 top-full z-50 mt-1.5 w-64 rounded-xl border border-border bg-bg-card p-3 shadow-lg"
        >
          <h2 id={headingId} className="text-[12px] font-semibold text-ink">
            Export notes
          </h2>
          <p id={descriptionId} className="mt-0.5 text-[10.5px] leading-4 text-ink-faint">
            Choose a file format.
          </p>

          <div className="mt-2 flex flex-col gap-1 border-t border-border-subtle pt-2">
            {EXPORT_FORMATS.map((option, index) => (
              <button
                key={option.format}
                ref={index === 0 ? firstFormatRef : undefined}
                type="button"
                onClick={() => void handleExport(option.format)}
                className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/50"
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

      {feedback?.kind === 'success' ? (
        <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
          {feedback.message}
        </span>
      ) : null}

      {feedback?.kind === 'failed' ? (
        <div
          role="alert"
          className="absolute right-0 top-full z-50 mt-1.5 flex w-72 items-start gap-2 rounded-xl border border-clay/25 bg-clay-light px-3 py-2.5 text-[11.5px] leading-relaxed text-clay-dark shadow-sm"
        >
          <span className="min-w-0 flex-1">{feedback.message}</span>
          <button
            type="button"
            aria-label={`Dismiss ${feedback.action} error`}
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
