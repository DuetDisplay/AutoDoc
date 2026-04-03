import * as Sentry from '@sentry/electron/renderer'

let initialized = false

function ensureInitialized(): void {
  if (initialized) return
  Sentry.init()
  initialized = true
}

export function bootstrapRendererSentry(enabled: boolean): void {
  if (enabled) {
    ensureInitialized()
  }
}

export function updateRendererSentryConsent(enabled: boolean): void {
  if (enabled) {
    ensureInitialized()
  }
}
