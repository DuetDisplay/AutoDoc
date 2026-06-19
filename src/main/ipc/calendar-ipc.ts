import { ipcMain, BrowserWindow } from 'electron'
import type { CalendarManager } from '../services/calendar-manager'
import { setAutoRecord, getAutoRecordMode } from '../services/auto-record-store'
import type { AutoRecordMode, CalendarEvent } from '../../shared/types'
import {
  connectE2ECalendar,
  disconnectE2ECalendar,
  getE2ECalendarAccounts,
  getE2ECalendarEvents,
} from '../services/e2e-fixtures'
import { logAutodocFailure } from '../services/autodoc-log'
import { getConfiguredAuthWorkerUrl, isOfficialAutoDocBuild } from '../services/distribution-config'

const isE2E = process.env.AUTODOC_E2E === '1'

export function registerCalendarIpc(
  calendarManager: CalendarManager,
  onEventsUpdated?: (events: CalendarEvent[]) => void,
  onConnectionChanged?: (connected: boolean) => void,
): void {
  ipcMain.handle('calendar:connect', async (_event, providerType: 'google' | 'microsoft') => {
    if (isE2E) {
      const account = connectE2ECalendar(providerType)
      const enriched = applyAutoRecordState(getE2ECalendarEvents())
      pushEventsToRenderer(enriched)
      onEventsUpdated?.(enriched)
      pushConnectionStatus(true)
      onConnectionChanged?.(true)
      return account
    }

    try {
      const account = await calendarManager.connect(providerType)

      // Announce the connection and return as soon as the account is saved.
      // Fetching upcoming events is a second network round-trip; if we block the
      // IPC return (and the connection-changed broadcast) on it, the renderer's
      // focus-abandon timer can fire first and discard the success, leaving
      // onboarding stuck on the connect screen until relaunch. Events are pushed
      // best-effort below and the renderer also listens for calendar:events-updated.
      pushConnectionStatus(true)
      onConnectionChanged?.(true)

      void (async () => {
        try {
          const events = await calendarManager.fetchAllUpcomingEvents()
          const enriched = applyAutoRecordState(events)
          pushEventsToRenderer(enriched)
          onEventsUpdated?.(enriched)

          // Start sync if this is the first account
          if (calendarManager.getAccounts().length === 1) {
            calendarManager.startSync((updatedEvents) => {
              const enrichedUpdated = applyAutoRecordState(updatedEvents)
              pushEventsToRenderer(enrichedUpdated)
              onEventsUpdated?.(enrichedUpdated)
            })
          }
        } catch (err) {
          logAutodocFailure({
            area: 'calendar',
            message: 'Failed to fetch events after calendar connection',
            error: err,
            context: { provider: providerType }
          })
        }
      })()

      return account
    } catch (err) {
      logAutodocFailure({
        area: 'calendar',
        message: 'Calendar connection failed',
        error: err,
        context: {
          provider: providerType,
          authWorkerConfigured: Boolean(getConfiguredAuthWorkerUrl()),
          officialBuild: isOfficialAutoDocBuild()
        }
      })
      throw err
    }
  })

  ipcMain.handle('calendar:cancel-connect', async () => {
    if (isE2E) return
    await calendarManager.cancelConnect()
  })

  ipcMain.handle('calendar:disconnect', async (_event, accountId: string) => {
    if (isE2E) {
      disconnectE2ECalendar(accountId)
      const enriched = applyAutoRecordState(getE2ECalendarEvents())
      pushEventsToRenderer(enriched)
      onEventsUpdated?.(enriched)
      const connected = getE2ECalendarAccounts().length > 0
      pushConnectionStatus(connected)
      onConnectionChanged?.(connected)
      return
    }

    await calendarManager.disconnect(accountId)

    if (calendarManager.getAccounts().length === 0) {
      calendarManager.stopSync()
    }

    // Push updated events to renderer
    const events = await calendarManager.fetchAllUpcomingEvents()
    const enriched = applyAutoRecordState(events)
    pushEventsToRenderer(enriched)
    onEventsUpdated?.(enriched)
    const connected = calendarManager.getAccounts().length > 0
    pushConnectionStatus(connected)
    onConnectionChanged?.(connected)
  })

  ipcMain.handle('calendar:get-accounts', () => {
    if (isE2E) {
      return getE2ECalendarAccounts()
    }

    return calendarManager.getAccounts()
  })

  ipcMain.handle('calendar:get-events', async () => {
    if (isE2E) {
      return applyAutoRecordState(getE2ECalendarEvents())
    }

    const events = await calendarManager.fetchAllUpcomingEvents()
    return applyAutoRecordState(events)
  })

  ipcMain.handle('calendar:sync', async () => {
    if (isE2E) {
      const enriched = applyAutoRecordState(getE2ECalendarEvents())
      pushEventsToRenderer(enriched)
      onEventsUpdated?.(enriched)
      return enriched
    }

    const events = await calendarManager.fetchAllUpcomingEvents()
    const enriched = applyAutoRecordState(events)
    pushEventsToRenderer(enriched)
    onEventsUpdated?.(enriched)
    return enriched
  })

  ipcMain.handle('calendar:set-auto-record', (_event, eventId: string, recurringEventId: string | null, mode: AutoRecordMode) => {
    setAutoRecord(eventId, recurringEventId, mode)
  })
}

function applyAutoRecordState(events: CalendarEvent[]): CalendarEvent[] {
  return events.map((e) => ({
    ...e,
    autoRecord: getAutoRecordMode(e.id, e.recurringEventId),
  }))
}

function pushEventsToRenderer(events: CalendarEvent[]): void {
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    win.webContents.send('calendar:events-updated', events)
  }
}

function pushConnectionStatus(connected: boolean): void {
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    win.webContents.send('calendar:connection-changed', connected)
  }
}
