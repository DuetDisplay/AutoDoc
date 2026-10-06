import Store from 'electron-store'
import { app } from 'electron'
import {
  DEFAULT_MEETING_LANGUAGE,
  normalizeMeetingLanguage,
  type MeetingLanguageCode
} from '../../shared/meeting-language'

const isE2E = process.env.AUTODOC_E2E === '1'
const isRealSetupTest = process.env.AUTODOC_TEST_REAL_SETUP === '1'

interface PrefsSchema {
  onboardingComplete: boolean
  onboardingLanguageConfirmed: boolean
  onboardingStep: number
  onboardingMicSettingsOpened: boolean
  onboardingScreenSettingsOpened: boolean
  launchAtLogin: boolean
  analyticsConsent: boolean | null // null = not yet asked
  diagnosticLogUploadConsent: boolean
  videoWatermarkVisible: boolean
  meetingLanguage: MeetingLanguageCode
  experimentalSpeakerDiarization: boolean
  lowSpecMacProcessingBannerDismissed: boolean
  notesEngineUpgradeEligible: boolean
  notesEngineReadyDismissed: boolean
}

function createPrefsStore(): Store<PrefsSchema> {
  return new Store<PrefsSchema>({
    name: 'autodoc-prefs',
    defaults: {
      onboardingComplete: false,
      onboardingLanguageConfirmed: false,
      onboardingStep: 0,
      onboardingMicSettingsOpened: false,
      onboardingScreenSettingsOpened: false,
      launchAtLogin: true,
      analyticsConsent: null,
      diagnosticLogUploadConsent: false,
      videoWatermarkVisible: true,
      meetingLanguage: DEFAULT_MEETING_LANGUAGE,
      experimentalSpeakerDiarization: false,
      lowSpecMacProcessingBannerDismissed: false,
      notesEngineUpgradeEligible: false,
      notesEngineReadyDismissed: false
    }
  })
}

export function readInitialAnalyticsConsent(): boolean | null {
  return createPrefsStore().get('analyticsConsent')
}

export function readInitialDiagnosticLogUploadConsent(): boolean {
  return createPrefsStore().get('diagnosticLogUploadConsent')
}

export class PrefsStore {
  private store: Store<PrefsSchema>
  private previousMeetingLanguage: MeetingLanguageCode | null = null

  constructor() {
    this.store = createPrefsStore()

    // Sync the current preference to the OS on startup
    this.applyLaunchAtLogin()
  }

  isOnboardingComplete(): boolean {
    return this.store.get('onboardingComplete')
  }

  setOnboardingComplete(): void {
    this.store.set('onboardingComplete', true)
    this.store.set('onboardingStep', 0)
    this.store.set('onboardingMicSettingsOpened', false)
    this.store.set('onboardingScreenSettingsOpened', false)
    // Enable launch at login when onboarding finishes
    this.setLaunchAtLogin(true)
  }

  getOnboardingLanguageConfirmed(): boolean {
    return this.store.get('onboardingLanguageConfirmed')
  }

  confirmOnboardingLanguage(): void {
    this.store.set('onboardingLanguageConfirmed', true)
  }

  getOnboardingStep(): number {
    return this.store.get('onboardingStep')
  }

  setOnboardingStep(step: number): void {
    this.store.set('onboardingStep', step)
  }

  getOnboardingPermissionSettingsOpened(panel: 'microphone' | 'screen'): boolean {
    if (panel === 'microphone') {
      return this.store.get('onboardingMicSettingsOpened')
    }

    return this.store.get('onboardingScreenSettingsOpened')
  }

  setOnboardingPermissionSettingsOpened(panel: 'microphone' | 'screen', opened: boolean): void {
    if (panel === 'microphone') {
      this.store.set('onboardingMicSettingsOpened', opened)
      return
    }

    this.store.set('onboardingScreenSettingsOpened', opened)
  }

  getLaunchAtLogin(): boolean {
    return this.store.get('launchAtLogin')
  }

  setLaunchAtLogin(enabled: boolean): void {
    this.store.set('launchAtLogin', enabled)
    this.applyLaunchAtLogin()
  }

  getAnalyticsConsent(): boolean | null {
    return this.store.get('analyticsConsent')
  }

  setAnalyticsConsent(enabled: boolean): void {
    this.store.set('analyticsConsent', enabled)
  }

  getDiagnosticLogUploadConsent(): boolean {
    return this.store.get('diagnosticLogUploadConsent')
  }

  setDiagnosticLogUploadConsent(enabled: boolean): void {
    this.store.set('diagnosticLogUploadConsent', enabled)
  }

  getVideoWatermarkVisible(): boolean {
    return this.store.get('videoWatermarkVisible')
  }

  setVideoWatermarkVisible(visible: boolean): void {
    this.store.set('videoWatermarkVisible', visible)
  }

  getMeetingLanguage(): MeetingLanguageCode {
    return normalizeMeetingLanguage(this.store.get('meetingLanguage'))
  }

  setMeetingLanguage(language: unknown): void {
    const next = normalizeMeetingLanguage(language)
    const current = this.getMeetingLanguage()
    if (next !== current) {
      this.previousMeetingLanguage = current
    }
    this.store.set('meetingLanguage', next)
  }

  /** Undo a tentative pick when first-use setup locks that language. */
  restorePreviousMeetingLanguageIfCurrent(lockedLanguage: unknown): MeetingLanguageCode {
    const locked = normalizeMeetingLanguage(lockedLanguage)
    if (this.getMeetingLanguage() !== locked) {
      return this.getMeetingLanguage()
    }
    const previous = this.previousMeetingLanguage ?? DEFAULT_MEETING_LANGUAGE
    this.store.set('meetingLanguage', previous)
    return previous
  }

  getExperimentalSpeakerDiarization(): boolean {
    return false
  }

  setExperimentalSpeakerDiarization(_enabled: boolean): void {
    this.store.set('experimentalSpeakerDiarization', false)
  }

  getLowSpecMacProcessingBannerDismissed(): boolean {
    return this.store.get('lowSpecMacProcessingBannerDismissed')
  }

  setLowSpecMacProcessingBannerDismissed(dismissed: boolean): void {
    this.store.set('lowSpecMacProcessingBannerDismissed', dismissed)
  }

  getNotesEngineUpgradeEligible(): boolean {
    return this.store.get('notesEngineUpgradeEligible')
  }

  setNotesEngineUpgradeEligible(eligible: boolean): void {
    this.store.set('notesEngineUpgradeEligible', eligible)
  }

  getNotesEngineReadyDismissed(): boolean {
    return this.store.get('notesEngineReadyDismissed')
  }

  setNotesEngineReadyDismissed(dismissed: boolean): void {
    this.store.set('notesEngineReadyDismissed', dismissed)
    if (dismissed) {
      this.store.set('notesEngineUpgradeEligible', false)
    }
  }

  private applyLaunchAtLogin(): void {
    if (isE2E || isRealSetupTest) return
    app.setLoginItemSettings({ openAtLogin: this.store.get('launchAtLogin') })
  }
}
