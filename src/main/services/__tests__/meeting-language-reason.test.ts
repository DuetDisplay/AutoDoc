import { describe, expect, it } from 'vitest'
import { classifyMacLanguageSetupError } from '../meeting-language-reason'

describe('classifyMacLanguageSetupError', () => {
  it.each([
    [Object.assign(new Error('write failed'), { code: 'ENOSPC' }), 'setup-disk-full'],
    [
      new Error('The bundled speech runtime is missing. Reinstall AutoDoc.'),
      'speech-runtime-missing'
    ],
    [
      new Error('Downloaded speech model failed SHA256 verification: expected a, received b.'),
      'setup-verification-failed'
    ],
    [
      new Error('Speech model x.bin has an unexpected size: 1, expected 2.'),
      'setup-verification-failed'
    ],
    [
      new Error('Failed to download speech model: 503 Service Unavailable'),
      'setup-download-failed'
    ],
    [new Error('fetch failed'), 'setup-download-failed'],
    [new Error('something nobody planned for'), 'setup-failed'],
    ['plain string failure', 'setup-failed']
  ])('maps %s to %s', (error, code) => {
    expect(classifyMacLanguageSetupError(error)).toBe(code)
  })
})
