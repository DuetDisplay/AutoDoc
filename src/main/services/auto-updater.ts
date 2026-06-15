import { autoUpdater } from 'electron-updater'
import { BrowserWindow, app } from 'electron'
import { is } from '@electron-toolkit/utils'
import { logAutodocFailure } from './autodoc-log'

export interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error'
  version?: string
  percent?: number
  error?: string
}

let currentStatus: UpdateStatus = { state: 'idle' }
let errorResetToken = 0

function getUpdaterVersion(info: unknown): string | undefined {
  if (!info || typeof info !== 'object') {
    return undefined
  }

  const version = (info as { version?: unknown }).version
  return typeof version === 'string' ? version : undefined
}

function getDownloadPercent(progress: unknown): number | undefined {
  if (!progress || typeof progress !== 'object') {
    return undefined
  }

  const percent = (progress as { percent?: unknown }).percent
  return typeof percent === 'number' ? percent : undefined
}

function normalizeUpdaterError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}

function formatUpdaterError(err: Error): string {
  const message = err.message || 'Unknown update error'
  const normalized = message.toLowerCase()

  if (
    normalized.includes('404') ||
    normalized.includes('401') ||
    normalized.includes('403') ||
    normalized.includes('not found') ||
    normalized.includes('unable to find latest version')
  ) {
    return 'Auto-update feed is not accessible. GitHub-based updates only work if the published release feed is reachable by the installed app.'
  }

  return message
}

function broadcast(status: UpdateStatus): void {
  if (status.state !== 'error') {
    errorResetToken += 1
  }
  currentStatus = status
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    win.webContents.send('updater:status', status)
  }
}

function reportUpdaterError(message: string, err: unknown): void {
  const error = normalizeUpdaterError(err)
  console.error(`${message}:`, err)
  logAutodocFailure({
    area: 'app',
    message,
    error,
    context: {
      channel: 'stable',
      currentVersion: app.getVersion()
    }
  })
  broadcast({ state: 'error', error: formatUpdaterError(error) })
  // Reset to idle after 30s so it doesn't stay stuck on error
  const resetToken = ++errorResetToken
  setTimeout(() => {
    if (errorResetToken === resetToken && currentStatus.state === 'error') {
      broadcast({ state: 'idle' })
    }
  }, 30_000)
}

function safeCheckForUpdates(): void {
  try {
    void Promise.resolve(autoUpdater.checkForUpdates()).catch((err) => {
      reportUpdaterError('Auto-updater failed to check for updates', err)
    })
  } catch (err) {
    reportUpdaterError('Auto-updater failed to check for updates', err)
  }
}

export function getUpdateStatus(): UpdateStatus {
  return currentStatus
}

function configureUpdateFeedOverride(): void {
  const overrideUrl = process.env.AUTODOC_UPDATE_FEED_URL?.trim()
  if (!overrideUrl) {
    return
  }
  const normalizedUrl = overrideUrl.endsWith('/') ? overrideUrl : `${overrideUrl}/`

  autoUpdater.setFeedURL({
    provider: 'generic',
    url: normalizedUrl
  })

  if (process.env.AUTODOC_TEST_MODE === '1') {
    console.log(`Auto-updater using smoke feed: ${normalizedUrl}`)
  }
}

function shouldQuitAndInstallAfterDownloadForSmoke(): boolean {
  return (
    process.env.AUTODOC_TEST_MODE === '1' &&
    process.env.AUTODOC_UPDATE_QUIT_AND_INSTALL_ON_DOWNLOAD === '1'
  )
}

export function initAutoUpdater(): void {
  if (is.dev) {
    console.log('Auto-updater disabled in dev')
    return
  }

  try {
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.disableDifferentialDownload = true
    configureUpdateFeedOverride()

    autoUpdater.on('checking-for-update', () => {
      broadcast({ state: 'checking' })
    })

    autoUpdater.on('update-available', (info) => {
      broadcast({ state: 'available', version: getUpdaterVersion(info) })
    })

    autoUpdater.on('update-not-available', () => {
      broadcast({ state: 'idle' })
    })

    autoUpdater.on('download-progress', (progress) => {
      const percent = getDownloadPercent(progress)
      broadcast({
        state: 'downloading',
        percent: percent == null ? undefined : Math.round(percent)
      })
    })

    autoUpdater.on('update-downloaded', (info) => {
      broadcast({ state: 'downloaded', version: getUpdaterVersion(info) })
      if (shouldQuitAndInstallAfterDownloadForSmoke()) {
        console.log('Auto-updater smoke install: update downloaded, calling quitAndInstall')
        setTimeout(() => installUpdate(), 1_000)
      }
    })

    autoUpdater.on('error', (err) => {
      reportUpdaterError('Auto-updater failed', err)
    })

    // Check on launch after a short delay
    setTimeout(() => safeCheckForUpdates(), 5_000)

    // Then check every 4 hours
    setInterval(() => safeCheckForUpdates(), 4 * 60 * 60 * 1000)
  } catch (err) {
    reportUpdaterError('Auto-updater failed to initialize', err)
  }
}

export function checkForUpdates(): void {
  safeCheckForUpdates()
}

export function installUpdate(): void {
  try {
    autoUpdater.quitAndInstall()
  } catch (err) {
    reportUpdaterError('Auto-updater failed to install update', err)
  }
}
