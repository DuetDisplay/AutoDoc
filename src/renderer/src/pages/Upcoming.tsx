import { useEffect, useMemo, useState } from 'react'
import { PageHeader } from '../components/PageHeader'
import { EventCard } from '../components/EventCard'
import { ConnectCalendar } from '../components/ConnectCalendar'
import { useCalendarStore, selectIsConnected } from '../stores/calendar'
import { RecordingControls } from '../components/RecordingControls'
import { useRecordingActions } from '../hooks/useRecording'
import { useToastStore } from '../stores/toast'
import { trackEvent } from '../services/analytics'
import type { CalendarEvent } from '../../../shared/types'

let calendarToastShown = false

export function Upcoming() {
  const [calendarChecked, setCalendarChecked] = useState(false)
  const {
    isConnecting,
    events,
    isSyncing,
    setAccounts,
    addAccount,
    setConnecting,
    setEvents,
    setSyncing,
    setAutoRecord,
  } = useCalendarStore()
  const isConnected = useCalendarStore(selectIsConnected)

  useEffect(() => {
    window.electronAPI.invoke('calendar:get-accounts').then((accts) => {
      setAccounts(accts)
      setCalendarChecked(true)
    })

    const unsubscribe = window.electronAPI.on('calendar:events-updated', (updatedEvents) => {
      setEvents(updatedEvents)
    })

    window.electronAPI.invoke('calendar:get-accounts').then(async (accts) => {
      if (accts.length > 0) {
        const fetchedEvents = await window.electronAPI.invoke('calendar:get-events')
        setEvents(fetchedEvents)
      }
    })

    return unsubscribe
  }, [setAccounts, setEvents])

  useEffect(() => {
    // Only show calendar toast after we've confirmed the connection status.
    // Don't fire on the initial render where isConnected defaults to false.
    if (!calendarChecked) return
    if (!isConnected && !calendarToastShown) {
      calendarToastShown = true
      useToastStore.getState().showToast({
        type: 'calendar',
        message: 'Connect a calendar to see upcoming meetings and auto-name recordings.',
      })
    }
  }, [isConnected, calendarChecked])

  const handleConnect = async (provider: 'google' | 'microsoft') => {
    setConnecting(true)
    try {
      const account = await window.electronAPI.invoke('calendar:connect', provider)
      addAccount(account)
      trackEvent('calendar_connected', { provider })
      const fetchedEvents = await window.electronAPI.invoke('calendar:get-events')
      setEvents(fetchedEvents)
    } catch (err) {
      console.error('Failed to connect calendar:', err)
    } finally {
      setConnecting(false)
    }
  }

  const handleSync = async () => {
    setSyncing(true)
    try {
      const syncedEvents = await window.electronAPI.invoke('calendar:sync')
      setEvents(syncedEvents)
    } finally {
      setSyncing(false)
    }
  }

  const handleSetAutoRecord = (eventId: string, recurringEventId: string | null, mode: import('../../../shared/types').AutoRecordMode) => {
    setAutoRecord(eventId, mode)
    window.electronAPI.invoke('calendar:set-auto-record', eventId, recurringEventId, mode)
  }

  const { isRecording, fetchSources, handleStart, handleStop } = useRecordingActions()

  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })

  const groupedEvents = useMemo(() => {
    const now = new Date()
    const todayStr = now.toDateString()
    const tomorrow = new Date(now)
    tomorrow.setDate(tomorrow.getDate() + 1)
    const tomorrowStr = tomorrow.toDateString()

    const groups: { label: string; events: CalendarEvent[] }[] = []
    const buckets = new Map<string, CalendarEvent[]>()

    for (const event of events) {
      const dateStr = new Date(event.startTime).toDateString()
      if (!buckets.has(dateStr)) buckets.set(dateStr, [])
      buckets.get(dateStr)!.push(event)
    }

    for (const [dateStr, dayEvents] of buckets) {
      let label: string
      if (dateStr === todayStr) {
        label = 'Today'
      } else if (dateStr === tomorrowStr) {
        label = 'Tomorrow'
      } else {
        const d = new Date(dateStr)
        label = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
      }
      groups.push({ label, events: dayEvents })
    }

    return groups
  }, [events])

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Upcoming"
        subtitle={today}
        action={
          <div className="flex items-center gap-2">
            <RecordingControls
              isRecording={isRecording}
              onStartRecording={handleStart}
              onStopRecording={handleStop}
              onFetchSources={fetchSources}
            />
            {isConnected && (
              <button
                onClick={handleSync}
                disabled={isSyncing}
                className="text-[11px] font-medium text-ink-muted bg-bg-accent px-3 py-1.5 rounded-md border border-border-subtle hover:border-ink-muted transition-colors disabled:opacity-50"
              >
                {isSyncing ? 'Syncing...' : 'Sync'}
              </button>
            )}
          </div>
        }
      />

      {!isConnected ? (
        <ConnectCalendar isConnecting={isConnecting} onConnect={handleConnect} />
      ) : events.length === 0 ? (
        <div className="flex-1 flex items-center justify-center p-6">
          <p className="text-ink-muted text-[13px]">No upcoming meetings</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-6">
          <div className="flex flex-col gap-5">
            {groupedEvents.map((group) => (
              <div key={group.label}>
                <div className="flex items-center gap-2 mb-2">
                  <h2 className={`text-[12px] font-bold tracking-[0.03em] uppercase ${
                    group.label === 'Today' ? 'text-ink' : 'text-ink-faint'
                  }`}>
                    {group.label}
                  </h2>
                  <span className="text-[11px] text-ink-faint">
                    {group.events.length} meeting{group.events.length !== 1 ? 's' : ''}
                  </span>
                </div>
                <div className="flex flex-col gap-2">
                  {group.events.map((event) => (
                    <EventCard
                      key={event.id}
                      event={event}
                      onSetAutoRecord={handleSetAutoRecord}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
