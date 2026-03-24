import type { CalendarEvent } from '../../../shared/types'

interface EventCardProps {
  event: CalendarEvent
  onToggleAutoRecord: (eventId: string) => void
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

export function EventCard({ event, onToggleAutoRecord }: EventCardProps) {
  const platform = getPlatform(event.meetingUrl)

  return (
    <div className="px-4 py-3.5 bg-bg-card border border-border rounded-xl flex justify-between items-center">
      <div>
        <div className="text-[13.5px] font-semibold text-ink tracking-[-0.01em]">
          {event.title}
        </div>
        <div className="text-[11.5px] text-ink-faint mt-0.5">
          {formatTime(event.startTime)} - {formatTime(event.endTime)}
          {platform && <span>  ·  {platform}</span>}
        </div>
      </div>
      <button
        onClick={() => onToggleAutoRecord(event.id)}
        aria-label={event.autoRecord ? 'Disable auto-record' : 'Enable auto-record'}
        className={`text-[10px] font-medium px-2.5 py-1 rounded-full border transition-colors ${
          event.autoRecord
            ? 'bg-ink text-white border-ink'
            : 'bg-bg-accent text-ink border-border-subtle hover:border-ink-muted'
        }`}
      >
        Auto-record
      </button>
    </div>
  )
}
