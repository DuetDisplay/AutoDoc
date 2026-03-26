import Store from 'electron-store'

interface PrefsSchema {
  onboardingComplete: boolean
}

export class PrefsStore {
  private store: Store<PrefsSchema>

  constructor() {
    this.store = new Store<PrefsSchema>({
      name: 'autodoc-prefs',
      defaults: { onboardingComplete: false },
    })
  }

  isOnboardingComplete(): boolean {
    return this.store.get('onboardingComplete')
  }

  setOnboardingComplete(): void {
    this.store.set('onboardingComplete', true)
  }
}
