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
})
