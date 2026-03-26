import Store from 'electron-store'
import { app } from 'electron'

interface PrefsSchema {
  onboardingComplete: boolean
  launchAtLogin: boolean
}

export class PrefsStore {
  private store: Store<PrefsSchema>

  constructor() {
    this.store = new Store<PrefsSchema>({
      name: 'autodoc-prefs',
      defaults: { onboardingComplete: false, launchAtLogin: true },
    })

    // Sync the current preference to the OS on startup
    this.applyLaunchAtLogin()
  }

  isOnboardingComplete(): boolean {
    return this.store.get('onboardingComplete')
  }

  setOnboardingComplete(): void {
    this.store.set('onboardingComplete', true)
    // Enable launch at login when onboarding finishes
    this.setLaunchAtLogin(true)
  }

  getLaunchAtLogin(): boolean {
    return this.store.get('launchAtLogin')
  }

  setLaunchAtLogin(enabled: boolean): void {
    this.store.set('launchAtLogin', enabled)
    this.applyLaunchAtLogin()
  }

  private applyLaunchAtLogin(): void {
    app.setLoginItemSettings({ openAtLogin: this.store.get('launchAtLogin') })
  }
}
