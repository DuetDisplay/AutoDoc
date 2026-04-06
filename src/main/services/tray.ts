import { Tray, Menu, nativeImage, app, shell } from 'electron'
import { join } from 'path'
import type { CalendarEvent } from '../../shared/types'

let tray: Tray | null = null
let cachedEventsRef: () => CalendarEvent[] = () => []
let showWindowFn: () => void = () => {}
let getIsRecordingRef: () => boolean = () => false
let stopRecordingFn: () => void = () => {}

const isDarwin = process.platform === 'darwin'

function getIdleTrayIconPath(): string {
  if (isDarwin) {
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

function getRecordingTrayIconPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'trayRecording.png')
  }
  return join(process.cwd(), 'build', 'trayRecording.png')
}

function loadTrayNativeImage(): ReturnType<typeof nativeImage.createEmpty> {
  const recording = getIsRecordingRef()
  if (isDarwin) {
    const iconPath = recording ? getRecordingTrayIconPath() : getIdleTrayIconPath()
    let icon = nativeImage.createFromPath(iconPath)
    if (icon.isEmpty()) {
      console.warn(`Tray icon failed to load from ${iconPath}`)
    }
    if (recording) {
      icon.setTemplateImage(false)
    } else {
      icon.setTemplateImage(true)
    }
    return icon
  }

  const iconPath = recording ? getRecordingTrayIconPath() : getIdleTrayIconPath()
  let icon = nativeImage.createFromPath(iconPath)
  if (icon.isEmpty()) {
    console.warn(`Tray icon failed to load from ${iconPath}`)
  }
  return icon.resize({ width: 16, height: 16 })
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

  if (getIsRecordingRef()) {
    template.push({
      label: 'Stop recording notes',
      click: () => {
        stopRecordingFn()
      },
    })
    template.push({ type: 'separator' })
  }

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
            shell.openExternal(event.meetingUrl)
          }
        },
      })
    }
  } else {
    template.push({ label: 'No upcoming meetings today', enabled: false })
  }

  template.push({ type: 'separator' })
  template.push({
    label: 'Open AutoDoc',
    click: showWindowFn,
  })
  template.push({ type: 'separator' })
  template.push({
    label: 'Quit AutoDoc',
    click: () => {
      app.quit()
    },
  })

  return Menu.buildFromTemplate(template)
}

function popupTrayMenu(): void {
  if (!tray) return
  tray.popUpContextMenu(buildMenu())
}

export interface TrayRecordingOptions {
  getIsRecording: () => boolean
  stopRecording: () => void
}

export function createTray(
  getEvents: () => CalendarEvent[],
  showWindow: () => void,
  recording: TrayRecordingOptions,
): Tray {
  cachedEventsRef = getEvents
  showWindowFn = showWindow
  getIsRecordingRef = recording.getIsRecording
  stopRecordingFn = recording.stopRecording

  const icon = loadTrayNativeImage()

  tray = new Tray(icon)
  tray.setToolTip('AutoDoc')

  if (isDarwin) {
    // Avoid a persistent context menu on macOS so a click shows our menu instead of only
    // activating the app window (Electron #30073).
    tray.setContextMenu(null)
    tray.on('click', popupTrayMenu)
    tray.on('right-click', popupTrayMenu)
  } else {
    tray.on('click', () => {
      if (tray) {
        tray.setContextMenu(buildMenu())
        tray.popUpContextMenu()
      }
    })
    tray.on('right-click', () => {
      if (tray) {
        tray.setContextMenu(buildMenu())
        tray.popUpContextMenu()
      }
    })
    tray.setContextMenu(buildMenu())
  }

  return tray
}

export function updateTrayMenu(): void {
  if (!tray || isDarwin) return
  tray.setContextMenu(buildMenu())
}

/** Refresh tray icon (recording vs idle) and non-macOS context menu. */
export function refreshTray(): void {
  if (!tray) return
  tray.setImage(loadTrayNativeImage())
  if (isDarwin) {
    const recording = getIsRecordingRef()
    tray.setToolTip(recording ? 'AutoDoc — recording' : 'AutoDoc')
  } else {
    tray.setContextMenu(buildMenu())
  }
}
