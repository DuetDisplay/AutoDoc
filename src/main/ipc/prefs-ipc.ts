import { refreshNotificationLocale } from '../notification-window'
import { app, BrowserWindow, ipcMain } from 'electron'
import { applyNativeAppearance } from '../services/appearance-runtime'
import { isAppearanceMode, normalizeAppearance, type AppearanceMode } from '../../shared/appearance'
import {
  isUiLanguageCode,
  normalizeUiLanguage,
  type UiLanguageCode
} from '../../shared/ui-language'
import type { PrefsStore } from '../services/prefs-store'
import { setMainUiLanguage } from '../services/ui-locale'
import { refreshApplicationMenu } from '../services/application-menu'
import {
  isMeetingLanguageAvailable,
  isMeetingLanguageCode,
  normalizeMeetingLanguage,
  type MeetingLanguageAvailability,
  type MeetingLanguageCode
} from '../../shared/meeting-language'
import {
  currentMeetingLanguageAvailability,
  waitForWindowsNotesModel
} from '../services/meeting-language-availability'
import { getWindowsMeetingLanguageAvailability } from '../services/windows-multilingual-readiness'

export function meetingLanguageNeedsMemoryMessage(
  language: unknown,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform === 'win32') {
    return `Meeting language ${normalizeMeetingLanguage(language)} needs a more powerful PC`
  }
  return `Meeting language ${normalizeMeetingLanguage(language)} needs 16 GB of memory on this Mac`
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

function broadcastAppearance(appearance: AppearanceMode): void {
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    win.webContents.send('prefs:appearance-changed', appearance)
  }
}

function broadcastUiLanguage(language: UiLanguageCode): void {
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    win.webContents.send('prefs:ui-language-changed', language)
  }
}

export function registerPrefsIpc(
  prefsStore: PrefsStore,
  onAnalyticsConsentChanged?: (enabled: boolean) => void,
  onDiagnosticLogUploadConsentChanged?: (enabled: boolean) => void,
  onExperimentalSpeakerDiarizationChanged?: (enabled: boolean) => void,
  getMeetingLanguageAvailability: () => MeetingLanguageAvailability = currentMeetingLanguageAvailability
): void {
  applyNativeAppearance(prefsStore.getAppearance())
  setMainUiLanguage(prefsStore.getUiLanguage())

  ipcMain.handle('prefs:get-onboarding-language-confirmed', () =>
    prefsStore.getOnboardingLanguageConfirmed()
  )
  ipcMain.handle('prefs:confirm-onboarding-language', () => prefsStore.confirmOnboardingLanguage())
  ipcMain.handle('prefs:get-meeting-language-announcement-pending', async (): Promise<boolean> => {
    await waitForWindowsNotesModel()
    return (
      prefsStore.isMeetingLanguageAnnouncementPending() &&
      !getMeetingLanguageAvailability().restricted
    )
  })
  ipcMain.handle('prefs:dismiss-meeting-language-announcement', () =>
    prefsStore.dismissMeetingLanguageAnnouncement()
  )
  ipcMain.handle('prefs:get-ui-appearance-announcement-pending', () =>
    prefsStore.isUiAppearanceAnnouncementPending()
  )
  ipcMain.handle('prefs:dismiss-ui-appearance-announcement', () =>
    prefsStore.dismissUiAppearanceAnnouncement()
  )
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

  ipcMain.handle('prefs:get-appearance', (): AppearanceMode => {
    return prefsStore.getAppearance()
  })

  ipcMain.handle('prefs:set-appearance', (_event, appearance: unknown): void => {
    if (!isAppearanceMode(appearance)) {
      throw new Error('This appearance setting is not supported.')
    }
    prefsStore.setAppearance(appearance)
    applyNativeAppearance(normalizeAppearance(appearance))
    broadcastAppearance(normalizeAppearance(appearance))
  })

  ipcMain.handle('prefs:get-ui-language', (): UiLanguageCode => {
    return prefsStore.getUiLanguage()
  })

  ipcMain.handle('prefs:set-ui-language', (_event, language: unknown): void => {
    if (!isUiLanguageCode(language)) {
      throw new Error('This app language is not supported.')
    }
    const next = normalizeUiLanguage(language)
    prefsStore.setUiLanguage(next)
    setMainUiLanguage(next)
    refreshApplicationMenu()
    broadcastUiLanguage(next)
    refreshNotificationLocale()
  })

  ipcMain.handle('prefs:get-meeting-language', (): MeetingLanguageCode => {
    return prefsStore.getMeetingLanguage()
  })

  ipcMain.handle(
    'prefs:get-meeting-language-availability',
    async (): Promise<MeetingLanguageAvailability> => {
      await waitForWindowsNotesModel()
      return getMeetingLanguageAvailability()
    }
  )

  // Saves can overlap while Windows availability is checked; only the newest
  // request may write, so a slower earlier request cannot overwrite it.
  let latestMeetingLanguageRequest = 0
  ipcMain.handle('prefs:set-meeting-language', async (_event, language: unknown): Promise<void> => {
    const request = ++latestMeetingLanguageRequest
    if (!isMeetingLanguageCode(language)) {
      throw new Error('This meeting language is not supported.')
    }
    await waitForWindowsNotesModel()
    if (!isMeetingLanguageAvailable(language, getMeetingLanguageAvailability())) {
      throw new Error(meetingLanguageNeedsMemoryMessage(language))
    }
    if (process.platform === 'win32') {
      const engine = await getWindowsMeetingLanguageAvailability(language)
      if (engine.availability === 'locked') {
        throw new Error(engine.reason ?? "This language isn't available on this PC.")
      }
    }
    if (request !== latestMeetingLanguageRequest) return
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
