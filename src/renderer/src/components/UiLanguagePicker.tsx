import { useEffect, useId, useRef, useState } from 'react'
import {
  UI_LANGUAGE_CODES,
  UI_LANGUAGE_NATIVE_LABELS,
  type UiLanguageCode
} from '../../../shared/ui-language'

interface UiLanguagePickerProps {
  value: UiLanguageCode
  onChange: (language: UiLanguageCode) => void
  label: string
}

export function UiLanguagePicker({ value, onChange, label }: UiLanguagePickerProps) {
  const [open, setOpen] = useState(false)
  const listboxId = useId()
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  return (
    <div ref={rootRef} className="i18n-setting-control relative min-w-0 max-w-full">
      <button
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        onClick={() => setOpen((current) => !current)}
        className="flex min-w-[8rem] max-w-full items-center justify-between gap-3 rounded-lg border border-border-subtle bg-bg-card px-3 py-2 text-left text-[12px] font-medium leading-snug text-ink"
      >
        <span className="min-w-0 text-pretty [overflow-wrap:anywhere]">
          {UI_LANGUAGE_NATIVE_LABELS[value]}
        </span>
      </button>
      {open && (
        <div
          id={listboxId}
          role="listbox"
          aria-label={label}
          className="absolute right-0 z-50 mt-1.5 max-h-64 w-56 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-border bg-bg-card p-1.5 shadow-lg"
        >
          {UI_LANGUAGE_CODES.map((code) => (
            <button
              key={code}
              type="button"
              role="option"
              aria-selected={code === value}
              onClick={() => {
                onChange(code)
                setOpen(false)
              }}
              className={`flex w-full rounded-lg px-3 py-2 text-left text-[12px] leading-snug [overflow-wrap:anywhere] ${
                code === value ? 'bg-bg-accent font-semibold text-ink' : 'text-ink-muted hover:bg-bg-accent'
              }`}
            >
              {UI_LANGUAGE_NATIVE_LABELS[code]}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
