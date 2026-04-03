import * as Sentry from '@sentry/electron/renderer'
import { getRendererDiagnosticTrail } from './diagnostic-trail'
import { normalizeSentryBreadcrumb } from '../../../shared/sentry-breadcrumbs'
import { installSemanticClickBreadcrumbs } from './sentry-click-breadcrumbs'

let initialized = false
let consentEnabled = false
let semanticClickBreadcrumbsInstalled = false

function ensureInitialized(): void {
  if (initialized) return
  Sentry.init({
    beforeBreadcrumb: normalizeSentryBreadcrumb,
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

  if (!semanticClickBreadcrumbsInstalled) {
    installSemanticClickBreadcrumbs(() => consentEnabled)
    semanticClickBreadcrumbsInstalled = true
  }

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
