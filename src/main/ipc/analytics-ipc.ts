import { ipcMain } from 'electron'
import type { AnalyticsLocalSignal } from '../../shared/types'
import type { AnalyticsStateStore } from '../services/analytics-state-store'

export function registerAnalyticsIpc(analyticsStateStore: AnalyticsStateStore): void {
  ipcMain.handle('analytics:get-state', () => analyticsStateStore.getState())

  ipcMain.handle('analytics:record-local-signal', (_event, signal: AnalyticsLocalSignal): boolean =>
    analyticsStateStore.recordLocalSignal(signal)
  )

  ipcMain.handle('analytics:mark-daily-active', () => analyticsStateStore.markDailyActive())

  ipcMain.handle('analytics:start-session', () => analyticsStateStore.startSession())

  ipcMain.handle('analytics:end-session', () => analyticsStateStore.endSession())

  ipcMain.handle('analytics:get-consent-snapshot', () => analyticsStateStore.getConsentSnapshot())
}
