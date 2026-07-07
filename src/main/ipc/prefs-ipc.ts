import { BrowserWindow, ipcMain } from 'electron'
import type { PrefsStore } from '../services/prefs-store'

function broadcastAnalyticsConsent(enabled: boolean): void {
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    win.webContents.send('prefs:analytics-consent-changed', enabled)
  }
}

function broadcastDiagnosticLogUploadConsent(enabled: boolean): void {
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    win.webContents.send('prefs:diagnostic-log-upload-consent-changed', enabled)
  }
}

function broadcastExperimentalSpeakerDiarization(enabled: boolean): void {
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    win.webContents.send('prefs:experimental-speaker-diarization-changed', enabled)
  }
}

export function registerPrefsIpc(
  prefsStore: PrefsStore,
  onAnalyticsConsentChanged?: (enabled: boolean) => void,
  onDiagnosticLogUploadConsentChanged?: (enabled: boolean) => void,
  onExperimentalSpeakerDiarizationChanged?: (enabled: boolean) => void
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

  ipcMain.handle(
    'prefs:get-onboarding-permission-settings-opened',
    (_event, panel: 'microphone' | 'screen'): boolean => {
      return prefsStore.getOnboardingPermissionSettingsOpened(panel)
    }
  )

  ipcMain.handle(
    'prefs:set-onboarding-permission-settings-opened',
    (_event, panel: 'microphone' | 'screen', opened: boolean): void => {
      prefsStore.setOnboardingPermissionSettingsOpened(panel, opened)
    }
  )

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

  ipcMain.handle('prefs:get-diagnostic-log-upload-consent', (): boolean => {
    return prefsStore.getDiagnosticLogUploadConsent()
  })

  ipcMain.handle('prefs:set-diagnostic-log-upload-consent', (_event, enabled: boolean): void => {
    prefsStore.setDiagnosticLogUploadConsent(enabled)
    onDiagnosticLogUploadConsentChanged?.(enabled)
    broadcastDiagnosticLogUploadConsent(enabled)
  })

  ipcMain.handle('prefs:get-experimental-speaker-diarization', (): boolean => {
    return false
  })

  ipcMain.handle('prefs:set-experimental-speaker-diarization', (_event, enabled: boolean): void => {
    prefsStore.setExperimentalSpeakerDiarization(enabled)
    onExperimentalSpeakerDiarizationChanged?.(false)
    broadcastExperimentalSpeakerDiarization(false)
  })

  ipcMain.handle('prefs:get-low-spec-mac-processing-banner-dismissed', (): boolean => {
    return prefsStore.getLowSpecMacProcessingBannerDismissed()
  })

  ipcMain.handle(
    'prefs:set-low-spec-mac-processing-banner-dismissed',
    (_event, dismissed: boolean): void => {
      prefsStore.setLowSpecMacProcessingBannerDismissed(dismissed)
    }
  )

  ipcMain.handle('prefs:get-transcription-performance-mode', (): 'balanced' | 'fast' => {
    return prefsStore.getTranscriptionPerformanceMode()
  })

  ipcMain.handle(
    'prefs:set-transcription-performance-mode',
    (_event, mode: 'balanced' | 'fast'): void => {
      prefsStore.setTranscriptionPerformanceMode(mode)
    }
  )

  ipcMain.handle('prefs:get-transcription-quality-mode', (): 'balanced' | 'fast' => {
    return prefsStore.getTranscriptionQualityMode()
  })

  ipcMain.handle(
    'prefs:set-transcription-quality-mode',
    (_event, mode: 'balanced' | 'fast' | 'accurate'): void => {
      prefsStore.setTranscriptionQualityMode(mode)
    }
  )
}
