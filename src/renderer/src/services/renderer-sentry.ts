import * as Sentry from '@sentry/electron/renderer'
import { getRendererDiagnosticTrail } from './diagnostic-trail'

let initialized = false
let consentEnabled = false

function ensureInitialized(): void {
  if (initialized) return
  Sentry.init({
    beforeSend(event) {
      if (!consentEnabled) {
        return null
      }

      return {
        ...event,
        extra: {
          ...(event.extra ?? {}),
          diagnosticTrail: getRendererDiagnosticTrail(),
        },
      }
    },
  })
  initialized = true
}

export function bootstrapRendererSentry(enabled: boolean): void {
  consentEnabled = enabled
  if (enabled) {
    ensureInitialized()
  }
}

export function updateRendererSentryConsent(enabled: boolean): void {
  consentEnabled = enabled
  if (enabled) {
    ensureInitialized()
  }
}
