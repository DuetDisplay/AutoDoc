import { autoUpdater } from 'electron-updater'
import { BrowserWindow } from 'electron'
import { is } from '@electron-toolkit/utils'

export interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error'
  version?: string
  percent?: number
  error?: string
}

let currentStatus: UpdateStatus = { state: 'idle' }

function broadcast(status: UpdateStatus): void {
  currentStatus = status
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    win.webContents.send('updater:status', status)
  }
}

export function getUpdateStatus(): UpdateStatus {
  return currentStatus
}

export function initAutoUpdater(): void {
  if (is.dev) {
    console.log('Auto-updater disabled in dev')
    return
  }

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    broadcast({ state: 'checking' })
  })

  autoUpdater.on('update-available', (info) => {
    broadcast({ state: 'available', version: info.version })
  })

  autoUpdater.on('update-not-available', () => {
    broadcast({ state: 'idle' })
  })

  autoUpdater.on('download-progress', (progress) => {
    broadcast({ state: 'downloading', percent: Math.round(progress.percent) })
  })

  autoUpdater.on('update-downloaded', (info) => {
    broadcast({ state: 'downloaded', version: info.version })
  })

  autoUpdater.on('error', (err) => {
    console.error('Auto-updater error:', err)
    broadcast({ state: 'error', error: err.message })
    // Reset to idle after 30s so it doesn't stay stuck on error
    setTimeout(() => broadcast({ state: 'idle' }), 30_000)
  })

  // Check on launch after a short delay
  setTimeout(() => autoUpdater.checkForUpdates(), 5_000)

  // Then check every 4 hours
  setInterval(() => autoUpdater.checkForUpdates(), 4 * 60 * 60 * 1000)
}

export function checkForUpdates(): void {
  autoUpdater.checkForUpdates()
}

export function installUpdate(): void {
  autoUpdater.quitAndInstall()
}
