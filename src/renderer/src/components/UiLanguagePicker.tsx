import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
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
  const [active, setActive] = useState(0)
  const [placement, setPlacement] = useState({ above: false, maxHeight: 256 })
  const listboxId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])

  useEffect(() => {
    if (!open) return
    optionRefs.current[active]?.focus({ preventScroll: true })
    optionRefs.current[active]?.scrollIntoView?.({ block: 'nearest' })
  }, [active, open])

  useEffect(() => {
    if (!open) return
    const fit = () => {
      const trigger = triggerRef.current
      if (!trigger) return
      let top = 0
      let bottom = window.innerHeight
      for (let parent = trigger.parentElement; parent; parent = parent.parentElement) {
        if (/(auto|scroll|hidden)/.test(getComputedStyle(parent).overflowY)) {
          const rect = parent.getBoundingClientRect()
          top = Math.max(top, rect.top)
          bottom = Math.min(bottom, rect.bottom)
        }
      }
      const rect = trigger.getBoundingClientRect()
      const below = bottom - rect.bottom - 12
      const above = rect.top - top - 12
      const openAbove = below < 256 && above > below
      setPlacement({
        above: openAbove,
        maxHeight: Math.max(32, Math.min(256, openAbove ? above : below))
      })
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    fit()
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('resize', fit)
    // A scrolling settings panel changes the space available to the list.
    window.addEventListener('scroll', fit, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('resize', fit)
      window.removeEventListener('scroll', fit, true)
    }
  }, [open])

  const close = () => {
    setOpen(false)
    triggerRef.current?.focus({ preventScroll: true })
  }
  const show = () => {
    setActive(Math.max(0, UI_LANGUAGE_CODES.indexOf(value)))
    setOpen(true)
  }
  const select = (language: UiLanguageCode) => {
    onChange(language)
    close()
  }
  const onOptionKeyDown = (event: KeyboardEvent, index: number) => {
    const move = (next: number) => {
      event.preventDefault()
      setActive(next)
    }
    if (event.key === 'ArrowDown') move((index + 1) % UI_LANGUAGE_CODES.length)
    else if (event.key === 'ArrowUp')
      move((index - 1 + UI_LANGUAGE_CODES.length) % UI_LANGUAGE_CODES.length)
    else if (event.key === 'Home') move(0)
    else if (event.key === 'End') move(UI_LANGUAGE_CODES.length - 1)
    else if (event.key === 'Escape') {
      event.preventDefault()
      close()
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      select(UI_LANGUAGE_CODES[index])
    }
  }

  return (
    <div
      ref={rootRef}
      className="i18n-setting-control relative min-w-0 max-w-full"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false)
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        onClick={() => (open ? close() : show())}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            show()
          } else if (event.key === 'Escape' && open) {
            event.preventDefault()
            close()
          }
        }}
        className="flex min-w-[8rem] max-w-full items-center justify-between gap-3 rounded-lg border border-border-subtle bg-bg-card px-3 py-2 text-left text-[12px] font-medium leading-snug text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage"
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
          style={{ maxHeight: placement.maxHeight }}
          className={`absolute right-0 z-50 w-56 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-border bg-bg-card p-1.5 shadow-lg ${placement.above ? 'bottom-full mb-1.5' : 'top-full mt-1.5'}`}
        >
          {UI_LANGUAGE_CODES.map((code, index) => (
            <button
              key={code}
              ref={(node) => {
                optionRefs.current[index] = node
              }}
              type="button"
              role="option"
              aria-selected={code === value}
              tabIndex={index === active ? 0 : -1}
              onClick={() => select(code)}
              onKeyDown={(event) => onOptionKeyDown(event, index)}
              className={`flex w-full rounded-lg px-3 py-2 text-left text-[12px] leading-snug [overflow-wrap:anywhere] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sage ${code === value ? 'bg-bg-accent font-semibold text-ink' : 'text-ink-muted hover:bg-bg-accent'}`}
            >
              {UI_LANGUAGE_NATIVE_LABELS[code]}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
