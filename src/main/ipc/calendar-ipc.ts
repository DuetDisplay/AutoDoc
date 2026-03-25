import { ipcMain, BrowserWindow } from 'electron'
import { CalendarService } from '../services/calendar'
import { setAutoRecord, getAutoRecordMode } from '../services/auto-record-store'
import type { AutoRecordMode, CalendarEvent } from '../../shared/types'

export function registerCalendarIpc(calendarService: CalendarService): void {
  ipcMain.handle('calendar:connect', async () => {
    await calendarService.connect()

    const events = await calendarService.fetchUpcomingEvents()
    pushEventsToRenderer(applyAutoRecordState(events))

    calendarService.startSync((updatedEvents) => {
      pushEventsToRenderer(applyAutoRecordState(updatedEvents))
    })
  })

  ipcMain.handle('calendar:disconnect', async () => {
    await calendarService.disconnect()
  })

  ipcMain.handle('calendar:is-connected', () => {
    return calendarService.isConnected()
  })

  ipcMain.handle('calendar:get-events', async () => {
    const events = await calendarService.fetchUpcomingEvents()
    return applyAutoRecordState(events)
  })

  ipcMain.handle('calendar:sync', async () => {
    const events = await calendarService.fetchUpcomingEvents()
    pushEventsToRenderer(applyAutoRecordState(events))
    return applyAutoRecordState(events)
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
