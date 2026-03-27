import { useState, useRef, useEffect } from 'react'
import type { AutoRecordMode, CalendarEvent } from '../../../shared/types'

interface EventCardProps {
  event: CalendarEvent
  onSetAutoRecord: (eventId: string, recurringEventId: string | null, mode: AutoRecordMode) => void
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

function getPlatform(url: string | null): string | null {
  if (!url) return null
  if (url.includes('meet.google.com')) return 'Google Meet'
  if (url.includes('zoom.us')) return 'Zoom'
  if (url.includes('teams.microsoft.com')) return 'Teams'
  if (url.includes('webex.com')) return 'Webex'
  return null
}

export function EventCard({ event, onSetAutoRecord }: EventCardProps) {
  const platform = getPlatform(event.meetingUrl)
  const [showMenu, setShowMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!showMenu) return
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showMenu])

  const isActive = event.autoRecord !== 'off'
  const isRecurring = event.recurringEventId !== null

  const handleSelect = (mode: AutoRecordMode) => {
    onSetAutoRecord(event.id, event.recurringEventId, mode)
    setShowMenu(false)
  }

  return (
    <div className="px-4 py-3.5 bg-bg-card border border-border rounded-xl flex justify-between items-center">
      <div>
        <div className="flex items-center gap-2">
          <div className="text-[13.5px] font-semibold text-ink tracking-[-0.01em]">
            {event.title}
          </div>
          {isRecurring && (
            <span className="text-[10px] text-ink-faint">Recurring</span>
          )}
          {isActive && (
            <span className="text-[10px] font-medium text-status-connected">
              {event.autoRecord === 'series' ? 'Auto-recording series' : 'Auto-recording'}
            </span>
          )}
        </div>
        <div className="text-[11.5px] text-ink-faint mt-0.5">
          {formatTime(event.startTime)} - {formatTime(event.endTime)}
          {platform && <span>  ·  {platform}</span>}
          {event.attendees.length > 0 && (
            <span>  ·  {event.attendees.length} attendee{event.attendees.length !== 1 ? 's' : ''}</span>
          )}
        </div>
      </div>
      <div className="relative" ref={menuRef}>
        <button
          onClick={() => isActive ? handleSelect('off') : (isRecurring ? setShowMenu(!showMenu) : handleSelect('once'))}
          aria-label={isActive ? 'Disable auto-record' : 'Enable auto-record'}
          className={`text-[10px] font-medium px-2.5 py-1 rounded-full border transition-colors flex items-center gap-1.5 ${
            isActive
              ? 'bg-status-connected/10 text-status-connected border-status-connected/30'
              : 'bg-bg-accent text-ink-muted border-border-subtle hover:border-ink-muted'
          }`}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${isActive ? 'bg-status-connected' : 'bg-ink-faint'}`} />
          {isActive
            ? event.autoRecord === 'series' ? 'Auto-record: Series' : 'Auto-record: On'
            : 'Auto-record: Off'}
        </button>
        {showMenu && (
          <div className="absolute right-0 top-full mt-1.5 z-50 w-52 bg-bg-card border border-border rounded-xl shadow-lg py-1.5 overflow-hidden">
            <button
              onClick={() => handleSelect('once')}
              className="w-full text-left px-3.5 py-2 hover:bg-bg-accent transition-colors"
            >
              <p className="text-[12px] font-medium text-ink">This meeting</p>
              <p className="text-[10.5px] text-ink-faint">Auto-record just this one</p>
            </button>
            <button
              onClick={() => handleSelect('series')}
              className="w-full text-left px-3.5 py-2 hover:bg-bg-accent transition-colors"
            >
              <p className="text-[12px] font-medium text-ink">All in series</p>
              <p className="text-[10.5px] text-ink-faint">Auto-record every occurrence</p>
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
