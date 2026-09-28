import { useEffect, useId, useRef, useState } from 'react'
import {
  getMeetingLanguageDefinition,
  MEETING_LANGUAGE_DEFINITIONS,
  type MeetingLanguageCode
} from '../../../shared/meeting-language'

interface MeetingLanguagePickerProps {
  value: MeetingLanguageCode
  onChange: (language: MeetingLanguageCode) => void
  disabled?: boolean
}

export function MeetingLanguagePicker({
  value,
  onChange,
  disabled = false
}: MeetingLanguagePickerProps) {
  const listboxId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [isOpen, setIsOpen] = useState(false)
  const selected = getMeetingLanguageDefinition(value)
  const selectedIndex = MEETING_LANGUAGE_DEFINITIONS.findIndex(
    (definition) => definition.code === selected.code
  )
  const [activeIndex, setActiveIndex] = useState(selectedIndex)

  useEffect(() => {
    if (!isOpen) return
    optionRefs.current[activeIndex]?.focus()
  }, [activeIndex, isOpen])

  useEffect(() => {
    if (!isOpen) return

    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [isOpen])

  const open = (index = selectedIndex) => {
    setActiveIndex(index)
    setIsOpen(true)
  }

  const close = (restoreTriggerFocus = false) => {
    setIsOpen(false)
    if (restoreTriggerFocus) {
      triggerRef.current?.focus()
    }
  }

  const select = (language: MeetingLanguageCode) => {
    if (language !== value) {
      onChange(language)
    }
    close(true)
  }

  const handleTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      open(selectedIndex)
      return
    }

    if (event.key === 'Escape' && isOpen) {
      event.preventDefault()
      close(true)
    }
  }

  const handleOptionKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number,
    language: MeetingLanguageCode
  ) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((index + 1) % MEETING_LANGUAGE_DEFINITIONS.length)
      return
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex(
        (index - 1 + MEETING_LANGUAGE_DEFINITIONS.length) % MEETING_LANGUAGE_DEFINITIONS.length
      )
      return
    }

    if (event.key === 'Home') {
      event.preventDefault()
      setActiveIndex(0)
      return
    }

    if (event.key === 'End') {
      event.preventDefault()
      setActiveIndex(MEETING_LANGUAGE_DEFINITIONS.length - 1)
      return
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      select(language)
      return
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      close(true)
    }
  }

  return (
    <div
      ref={rootRef}
      className="relative shrink-0"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setIsOpen(false)
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-label={`Meeting language: ${selected.label}`}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={listboxId}
        onClick={() => {
          if (isOpen) {
            close()
          } else {
            open()
          }
        }}
        onKeyDown={handleTriggerKeyDown}
        className="flex min-w-48 items-center justify-between gap-3 rounded-lg border border-border-subtle bg-bg-card px-3 py-2 text-left text-[12px] font-medium text-ink transition-colors hover:border-ink-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/50 disabled:cursor-wait disabled:opacity-60"
      >
        <span>{selected.label}</span>
        <svg
          aria-hidden="true"
          focusable="false"
          viewBox="0 0 16 16"
          fill="none"
          className={`size-3.5 text-ink-muted transition-transform ${isOpen ? 'rotate-180' : ''}`}
        >
          <path
            d="m4 6 4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {isOpen && (
        <div
          id={listboxId}
          role="listbox"
          aria-label="Meeting language options"
          className="absolute right-0 top-full z-50 mt-1.5 max-h-64 w-64 overflow-y-auto rounded-xl border border-border bg-bg-card p-1.5 shadow-lg"
        >
          {MEETING_LANGUAGE_DEFINITIONS.map((definition, index) => {
            const isSelected = definition.code === selected.code
            return (
              <button
                key={definition.code}
                ref={(node) => {
                  optionRefs.current[index] = node
                }}
                type="button"
                role="option"
                aria-selected={isSelected}
                tabIndex={activeIndex === index ? 0 : -1}
                onClick={() => select(definition.code)}
                onMouseMove={() => setActiveIndex(index)}
                onKeyDown={(event) => handleOptionKeyDown(event, index, definition.code)}
                className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-[12px] transition-colors hover:bg-bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/50 ${
                  isSelected ? 'bg-bg-accent font-semibold text-ink' : 'text-ink-muted'
                }`}
              >
                <span className="flex items-baseline gap-2">
                  <span>{definition.label}</span>
                  {definition.code === 'en' && (
                    <span className="text-[10px] font-medium text-ink-faint">
                      Default · optimized
                    </span>
                  )}
                </span>
                {isSelected && (
                  <span aria-hidden="true" className="text-sage-dark">
                    ✓
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
