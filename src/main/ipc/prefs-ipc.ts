import { ipcMain } from 'electron'
import type { PrefsStore } from '../services/prefs-store'

export function registerPrefsIpc(prefsStore: PrefsStore): void {
  ipcMain.handle('prefs:get-onboarding-complete', (): boolean => {
    return prefsStore.isOnboardingComplete()
  })

  ipcMain.handle('prefs:set-onboarding-complete', (): void => {
    prefsStore.setOnboardingComplete()
  })
}
