import { ipcMain, BrowserWindow } from 'electron'
import { CalendarService } from '../services/calendar'
import { setAutoRecord, getAutoRecordMode } from '../services/auto-record-store'
import type { AutoRecordMode, CalendarEvent } from '../../shared/types'

export function registerCalendarIpc(
  calendarService: CalendarService,
  onEventsUpdated?: (events: CalendarEvent[]) => void,
): void {
  ipcMain.handle('calendar:connect', async () => {
    await calendarService.connect()

    // Start sync — don't let an initial fetch failure undo the connection
    calendarService.startSync(
      (updatedEvents) => {
        const enrichedUpdated = applyAutoRecordState(updatedEvents)
        pushEventsToRenderer(enrichedUpdated)
        onEventsUpdated?.(enrichedUpdated)
      },
      async () => {
        await calendarService.disconnect()
        pushConnectionStatus(false)
      },
    )
  })

  ipcMain.handle('calendar:disconnect', async () => {
    await calendarService.disconnect()
    pushConnectionStatus(false)
  })

  ipcMain.handle('calendar:is-connected', () => {
    return calendarService.isConnected()
  })

  ipcMain.handle('calendar:get-events', async () => {
    try {
      const events = await calendarService.fetchUpcomingEvents()
      return applyAutoRecordState(events)
    } catch (err) {
      console.error('Failed to fetch calendar events:', err)
      // If the token refresh or API call failed, the session is stale
      await calendarService.disconnect()
      pushConnectionStatus(false)
      throw err
    }
  })

  ipcMain.handle('calendar:sync', async () => {
    try {
      const events = await calendarService.fetchUpcomingEvents()
      const enriched = applyAutoRecordState(events)
      pushEventsToRenderer(enriched)
      return enriched
    } catch (err) {
      console.error('Calendar sync failed:', err)
      await calendarService.disconnect()
      pushConnectionStatus(false)
      throw err
    }
  })

  ipcMain.handle('calendar:set-auto-record', (_event, eventId: string, recurringEventId: string | null, mode: AutoRecordMode) => {
    setAutoRecord(eventId, recurringEventId, mode)
  })
}

function applyAutoRecordState(events: CalendarEvent[]): CalendarEvent[] {
  return events.map((e) => ({
    ...e,
    autoRecord: getAutoRecordMode(e.googleEventId, e.recurringEventId),
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
