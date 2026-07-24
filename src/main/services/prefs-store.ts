import Store from 'electron-store'
import { app } from 'electron'

const isE2E = process.env.AUTODOC_E2E === '1'
const isRealSetupTest = process.env.AUTODOC_TEST_REAL_SETUP === '1'

interface PrefsSchema {
  onboardingComplete: boolean
  onboardingStep: number
  onboardingMicSettingsOpened: boolean
  onboardingScreenSettingsOpened: boolean
  launchAtLogin: boolean
  analyticsConsent: boolean | null // null = not yet asked
  diagnosticLogUploadConsent: boolean
  experimentalSpeakerDiarization: boolean
  lowSpecMacProcessingBannerDismissed: boolean
  transcriptionPerformanceMode: 'balanced' | 'fast'
  transcriptionQualityMode: 'fast' | 'balanced'
}

function createPrefsStore(): Store<PrefsSchema> {
  return new Store<PrefsSchema>({
    name: 'autodoc-prefs',
    defaults: {
      onboardingComplete: false,
      onboardingStep: 0,
      onboardingMicSettingsOpened: false,
      onboardingScreenSettingsOpened: false,
      launchAtLogin: true,
      analyticsConsent: null,
      diagnosticLogUploadConsent: false,
      experimentalSpeakerDiarization: false,
      lowSpecMacProcessingBannerDismissed: false,
      transcriptionPerformanceMode: 'balanced',
      transcriptionQualityMode: 'balanced'
    }
  })
}

let rejectedAccurateQualityModeLogged = false

export function readInitialAnalyticsConsent(): boolean | null {
  return createPrefsStore().get('analyticsConsent')
}

export function readInitialDiagnosticLogUploadConsent(): boolean {
  return createPrefsStore().get('diagnosticLogUploadConsent')
}

export class PrefsStore {
  private store: Store<PrefsSchema>

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

  getTranscriptionPerformanceMode(): 'balanced' | 'fast' {
    const mode = this.store.get('transcriptionPerformanceMode')
    return mode === 'fast' ? 'fast' : 'balanced'
  }

  setTranscriptionPerformanceMode(mode: 'balanced' | 'fast'): void {
    this.store.set('transcriptionPerformanceMode', mode === 'fast' ? 'fast' : 'balanced')
  }

  getTranscriptionQualityMode(): 'balanced' | 'fast' {
    const mode = this.store.get('transcriptionQualityMode')
    return mode === 'fast' ? 'fast' : 'balanced'
  }

  setTranscriptionQualityMode(mode: 'balanced' | 'fast' | 'accurate'): void {
    if (mode === 'accurate') {
      if (!rejectedAccurateQualityModeLogged) {
        rejectedAccurateQualityModeLogged = true
        console.warn(
          '[prefs] transcriptionQualityMode "accurate" is not available yet; using balanced'
        )
      }
      this.store.set('transcriptionQualityMode', 'balanced')
      return
    }

    this.store.set('transcriptionQualityMode', mode === 'fast' ? 'fast' : 'balanced')
  }

  private applyLaunchAtLogin(): void {
    if (isE2E || isRealSetupTest) return
    app.setLoginItemSettings({ openAtLogin: this.store.get('launchAtLogin') })
  }
}
