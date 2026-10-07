import { Fragment, useEffect, useId, useRef, useState } from 'react'
import {
  getMeetingLanguageDefinition,
  isMeetingLanguageAvailable,
  MEETING_LANGUAGE_DEFINITIONS,
  UNRESTRICTED_MEETING_LANGUAGE_AVAILABILITY,
  type MeetingLanguageAvailability,
  type MeetingLanguageCode
} from '../../../shared/meeting-language'
import { meetingLanguageSelectableNote } from '../services/meeting-language-copy'

interface MeetingLanguagePickerProps {
  value: MeetingLanguageCode
  onChange: (language: MeetingLanguageCode) => void
  disabled?: boolean
  /** Languages this machine's notes model can write; others are listed but locked. */
  availability?: MeetingLanguageAvailability
}

export const LOCKED_MEETING_LANGUAGES_HEADING = 'Needs 16 GB of memory'
// Windows uses the smaller notes model on low processor counts too, so its
// heading does not claim a memory size.
export const WINDOWS_LOCKED_MEETING_LANGUAGES_HEADING = 'Needs a more powerful PC'

function isNotesModelLocked(
  language: MeetingLanguageCode,
  availability: MeetingLanguageAvailability
): boolean {
  return !availability.availableLanguages.includes(language)
}

/**
 * The area the list can use: the window, narrowed by any scrolling ancestor
 * (such as the Settings page), whose overflow would clip the list.
 */
function visibleBounds(element: HTMLElement): { top: number; bottom: number } {
  let top = 0
  let bottom = window.innerHeight
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const overflowY = getComputedStyle(parent).overflowY
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'hidden') {
      const rect = parent.getBoundingClientRect()
      top = Math.max(top, rect.top)
      bottom = Math.min(bottom, rect.bottom)
    }
  }
  return { top, bottom }
}

export function MeetingLanguagePicker({
  value,
  onChange,
  disabled = false,
  availability = UNRESTRICTED_MEETING_LANGUAGE_AVAILABILITY
}: MeetingLanguagePickerProps) {
  // Available languages first, then locked ones under their own heading.
  const options = [
    ...MEETING_LANGUAGE_DEFINITIONS.filter((definition) =>
      isMeetingLanguageAvailable(definition.code, availability)
    ),
    ...MEETING_LANGUAGE_DEFINITIONS.filter(
      (definition) => !isMeetingLanguageAvailable(definition.code, availability)
    )
  ]
  const firstLockedIndex = options.findIndex(
    (definition) => !isMeetingLanguageAvailable(definition.code, availability)
  )
  const firstNotesLockedIndex = options.findIndex((definition) =>
    isNotesModelLocked(definition.code, availability)
  )
  const listboxId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [isOpen, setIsOpen] = useState(false)
  // Fit the list in the window: open downward when there is room, otherwise
  // toward the larger side, and cap the height to that side's space.
  const [placement, setPlacement] = useState<{ above: boolean; maxHeight: number }>({
    above: false,
    maxHeight: 256
  })
  const selected = getMeetingLanguageDefinition(value)
  const selectedIndex = Math.max(
    0,
    options.findIndex((definition) => definition.code === selected.code)
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
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect && triggerRef.current) {
      const margin = 12
      const bounds = visibleBounds(triggerRef.current)
      const below = bounds.bottom - rect.bottom - margin
      const above = rect.top - bounds.top - margin
      const openAbove = below < 256 && above > below
      setPlacement({
        above: openAbove,
        maxHeight: Math.max(96, Math.min(256, openAbove ? above : below))
      })
    }
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
    if (!isMeetingLanguageAvailable(language, availability)) return
    const state = availability.languageStates?.[language]
    if (language !== value || (state?.firstUseDownloadBytes ?? 0) > 0 || state?.needsSelfTest) {
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
      setActiveIndex((index + 1) % options.length)
      return
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index - 1 + options.length) % options.length)
      return
    }

    if (event.key === 'Home') {
      event.preventDefault()
      setActiveIndex(0)
      return
    }

    if (event.key === 'End') {
      event.preventDefault()
      setActiveIndex(options.length - 1)
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
          style={{ maxHeight: placement.maxHeight }}
          className={`absolute right-0 z-50 w-64 overflow-y-auto rounded-xl border border-border bg-bg-card p-1.5 shadow-lg ${
            placement.above ? 'bottom-full mb-1.5' : 'top-full mt-1.5'
          }`}
        >
          {options.map((definition, index) => {
            const isSelected = definition.code === selected.code
            const isLocked = index >= firstLockedIndex && firstLockedIndex !== -1
            const engineState = availability.languageStates?.[definition.code]
            const selectableNote = !isLocked ? meetingLanguageSelectableNote(engineState) : null
            const lockedReason =
              isLocked && engineState?.availability === 'locked' ? engineState.reason : null
            return (
              <Fragment key={definition.code}>
                {index === firstNotesLockedIndex && firstNotesLockedIndex !== -1 && (
                  <div
                    role="presentation"
                    className="mx-1 mb-1 mt-1.5 border-t border-border-subtle px-2 pb-1 pt-2 text-[10px] font-medium text-ink-faint"
                  >
                    {navigator.userAgent.includes('Windows')
                      ? WINDOWS_LOCKED_MEETING_LANGUAGES_HEADING
                      : LOCKED_MEETING_LANGUAGES_HEADING}
                  </div>
                )}
                <button
                  ref={(node) => {
                    optionRefs.current[index] = node
                  }}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={isLocked || undefined}
                  tabIndex={activeIndex === index ? 0 : -1}
                  onClick={() => select(definition.code)}
                  onMouseMove={() => setActiveIndex(index)}
                  onKeyDown={(event) => handleOptionKeyDown(event, index, definition.code)}
                  className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/50 ${
                    isLocked
                      ? 'cursor-not-allowed text-ink-faint'
                      : isSelected
                        ? 'bg-bg-accent font-semibold text-ink hover:bg-bg-accent'
                        : 'text-ink-muted hover:bg-bg-accent'
                  }`}
                >
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex items-baseline gap-2">
                      <span>{definition.label}</span>
                      {definition.code === 'en' && (
                        <span className="text-[10px] font-medium text-ink-faint">
                          Default · optimized
                        </span>
                      )}
                      {selectableNote && (
                        <span className="text-[10px] font-medium text-ink-faint">
                          {selectableNote}
                        </span>
                      )}
                    </span>
                    {lockedReason && (
                      <span className="text-[10px] font-medium leading-snug text-ink-faint">
                        {lockedReason}
                      </span>
                    )}
                  </span>
                  {isSelected && (
                    <span aria-hidden="true" className="text-sage-dark">
                      ✓
                    </span>
                  )}
                  {isLocked && (
                    <svg
                      aria-hidden="true"
                      focusable="false"
                      viewBox="0 0 16 16"
                      fill="none"
                      className="size-3 text-ink-faint"
                    >
                      <rect
                        x="3.5"
                        y="7"
                        width="9"
                        height="6.5"
                        rx="1.5"
                        stroke="currentColor"
                        strokeWidth="1.3"
                      />
                      <path
                        d="M5.5 7V5.25a2.5 2.5 0 0 1 5 0V7"
                        stroke="currentColor"
                        strokeWidth="1.3"
                      />
                    </svg>
                  )}
                </button>
              </Fragment>
            )
          })}
        </div>
      )}
    </div>
  )
}
