import { beforeEach, describe, expect, it, vi } from 'vitest'

const { logAutodocEvent, logAutodocFailure } = vi.hoisted(() => ({
  logAutodocEvent: vi.fn(),
  logAutodocFailure: vi.fn()
}))

vi.mock('../autodoc-log', () => ({ logAutodocEvent, logAutodocFailure }))

import { notesModelSetupError } from '../notes-model-errors'
import { reportOllamaSetupFailure } from '../ollama-setup-report'
import { withSentryFingerprint, type FingerprintedError } from '../sentry-fingerprint'

describe('reportOllamaSetupFailure', () => {
  beforeEach(() => vi.clearAllMocks())

  it('gives an unnamed timeout a clear title and groups it by step', () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'TimeoutError'
    })

    reportOllamaSetupFailure(timeout, 'starting')

    const report = logAutodocFailure.mock.calls[0][0]
    expect(report.message).toBe('Failed to start managed Ollama server')
    expect(report.error.message).toBe('Ollama setup failed while starting')
    expect(report.context.reason).toBe('The operation was aborted due to timeout')
    expect((report.error as FingerprintedError).sentryFingerprint).toEqual([
      'ollama-setup-failed',
      'starting'
    ])
  })

  it('keeps a fingerprint the error already has', () => {
    reportOllamaSetupFailure(
      withSentryFingerprint(new Error('recovery not ready'), ['ollama-recovery-not-ready']),
      'starting'
    )

    expect(logAutodocFailure.mock.calls[0][0].error.sentryFingerprint).toEqual([
      'ollama-recovery-not-ready'
    ])
  })

  it('does not report a server exit a second time', () => {
    reportOllamaSetupFailure(
      withSentryFingerprint(new Error('Ollama exited with code 1, signal null'), [
        'ollama-server-exited',
        '1'
      ]),
      'starting'
    )

    expect(logAutodocFailure).not.toHaveBeenCalled()
    expect(logAutodocEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Failed to start managed Ollama server',
        context: expect.objectContaining({ reason: 'Ollama exited with code 1, signal null' })
      })
    )
  })
})

describe('notesModelSetupError', () => {
  it.each([
    ['a timeout', new Error('The operation was aborted due to timeout')],
    ['an existing setup error', new Error("Ollama notes model setup failed: 'x' is not installed")]
  ])('groups %s under one issue', (_label, error) => {
    expect((notesModelSetupError(error) as FingerprintedError).sentryFingerprint).toEqual([
      'ollama-notes-model-setup'
    ])
  })
})
