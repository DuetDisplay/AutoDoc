import { translatePlural } from '../../../shared/i18n'
import { useEffect, useMemo, useState } from 'react'
import { PageHeader } from '../components/PageHeader'
import { EventCard } from '../components/EventCard'
import { ConnectCalendar } from '../components/ConnectCalendar'
import { useCalendarStore, selectIsConnected } from '../stores/calendar'
import { useCalendarConnect } from '../hooks/useCalendarConnect'
import { RecordingControls } from '../components/RecordingControls'
import { useRecordingActions } from '../hooks/useRecording'
import { useToastStore } from '../stores/toast'
import { trackEvent } from '../services/analytics'
import { recordDiagnosticAction } from '../services/diagnostic-trail'
import type { CalendarEvent } from '../../../shared/types'
import { ROUTES } from '../../../shared/constants'
import { FeedbackPromptSlot } from '../components/FeedbackPromptSlot'
import { useI18n } from '../services/i18n'
import { dateLocaleForUiLanguage } from '../../../shared/ui-language'

let calendarToastShown = false

export function Upcoming({
  feedbackPromptSuppressed = false
}: {
  feedbackPromptSuppressed?: boolean
}) {
  const { language, t } = useI18n()
  const dateLocale = dateLocaleForUiLanguage(language)
  const [calendarChecked, setCalendarChecked] = useState(false)
  const [calendarEventsChecked, setCalendarEventsChecked] = useState(false)
  const [feedbackCalendarReady, setFeedbackCalendarReady] = useState(false)
  const { events, isSyncing, setAccounts, addAccount, setConnecting, setEvents, setSyncing } =
    useCalendarStore()
  const isConnected = useCalendarStore(selectIsConnected)

  const {
    connectingProvider,
    error: calendarConnectError,
    connect
  } = useCalendarConnect({
    formatError: (provider) =>
      t('upcoming.connectFailed', {
        provider:
          provider === 'google' ? t('upcoming.googleCalendar') : t('upcoming.microsoftOutlook')
      }),
    onConnected: async (account, provider) => {
      addAccount(account)
      trackEvent('calendar_connected', { provider })
      const fetchedEvents = await window.electronAPI.invoke('calendar:get-events')
      setEvents(fetchedEvents)
    }
  })
  const isConnecting = connectingProvider !== null

  useEffect(() => {
    setConnecting(isConnecting)
  }, [isConnecting, setConnecting])

  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const accts = await window.electronAPI.invoke('calendar:get-accounts')
        if (cancelled) return
        setAccounts(accts)

        if (accts.length > 0) {
          const fetchedEvents = await window.electronAPI.invoke('calendar:get-events')
          if (cancelled) return
          setEvents(fetchedEvents)
        }
      } catch (err) {
        console.error('Failed to load calendar state:', err)
      } finally {
        if (!cancelled) {
          setCalendarChecked(true)
          setCalendarEventsChecked(true)
        }
      }
    })()

    const unsubscribe = window.electronAPI.on('calendar:events-updated', (updatedEvents) => {
      setEvents(updatedEvents)
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [setAccounts, setEvents])

  useEffect(() => {
    // Only show calendar toast after we've confirmed the connection status.
    // Don't fire on the initial render where isConnected defaults to false.
    if (!calendarChecked) return
    if (!isConnected && !calendarToastShown) {
      calendarToastShown = true
      useToastStore.getState().showToast({
        type: 'calendar',
        message: t('upcoming.connectToast'),
        messageKey: 'upcoming.connectToast',
        action: {
          label: t('upcoming.openSettings'),
          labelKey: 'upcoming.openSettings',
          type: 'navigate',
          target: ROUTES.settings
        }
      })
    }
  }, [isConnected, calendarChecked, t])

  useEffect(() => {
    if (!calendarEventsChecked) return

    // Let the calendar-connect toast register with App's critical-UI gate before
    // the feedback slot is allowed to claim an impression.
    const timer = window.setTimeout(() => setFeedbackCalendarReady(true), 0)
    return () => window.clearTimeout(timer)
  }, [calendarEventsChecked])

  const handleConnect = (provider: 'google' | 'microsoft') => {
    recordDiagnosticAction({
      category: 'calendar',
      action: 'calendar_connect_requested',
      details: { provider }
    })
    void connect(provider)
  }

  const handleSync = async () => {
    setSyncing(true)
    recordDiagnosticAction({
      category: 'calendar',
      action: 'calendar_sync_requested'
    })
    try {
      const syncedEvents = await window.electronAPI.invoke('calendar:sync')
      setEvents(syncedEvents)
    } catch (err) {
      console.error('Calendar sync failed:', err)
      trackEvent('calendar_sync_failed', {
        provider: 'unknown',
        failure_code: 'sync_failed'
      })
      // Auth failure auto-disconnects via the connection-changed listener
    } finally {
      setSyncing(false)
    }
  }

  const handleSetAutoRecord = (
    eventId: string,
    recurringEventId: string | null,
    mode: import('../../../shared/types').AutoRecordMode
  ) => {
    recordDiagnosticAction({
      category: 'calendar',
      action: 'auto_record_mode_changed',
      details: {
        mode,
        hasRecurringEventId: recurringEventId !== null
      }
    })
    void window.electronAPI
      .invoke('calendar:set-auto-record', eventId, recurringEventId, mode)
      .catch((err) => {
        console.error('Failed to save auto-record preference:', err)
        useToastStore.getState().showToast({
          type: 'warning',
          message: t('upcoming.autoRecordSaveFailed'),
          messageKey: 'upcoming.autoRecordSaveFailed'
        })
      })
  }

  const { isRecording, fetchSources, handleStart, handleStop } = useRecordingActions()

  const today = new Date().toLocaleDateString(dateLocale, {
    weekday: 'long',
    month: 'long',
    day: 'numeric'
  })
  const todayLabel = t('upcoming.today')
  const tomorrowLabel = t('upcoming.tomorrow')

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
        label = todayLabel
      } else if (dateStr === tomorrowStr) {
        label = tomorrowLabel
      } else {
        const d = new Date(dateStr)
        label = d.toLocaleDateString(dateLocale, { weekday: 'long', month: 'long', day: 'numeric' })
      }
      groups.push({ label, events: dayEvents })
    }

    return groups
  }, [dateLocale, events, todayLabel, tomorrowLabel])

  return (
    <div className="flex flex-col h-full min-w-0" data-testid="upcoming-page">
      <PageHeader
        title={t('upcoming.title')}
        subtitle={today}
        action={
          <div className="flex flex-wrap items-center justify-end gap-2 min-w-0 max-w-full">
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
                className="i18n-btn text-[11px] font-medium text-ink-muted bg-bg-accent px-3 py-1.5 rounded-md border border-border-subtle hover:border-ink-muted transition-colors disabled:opacity-50"
              >
                {isSyncing ? t('upcoming.syncing') : t('upcoming.sync')}
              </button>
            )}
          </div>
        }
      />

      <FeedbackPromptSlot
        surface="upcoming"
        suppressed={feedbackPromptSuppressed || !feedbackCalendarReady || isConnecting || isSyncing}
      />

      {!isConnected ? (
        <ConnectCalendar
          isConnecting={isConnecting}
          error={calendarConnectError}
          onConnect={handleConnect}
        />
      ) : events.length === 0 ? (
        <div className="flex-1 flex items-center justify-center p-6">
          <p className="text-ink-muted text-[13px] text-pretty [overflow-wrap:anywhere]">
            {t('upcoming.noMeetings')}
          </p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto overflow-x-hidden p-6 min-w-0">
          <div className="flex flex-col gap-5 min-w-0">
            {groupedEvents.map((group) => (
              <div key={group.label} className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 mb-2 min-w-0">
                  <h2
                    className={`text-[12px] font-bold tracking-[0.03em] uppercase text-pretty [overflow-wrap:anywhere] ${
                      group.label === todayLabel ? 'text-ink' : 'text-ink-faint'
                    }`}
                  >
                    {group.label}
                  </h2>
                  <span className="text-[11px] text-ink-faint text-pretty [overflow-wrap:anywhere]">
                    {translatePlural(language, 'meetings', group.events.length)}
                  </span>
                </div>
                <div className="flex flex-col gap-2 min-w-0">
                  {group.events.map((event) => (
                    <EventCard key={event.id} event={event} onSetAutoRecord={handleSetAutoRecord} />
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
