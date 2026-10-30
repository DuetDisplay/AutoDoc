import { ipcMain } from 'electron'
import type { AnalyticsLocalSignal, AnalyticsUpgradeTransition } from '../../shared/types'
import type { AnalyticsStateStore } from '../services/analytics-state-store'

export function registerAnalyticsIpc(analyticsStateStore: AnalyticsStateStore): void {
  const watchedSenders = new WeakSet<Electron.WebContents>()
  ipcMain.handle('analytics:get-pending-update-download', (event) => {
    const sender = event.sender
    const senderId = sender.id
    if (!watchedSenders.has(sender)) {
      watchedSenders.add(sender)
      const release = (): void => analyticsStateStore.releasePendingUpdateDownload(senderId)
      sender.once('destroyed', release)
      sender.on('render-process-gone', release)
      sender.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
        if (isMainFrame) release()
      })
    }
    return analyticsStateStore.claimPendingUpdateDownload(senderId)
  })
  ipcMain.handle('analytics:acknowledge-update-download', (event, report: unknown) =>
    analyticsStateStore.acknowledgePendingUpdateDownload(report, event.sender.id)
  )
  ipcMain.handle('analytics:release-update-download', (event) =>
    analyticsStateStore.releasePendingUpdateDownload(event.sender.id)
  )
  ipcMain.handle('analytics:get-state', () => analyticsStateStore.getState())

  ipcMain.handle('analytics:record-local-signal', (_event, signal: AnalyticsLocalSignal): boolean =>
    analyticsStateStore.recordLocalSignal(signal)
  )

  ipcMain.handle('analytics:mark-daily-active', () => analyticsStateStore.markDailyActive())

  ipcMain.handle('analytics:start-session', () => analyticsStateStore.startSession())

  ipcMain.handle('analytics:end-session', () => analyticsStateStore.endSession())

  ipcMain.handle('analytics:get-consent-snapshot', () => analyticsStateStore.getConsentSnapshot())

  ipcMain.handle('analytics:get-pending-upgrade', () => analyticsStateStore.getPendingUpgrade())

  ipcMain.handle(
    'analytics:acknowledge-upgrade',
    (_event, transition: AnalyticsUpgradeTransition): boolean =>
      analyticsStateStore.acknowledgePendingUpgrade(transition)
  )
}
