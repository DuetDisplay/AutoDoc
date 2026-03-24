import { ipcMain, BrowserWindow } from 'electron'
import { CalendarService } from '../services/calendar'
import type { CalendarEvent } from '../../shared/types'

export function registerCalendarIpc(calendarService: CalendarService): void {
  ipcMain.handle('calendar:connect', async () => {
    await calendarService.connect()

    const events = await calendarService.fetchUpcomingEvents()
    pushEventsToRenderer(events)

    calendarService.startSync((updatedEvents) => {
      pushEventsToRenderer(updatedEvents)
    })
  })

  ipcMain.handle('calendar:disconnect', async () => {
    await calendarService.disconnect()
  })

  ipcMain.handle('calendar:is-connected', () => {
    return calendarService.isConnected()
  })

  ipcMain.handle('calendar:get-events', async () => {
    return calendarService.fetchUpcomingEvents()
  })

  ipcMain.handle('calendar:sync', async () => {
    const events = await calendarService.fetchUpcomingEvents()
    pushEventsToRenderer(events)
    return events
  })

  ipcMain.handle('calendar:set-auto-record', (_event, eventId: string, autoRecord: boolean) => {
    // Auto-record state stored in renderer for now. Will persist in SQLite in storage sub-project.
    void eventId
    void autoRecord
  })
}

function pushEventsToRenderer(events: CalendarEvent[]): void {
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    win.webContents.send('calendar:events-updated', events)
  }
}
