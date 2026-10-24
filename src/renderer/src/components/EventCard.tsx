import { translatePlural } from '../../../shared/i18n'
import { useState, useRef, useEffect } from 'react'
import type { AutoRecordMode, CalendarEvent } from '../../../shared/types'
import { dateLocaleForUiLanguage } from '../../../shared/ui-language'
import { useI18n } from '../services/i18n'

interface EventCardProps {
  event: CalendarEvent
  onSetAutoRecord: (eventId: string, recurringEventId: string | null, mode: AutoRecordMode) => void
}

function formatTime(timestamp: number, locale: string): string {
  return new Date(timestamp).toLocaleTimeString(locale, {
    hour: 'numeric',
    minute: '2-digit'
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
  const { language, t } = useI18n()
  const platform = getPlatform(event.meetingUrl)
  const [showMenu, setShowMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const dateLocale = dateLocaleForUiLanguage(language)

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
    <div className="px-4 py-3.5 bg-bg-card border border-border rounded-xl flex flex-wrap justify-between items-start gap-3 min-w-0">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 text-[13.5px] font-semibold text-ink tracking-[-0.01em] text-pretty [overflow-wrap:anywhere]">
            {event.title}
          </div>
          {isRecurring && (
            <span className="text-[10px] text-ink-faint text-pretty">
              {t('upcoming.recurring')}
            </span>
          )}
          {isActive && (
            <span className="text-[10px] font-medium text-status-connected text-pretty [overflow-wrap:anywhere]">
              {event.autoRecord === 'series'
                ? t('upcoming.autoRecordingSeries')
                : t('upcoming.autoRecording')}
            </span>
          )}
        </div>
        <div className="text-[11.5px] text-ink-faint mt-0.5 text-pretty [overflow-wrap:anywhere]">
          {formatTime(event.startTime, dateLocale)} - {formatTime(event.endTime, dateLocale)}
          {platform && <span> · {platform}</span>}
          {event.attendees.length > 0 && (
            <span> · {translatePlural(language, 'attendees', event.attendees.length)}</span>
          )}
        </div>
      </div>
      <div className="relative min-w-0" ref={menuRef}>
        <button
          onClick={() =>
            isActive
              ? handleSelect('off')
              : isRecurring
                ? setShowMenu(!showMenu)
                : handleSelect('once')
          }
          aria-label={isActive ? t('upcoming.disableAutoRecord') : t('upcoming.enableAutoRecord')}
          className={`i18n-btn text-[10px] font-medium px-2.5 py-1 rounded-full border transition-colors flex items-center gap-1.5 ${
            isActive
              ? 'bg-status-connected/10 text-status-connected border-status-connected/30'
              : 'bg-bg-accent text-ink-muted border-border-subtle hover:border-ink-muted'
          }`}
        >
          <span
            className={`w-1.5 h-1.5 shrink-0 rounded-full ${isActive ? 'bg-status-connected' : 'bg-ink-faint'}`}
          />
          {isActive
            ? event.autoRecord === 'series'
              ? t('upcoming.autoRecordSeries')
              : t('upcoming.autoRecordOn')
            : t('upcoming.autoRecordOff')}
        </button>
        {showMenu && (
          <div className="absolute right-0 top-full mt-1.5 z-50 w-[min(13rem,calc(100vw-2rem))] bg-bg-card border border-border rounded-xl shadow-lg py-1.5 overflow-hidden">
            <button
              onClick={() => handleSelect('once')}
              className="w-full text-left px-3.5 py-2 hover:bg-bg-accent transition-colors"
            >
              <p className="text-[12px] font-medium text-ink text-pretty [overflow-wrap:anywhere]">
                {t('upcoming.thisMeeting')}
              </p>
              <p className="text-[10.5px] text-ink-faint text-pretty [overflow-wrap:anywhere]">
                {t('upcoming.thisMeetingHint')}
              </p>
            </button>
            <button
              onClick={() => handleSelect('series')}
              className="w-full text-left px-3.5 py-2 hover:bg-bg-accent transition-colors"
            >
              <p className="text-[12px] font-medium text-ink text-pretty [overflow-wrap:anywhere]">
                {t('upcoming.allInSeries')}
              </p>
              <p className="text-[10.5px] text-ink-faint text-pretty [overflow-wrap:anywhere]">
                {t('upcoming.allInSeriesHint')}
              </p>
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
