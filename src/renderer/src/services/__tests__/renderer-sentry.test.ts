import { beforeEach, describe, expect, it, vi } from 'vitest'

const { sentryModule, sentryScope } = vi.hoisted(() => {
  const scope = {
    setTag: vi.fn(),
    setExtras: vi.fn()
  }

  return {
    sentryScope: scope,
    sentryModule: {
      addBreadcrumb: vi.fn(),
      captureException: vi.fn(),
      init: vi.fn(),
      withScope: vi.fn((callback: (arg: typeof scope) => void) => callback(scope))
    }
  }
})

vi.mock('@sentry/electron/renderer', () => sentryModule)
vi.mock('../diagnostic-trail', () => ({
  getRendererDiagnosticTrail: vi.fn(() => [])
}))
vi.mock('../sentry-click-breadcrumbs', () => ({
  installSemanticClickBreadcrumbs: vi.fn()
}))

import { captureRecordingStartFailure, updateRendererSentryConsent } from '../renderer-sentry'

describe('captureRecordingStartFailure', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    updateRendererSentryConsent(false)
  })

  it('reports unexpected recording start failures when consent is enabled', () => {
    updateRendererSentryConsent(true)

    captureRecordingStartFailure(new Error('Failed to start video recorder (video/webm)'), {
      sourceType: 'window',
      sourceSelectionMode: 'manual'
    })

    expect(sentryModule.withScope).toHaveBeenCalledTimes(1)
    expect(sentryScope.setTag).toHaveBeenCalledWith('feature_area', 'recording')
    expect(sentryScope.setTag).toHaveBeenCalledWith('recording_phase', 'start')
    expect(sentryScope.setTag).toHaveBeenCalledWith('source_type', 'window')
    expect(sentryScope.setExtras).toHaveBeenCalledWith(
      expect.objectContaining({
        recordingSourceType: 'window',
        sourceSelectionMode: 'manual',
        recordingStartErrorMessage: 'Failed to start video recorder (video/webm)'
      })
    )
    expect(sentryModule.captureException).toHaveBeenCalledTimes(1)
  })

  it('does not report expected permission failures', () => {
    updateRendererSentryConsent(true)

    captureRecordingStartFailure(
      new Error('Screen capture stream is not live. Screen recording permission may be missing.'),
      {
        sourceType: 'screen',
        sourceSelectionMode: 'assisted'
      }
    )

    expect(sentryModule.withScope).not.toHaveBeenCalled()
    expect(sentryModule.captureException).not.toHaveBeenCalled()
  })
})
