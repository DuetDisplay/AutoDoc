import { app, BrowserWindow, ipcMain } from 'electron'
import type { PrefsStore } from '../services/prefs-store'
import {
  isMeetingLanguageAvailable,
  normalizeMeetingLanguage,
  type MeetingLanguageAvailability,
  type MeetingLanguageCode
} from '../../shared/meeting-language'
import { currentMeetingLanguageAvailability } from '../services/meeting-language-availability'
import { getWindowsMeetingLanguageAvailability } from '../services/windows-multilingual-readiness'

export function meetingLanguageNeedsMemoryMessage(
  language: unknown,
  platform: NodeJS.Platform = process.platform
): string {
  const machine = platform === 'win32' ? 'PC' : 'Mac'
  return `Meeting language ${normalizeMeetingLanguage(language)} needs 16 GB of memory on this ${machine}`
}

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

function broadcastVideoWatermarkVisible(visible: boolean): void {
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    win.webContents.send('prefs:video-watermark-visible-changed', visible)
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
  onExperimentalSpeakerDiarizationChanged?: (enabled: boolean) => void,
  getMeetingLanguageAvailability: () => MeetingLanguageAvailability = currentMeetingLanguageAvailability
): void {
  ipcMain.handle('prefs:get-onboarding-language-confirmed', () =>
    prefsStore.getOnboardingLanguageConfirmed()
  )
  ipcMain.handle('prefs:confirm-onboarding-language', () => prefsStore.confirmOnboardingLanguage())
  ipcMain.handle('app:get-locale', () => app.getLocale())

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

  ipcMain.handle('prefs:get-video-watermark-visible', (): boolean => {
    return prefsStore.getVideoWatermarkVisible()
  })

  ipcMain.handle('prefs:set-video-watermark-visible', (_event, visible: boolean): void => {
    prefsStore.setVideoWatermarkVisible(visible)
    broadcastVideoWatermarkVisible(visible)
  })

  ipcMain.handle('prefs:get-meeting-language', (): MeetingLanguageCode => {
    return prefsStore.getMeetingLanguage()
  })

  ipcMain.handle(
    'prefs:get-meeting-language-availability',
    (): MeetingLanguageAvailability => getMeetingLanguageAvailability()
  )

  ipcMain.handle('prefs:set-meeting-language', async (_event, language: unknown): Promise<void> => {
    if (!isMeetingLanguageAvailable(language, getMeetingLanguageAvailability())) {
      throw new Error(meetingLanguageNeedsMemoryMessage(language))
    }
    if (process.platform === 'win32') {
      const engine = await getWindowsMeetingLanguageAvailability(String(language ?? ''))
      if (engine.availability === 'locked') {
        throw new Error(engine.reason ?? "This language isn't available on this PC.")
      }
    }
    prefsStore.setMeetingLanguage(language)
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

  ipcMain.handle('prefs:get-notes-engine-upgrade-eligible', (): boolean => {
    return prefsStore.getNotesEngineUpgradeEligible()
  })

  ipcMain.handle('prefs:get-notes-engine-ready-dismissed', (): boolean => {
    return prefsStore.getNotesEngineReadyDismissed()
  })

  ipcMain.handle('prefs:set-notes-engine-ready-dismissed', (_event, dismissed: boolean): void => {
    prefsStore.setNotesEngineReadyDismissed(dismissed)
  })
}
