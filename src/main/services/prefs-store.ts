import Store from 'electron-store'
import { app } from 'electron'

interface PrefsSchema {
  onboardingComplete: boolean
  onboardingStep: number
  onboardingScreenSettingsOpened: boolean
  launchAtLogin: boolean
  analyticsConsent: boolean | null // null = not yet asked
}

function createPrefsStore(): Store<PrefsSchema> {
  return new Store<PrefsSchema>({
    name: 'autodoc-prefs',
    defaults: {
      onboardingComplete: false,
      onboardingStep: 0,
      onboardingScreenSettingsOpened: false,
      launchAtLogin: true,
      analyticsConsent: null,
    },
  })
}

export function readInitialAnalyticsConsent(): boolean | null {
  return createPrefsStore().get('analyticsConsent')
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

  getOnboardingScreenSettingsOpened(): boolean {
    return this.store.get('onboardingScreenSettingsOpened')
  }

  setOnboardingScreenSettingsOpened(opened: boolean): void {
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

  private applyLaunchAtLogin(): void {
    app.setLoginItemSettings({ openAtLogin: this.store.get('launchAtLogin') })
  }
}
