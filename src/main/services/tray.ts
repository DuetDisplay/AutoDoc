import { Tray, Menu, nativeImage, app } from 'electron'
import { join } from 'path'
import type { CalendarEvent } from '../../shared/types'

let tray: Tray | null = null
let cachedEventsRef: () => CalendarEvent[] = () => []
let showWindowFn: () => void = () => {}

function getTrayIconPath(): string {
  if (process.platform === 'darwin') {
    if (app.isPackaged) {
      return join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'trayTemplate.png')
    }
    return join(process.cwd(), 'build', 'trayTemplate.png')
  }

  if (app.isPackaged) {
    return join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'icon.png')
  }
  return join(process.cwd(), 'resources', 'icon.png')
}

function formatTime(ms: number): string {
  const d = new Date(ms)
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function getUpcomingEvents(): CalendarEvent[] {
  const now = Date.now()
  const endOfDay = new Date()
  endOfDay.setHours(23, 59, 59, 999)

  return cachedEventsRef()
    .filter((e) => e.endTime > now && e.startTime < endOfDay.getTime())
    .sort((a, b) => a.startTime - b.startTime)
    .slice(0, 5)
}

function buildMenu(): Menu {
  const events = getUpcomingEvents()
  const template: Electron.MenuItemConstructorOptions[] = []

  if (events.length > 0) {
    template.push({ label: 'Upcoming Meetings', enabled: false })
    template.push({ type: 'separator' })

    for (const event of events) {
      const now = Date.now()
      const isNow = event.startTime <= now && event.endTime > now
      const timeLabel = isNow ? 'Now' : formatTime(event.startTime)

      template.push({
        label: `${timeLabel}  ${event.title}`,
        enabled: !!event.meetingUrl,
        click: () => {
          if (event.meetingUrl) {
            const { shell } = require('electron')
            shell.openExternal(event.meetingUrl)
          }
        }
      })
    }
  } else {
    template.push({ label: 'No upcoming meetings today', enabled: false })
  }

  template.push({ type: 'separator' })
  template.push({
    label: 'Open AutoDoc',
    click: showWindowFn
  })
  template.push({ type: 'separator' })
  template.push({
    label: 'Quit AutoDoc',
    click: () => {
      app.quit()
    }
  })

  return Menu.buildFromTemplate(template)
}

export function createTray(getEvents: () => CalendarEvent[], showWindow: () => void): Tray {
  cachedEventsRef = getEvents
  showWindowFn = showWindow

  const iconPath = getTrayIconPath()
  let icon = nativeImage.createFromPath(iconPath)

  if (icon.isEmpty()) {
    console.warn(`Tray icon failed to load from ${iconPath}`)
  }

  if (process.platform === 'darwin') {
    icon.setTemplateImage(true)
  } else {
    icon = icon.resize({ width: 16, height: 16 })
  }

  tray = new Tray(icon)
  tray.setToolTip('AutoDoc')

  // Build menu on every click to get fresh events
  tray.on('click', () => {
    if (tray) {
      tray.setContextMenu(buildMenu())
      tray.popUpContextMenu()
    }
  })

  // Right-click also shows the menu
  tray.on('right-click', () => {
    if (tray) {
      tray.setContextMenu(buildMenu())
      tray.popUpContextMenu()
    }
  })

  // Set initial menu
  tray.setContextMenu(buildMenu())

  return tray
}

export function updateTrayMenu(): void {
  if (tray) {
    tray.setContextMenu(buildMenu())
  }
}
