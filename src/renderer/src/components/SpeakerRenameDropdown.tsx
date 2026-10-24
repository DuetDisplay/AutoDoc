import { useT } from '../services/i18n'
import { useState, useRef, useEffect, useLayoutEffect } from 'react'

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
  const [placement, setPlacement] = useState({ left: 0, above: false, maxHeight: 256 })

  useLayoutEffect(() => {
    const fit = () => {
      const element = ref.current
      const anchor = element?.parentElement
      if (!element || !anchor) return
      let top = 12,
        bottom = window.innerHeight - 12,
        left = 12,
        right = window.innerWidth - 12
      for (let parent: HTMLElement | null = anchor; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent),
          rect = parent.getBoundingClientRect()
        if (/(auto|scroll|hidden)/.test(style.overflowY)) {
          top = Math.max(top, rect.top)
          bottom = Math.min(bottom, rect.bottom)
        }
        if (/(auto|scroll|hidden)/.test(style.overflowX)) {
          left = Math.max(left, rect.left)
          right = Math.min(right, rect.right)
        }
      }
      const rect = anchor.getBoundingClientRect(),
        below = bottom - rect.bottom - 4,
        above = rect.top - top - 4
      const openAbove = below < element.scrollHeight && above > below
      const targetLeft = Math.max(left, Math.min(rect.left, right - element.offsetWidth))
      setPlacement({
        left: targetLeft - rect.left,
        above: openAbove,
        maxHeight: Math.max(48, Math.min(320, openAbove ? above : below))
      })
    }
    fit()
    window.addEventListener('resize', fit)
    window.addEventListener('scroll', fit, true)
    return () => {
      window.removeEventListener('resize', fit)
      window.removeEventListener('scroll', fit, true)
    }
  }, [t, suggestions])

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true })
  }, [])

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [onClose])

  const handleSubmit = () => {
    const trimmed = customName.trim()
    if (trimmed) {
      onRename(trimmed)
      onClose()
      opener.current?.focus({ preventScroll: true })
    }
  }

  return (
    <div
      ref={ref}
      style={{ left: placement.left, maxHeight: placement.maxHeight }}
      className={`absolute ${placement.above ? 'bottom-full mb-1' : 'top-full mt-1'} z-50 w-56 overflow-y-auto bg-bg-card border border-border rounded-lg shadow-lg max-w-[calc(100vw-2rem)]`}
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
                onClose()
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
            if (e.key === 'Enter') handleSubmit()
            if (e.key === 'Escape') {
              e.preventDefault()
              onClose()
              opener.current?.focus({ preventScroll: true })
            }
          }}
          className="w-full border border-border rounded px-2 py-1.5 text-[12px] text-ink outline-none focus:border-ink-muted focus-visible:ring-2 focus-visible:ring-sage bg-transparent"
        />
      </label>
    </div>
  )
}
