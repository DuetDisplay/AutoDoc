import { BrowserWindow } from 'electron'

let mainWindow: BrowserWindow | null = null

export function resetMainWindowForTests(): void {
  mainWindow = null
}

export function registerMainWindow(window: BrowserWindow): void {
  mainWindow = window

  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null
    }
  })
}

export function getMainWindow(): BrowserWindow | null {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow
  }

  const fallback = BrowserWindow
    .getAllWindows()
    .find((window) => !window.isDestroyed() && window.isFocusable())

  if (fallback) {
    mainWindow = fallback
  }

  return fallback ?? null
}

export function focusMainWindow(): boolean {
  const window = getMainWindow()
  if (!window) return false

  if (window.isMinimized()) {
    window.restore()
  }

  window.show()
  window.focus()
  return true
}
