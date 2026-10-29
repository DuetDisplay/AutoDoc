import { beforeEach, describe, expect, it, vi } from 'vitest'
import { captureError, disableSentryReporter, initSentryReporter } from '../sentry-reporter'

vi.mock('../diagnostic-trail', () => ({
  getDiagnosticTrail: vi.fn(() => [{ category: 'test', action: 'ran' }])
}))

describe('sentry reporter', () => {
  beforeEach(() => {
    disableSentryReporter()
  })

  it('adds a diagnostic log attachment to the scope when provided', () => {
    const addAttachment = vi.fn()
    const setTag = vi.fn()
    const setExtras = vi.fn()
    const captureException = vi.fn()

    initSentryReporter({
      withScope(callback: (scope: unknown) => void) {
        callback({
          addAttachment,
          setTag,
          setExtras
        })
      },
      captureException
    } as never)

    captureError(new Error('boom'), {
      area: 'app',
      diagnosticLogAttachment: {
        filename: 'autodoc-diagnostic-tail.log',
        contentType: 'text/plain',
        data: 'sanitized log'
      }
    })

    expect(setTag).toHaveBeenCalledWith('area', 'app')
    expect(setExtras).toHaveBeenCalledWith({
      diagnosticTrail: [{ category: 'test', action: 'ran' }]
    })
    expect(addAttachment).toHaveBeenCalledWith({
      filename: 'autodoc-diagnostic-tail.log',
      contentType: 'text/plain',
      data: 'sanitized log'
    })
    expect(captureException).toHaveBeenCalled()
  })

  function captureWithFingerprintScope(
    error: unknown,
    context: Parameters<typeof captureError>[1]
  ): ReturnType<typeof vi.fn> {
    const setFingerprint = vi.fn()
    initSentryReporter({
      withScope(callback: (scope: unknown) => void) {
        callback({ setTag: vi.fn(), setExtras: vi.fn(), setFingerprint })
      },
      captureException: vi.fn()
    } as never)
    captureError(error, context)
    return setFingerprint
  }

  it('applies an explicit fingerprint to the scope', () => {
    const setFingerprint = captureWithFingerprintScope(new Error('boom'), {
      area: 'recording',
      fingerprint: ['ffmpeg-exit', 'merge', '228']
    })
    expect(setFingerprint).toHaveBeenCalledWith(['ffmpeg-exit', 'merge', '228'])
  })

  it('falls back to the error sentryFingerprint property', () => {
    const error = Object.assign(new Error('ffmpeg exited'), {
      sentryFingerprint: ['ffmpeg-exit', 'convert', '1']
    })
    const setFingerprint = captureWithFingerprintScope(error, { area: 'transcription' })
    expect(setFingerprint).toHaveBeenCalledWith(['ffmpeg-exit', 'convert', '1'])
  })

  it('prefers the explicit fingerprint over the error property', () => {
    const error = Object.assign(new Error('x'), { sentryFingerprint: ['from-error'] })
    const setFingerprint = captureWithFingerprintScope(error, {
      area: 'app',
      fingerprint: ['explicit']
    })
    expect(setFingerprint).toHaveBeenCalledWith(['explicit'])
  })

  it('leaves default grouping alone when no fingerprint is available', () => {
    const setFingerprint = captureWithFingerprintScope(new Error('plain'), { area: 'app' })
    expect(setFingerprint).not.toHaveBeenCalled()
  })
})
