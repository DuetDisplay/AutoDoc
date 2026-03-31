import { ipcMain, BrowserWindow } from 'electron'
import type { CalendarManager } from '../services/calendar-manager'
import { setAutoRecord, getAutoRecordMode } from '../services/auto-record-store'
import type { AutoRecordMode, CalendarEvent } from '../../shared/types'

export function registerCalendarIpc(
  calendarManager: CalendarManager,
  onEventsUpdated?: (events: CalendarEvent[]) => void,
): void {
  ipcMain.handle('calendar:connect', async (_event, providerType: 'google' | 'microsoft') => {
    const account = await calendarManager.connect(providerType)

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

    pushConnectionStatus(true)
    return account
  })

  ipcMain.handle('calendar:disconnect', async (_event, accountId: string) => {
    await calendarManager.disconnect(accountId)

    if (calendarManager.getAccounts().length === 0) {
      calendarManager.stopSync()
    }

    // Push updated events to renderer
    const events = await calendarManager.fetchAllUpcomingEvents()
    const enriched = applyAutoRecordState(events)
    pushEventsToRenderer(enriched)
    onEventsUpdated?.(enriched)
    pushConnectionStatus(calendarManager.getAccounts().length > 0)
  })

  ipcMain.handle('calendar:get-accounts', () => {
    return calendarManager.getAccounts()
  })

  ipcMain.handle('calendar:get-events', async () => {
    const events = await calendarManager.fetchAllUpcomingEvents()
    return applyAutoRecordState(events)
  })

  ipcMain.handle('calendar:sync', async () => {
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
