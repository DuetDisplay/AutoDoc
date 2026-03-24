import { useEffect } from 'react'
import { PageHeader } from '../components/PageHeader'
import { EventCard } from '../components/EventCard'
import { ConnectCalendar } from '../components/ConnectCalendar'
import { useCalendarStore } from '../stores/calendar'

export function Upcoming() {
  const {
    isConnected,
    isConnecting,
    events,
    isSyncing,
    setConnected,
    setConnecting,
    setEvents,
    setSyncing,
    toggleAutoRecord,
  } = useCalendarStore()

  useEffect(() => {
    // Check connection status on mount
    window.electronAPI.invoke('calendar:is-connected').then(setConnected)

    // Listen for event updates from main process
    const unsubscribe = window.electronAPI.on('calendar:events-updated', (updatedEvents) => {
      setEvents(updatedEvents)
    })

    // If already connected, fetch events
    window.electronAPI.invoke('calendar:is-connected').then(async (connected) => {
      if (connected) {
        const fetchedEvents = await window.electronAPI.invoke('calendar:get-events')
        setEvents(fetchedEvents)
      }
    })

    return unsubscribe
  }, [setConnected, setEvents])

  const handleConnect = async () => {
    setConnecting(true)
    try {
      await window.electronAPI.invoke('calendar:connect')
      setConnected(true)
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

  const handleToggleAutoRecord = (eventId: string) => {
    toggleAutoRecord(eventId)
    const event = events.find((e) => e.id === eventId)
    if (event) {
      window.electronAPI.invoke('calendar:set-auto-record', eventId, !event.autoRecord)
    }
  }

  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Upcoming"
        subtitle={today}
        action={
          isConnected ? (
            <button
              onClick={handleSync}
              disabled={isSyncing}
              className="text-[11px] font-medium text-ink-muted bg-bg-accent px-3 py-1.5 rounded-md border border-border-subtle hover:border-ink-muted transition-colors disabled:opacity-50"
            >
              {isSyncing ? 'Syncing...' : 'Sync'}
            </button>
          ) : undefined
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
          <div className="flex flex-col gap-2">
            {events.map((event) => (
              <EventCard
                key={event.id}
                event={event}
                onToggleAutoRecord={handleToggleAutoRecord}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
