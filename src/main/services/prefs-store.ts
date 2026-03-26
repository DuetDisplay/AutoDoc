import Store from 'electron-store'

export class PrefsStore {
  private store: Store

  constructor() {
    this.store = new Store({ name: 'autodoc-prefs' })
  }

  isOnboardingComplete(): boolean {
    return this.store.get('onboardingComplete', false) as boolean
  }

  setOnboardingComplete(): void {
    this.store.set('onboardingComplete', true)
  }
}
