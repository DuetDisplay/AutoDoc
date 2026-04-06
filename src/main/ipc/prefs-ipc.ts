import { BrowserWindow, ipcMain } from 'electron'
import type { PrefsStore } from '../services/prefs-store'

function broadcastAnalyticsConsent(enabled: boolean): void {
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    win.webContents.send('prefs:analytics-consent-changed', enabled)
  }
}

export function registerPrefsIpc(
  prefsStore: PrefsStore,
  onAnalyticsConsentChanged?: (enabled: boolean) => void,
): void {
  ipcMain.handle('prefs:get-onboarding-complete', (): boolean => {
    return prefsStore.isOnboardingComplete()
  })

  ipcMain.handle('prefs:set-onboarding-complete', (): void => {
    prefsStore.setOnboardingComplete()
  })

  ipcMain.handle('prefs:get-onboarding-step', (): number => {
    return prefsStore.getOnboardingStep()
  })

  ipcMain.handle('prefs:set-onboarding-step', (_event, step: number): void => {
    prefsStore.setOnboardingStep(step)
  })

  ipcMain.handle('prefs:get-launch-at-login', (): boolean => {
    return prefsStore.getLaunchAtLogin()
  })

  ipcMain.handle('prefs:set-launch-at-login', (_event, enabled: boolean): void => {
    prefsStore.setLaunchAtLogin(enabled)
  })

  ipcMain.handle('prefs:get-analytics-consent', (): boolean | null => {
    return prefsStore.getAnalyticsConsent()
  })

  ipcMain.handle('prefs:set-analytics-consent', (_event, enabled: boolean): void => {
    prefsStore.setAnalyticsConsent(enabled)
    onAnalyticsConsentChanged?.(enabled)
    broadcastAnalyticsConsent(enabled)
  })
}
