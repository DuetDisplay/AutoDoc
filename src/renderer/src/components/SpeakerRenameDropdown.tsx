import { useState, useRef, useEffect } from 'react'

interface SpeakerRenameDropdownProps {
  suggestions?: string[]
  onRename: (name: string) => void
  onClose: () => void
}

export function SpeakerRenameDropdown({ suggestions, onRename, onClose }: SpeakerRenameDropdownProps) {
  const [customName, setCustomName] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
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
    }
  }

  return (
    <div
      ref={ref}
      className="absolute top-full left-0 mt-1 z-50 bg-bg-card border border-border rounded-lg shadow-lg min-w-[200px]"
    >
      {suggestions && suggestions.length > 0 && (
        <>
          <div className="px-3 py-1.5 text-[10px] text-ink-faint uppercase tracking-wider">
            From calendar invite
          </div>
          {suggestions.map((email) => (
            <button
              key={email}
              onClick={() => { onRename(email); onClose() }}
              className="block w-full text-left px-3 py-2 text-[12px] text-ink hover:bg-bg-accent/60 transition-colors"
            >
              {email}
            </button>
          ))}
          <div className="border-t border-border my-1" />
        </>
      )}
      <div className="px-3 py-2">
        <input
          ref={inputRef}
          type="text"
          value={customName}
          onChange={(e) => setCustomName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); if (e.key === 'Escape') onClose() }}
          placeholder="Type a custom name..."
          className="w-full border border-border rounded px-2 py-1.5 text-[12px] outline-none focus:border-ink-muted bg-transparent"
        />
      </div>
    </div>
  )
}
