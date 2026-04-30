import * as Sentry from '@sentry/electron/renderer'
import { getRendererDiagnosticTrail } from './diagnostic-trail'
import { normalizeSentryBreadcrumb } from '../../../shared/sentry-breadcrumbs'
import { installSemanticClickBreadcrumbs } from './sentry-click-breadcrumbs'

let initialized = false
let consentEnabled = false
let semanticClickBreadcrumbsInstalled = false

interface RecordingStartFailureContext {
  sourceType: string
  sourceSelectionMode: 'manual' | 'assisted'
}

interface RecordingRecoveryFailureContext {
  meetingId: string
  sourceType: string
  segmentIndex: number
  reason: string
  attemptCount: number
  expectedAudio: {
    hasMic: boolean
    hasSystemAudio: boolean
  }
  actualAudio?: {
    hasMic: boolean
    hasSystemAudio: boolean
  }
  missingSources?: Array<'mic' | 'system'>
  failureKind: 'failed' | 'degraded'
}

function getErrorName(error: unknown): string {
  if (error instanceof Error && error.name) {
    return error.name
  }

  if (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name) {
    return error.name
  }

  return 'UnknownError'
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message
  }

  return String(error)
}

function isExpectedRecordingStartFailure(error: unknown): boolean {
  const name = getErrorName(error)
  const message = getErrorMessage(error).toLowerCase()

  return (
    name === 'NotAllowedError' ||
    name === 'PermissionDeniedError' ||
    name === 'SecurityError' ||
    message.includes('already recording') ||
    message.includes('capture already active') ||
    message.includes('screen capture stream is not live') ||
    message.includes('screen recording permission may be missing') ||
    message.includes('could not list capture sources') ||
    message.includes('permission denied') ||
    message.includes('permission dismissed')
  )
}

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
          diagnosticTrail: getRendererDiagnosticTrail()
        }
      }
    }
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

export function captureRecordingStartFailure(
  error: unknown,
  context: RecordingStartFailureContext
): void {
  if (!consentEnabled || isExpectedRecordingStartFailure(error)) {
    return
  }

  ensureInitialized()

  Sentry.withScope((scope) => {
    scope.setTag('feature_area', 'recording')
    scope.setTag('recording_phase', 'start')
    scope.setTag('source_type', context.sourceType)
    scope.setExtras({
      recordingSourceType: context.sourceType,
      sourceSelectionMode: context.sourceSelectionMode,
      recordingStartErrorName: getErrorName(error),
      recordingStartErrorMessage: getErrorMessage(error)
    })
    Sentry.captureException(error instanceof Error ? error : new Error(getErrorMessage(error)))
  })
}

export function captureRecordingRecoveryFailure(
  error: unknown,
  context: RecordingRecoveryFailureContext
): void {
  if (!consentEnabled) {
    return
  }

  ensureInitialized()

  Sentry.withScope((scope) => {
    scope.setTag('feature_area', 'recording')
    scope.setTag('recording_phase', 'recovery')
    scope.setTag('source_type', context.sourceType)
    scope.setTag('recovery_failure_kind', context.failureKind)
    scope.setExtras({
      meetingId: context.meetingId,
      recordingSourceType: context.sourceType,
      recoverySegmentIndex: context.segmentIndex,
      recoveryReason: context.reason,
      recoveryAttemptCount: context.attemptCount,
      recoveryExpectedAudio: context.expectedAudio,
      recoveryActualAudio: context.actualAudio ?? null,
      recoveryMissingSources: context.missingSources ?? [],
      recoveryFailureKind: context.failureKind,
      recoveryErrorName: getErrorName(error),
      recoveryErrorMessage: getErrorMessage(error)
    })
    Sentry.captureException(error instanceof Error ? error : new Error(getErrorMessage(error)))
  })
}
