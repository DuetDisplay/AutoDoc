import { createPortal } from 'react-dom'
import { useAnchoredPopover } from '../hooks/useAnchoredPopover'
import { useT } from '../services/i18n'
import { useState, useRef, useEffect } from 'react'

interface SpeakerRenameDropdownProps {
  suggestions?: string[]
  onRename: (name: string) => void
  onClose: () => void
}

export function SpeakerRenameDropdown({
  suggestions,
  onRename,
  onClose
}: SpeakerRenameDropdownProps) {
  const t = useT()

  const [customName, setCustomName] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const opener = useRef(document.activeElement as HTMLElement | null)
  const anchorRef = useRef<HTMLSpanElement>(null)
  const placement = useAnchoredPopover(true, anchorRef, 224, 320, 'start')

  useEffect(() => {
    if (placement.visibility !== 'hidden') inputRef.current?.focus({ preventScroll: true })
  }, [placement.visibility])

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [onClose])

  const closeAndRestoreFocus = () => {
    onClose()
    opener.current?.focus({ preventScroll: true })
  }

  const handleSubmit = () => {
    const trimmed = customName.trim()
    if (trimmed) {
      onRename(trimmed)
      closeAndRestoreFocus()
    }
  }

  return (
    <>
      <span ref={anchorRef} aria-hidden="true" className="absolute inset-0 pointer-events-none" />
      {createPortal(
        <div
          ref={ref}
          style={placement}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              closeAndRestoreFocus()
            }
          }}
          className="z-50 overflow-y-auto bg-bg-card border border-border rounded-lg shadow-lg"
        >
          {suggestions && suggestions.length > 0 && (
            <>
              <div className="px-3 py-1.5 text-[10px] text-ink-faint uppercase tracking-wider">
                {t('ui.fromCalendarInvite')}
              </div>
              {suggestions.map((email) => (
                <button
                  key={email}
                  onClick={() => {
                    onRename(email)
                    closeAndRestoreFocus()
                  }}
                  className="block w-full text-left break-all px-3 py-2 text-[12px] text-ink hover:bg-bg-accent/60 transition-colors"
                >
                  {email}
                </button>
              ))}
              <div className="border-t border-border my-1" />
            </>
          )}
          <label className="block px-3 py-2">
            <span className="mb-1 block text-[11px] leading-snug text-ink-muted">
              {t('ui.typeACustomName')}
            </span>
            <input
              ref={inputRef}
              type="text"
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return
                if (e.key === 'Enter') handleSubmit()
              }}
              className="w-full border-2 border-control-border rounded px-2 py-1.5 text-[12px] text-ink outline-none focus:border-ink-muted focus-visible:ring-2 focus-visible:ring-sage bg-transparent"
            />
          </label>
        </div>,
        document.body
      )}
    </>
  )
}
