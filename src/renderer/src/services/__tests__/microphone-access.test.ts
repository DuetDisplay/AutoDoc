import { describe, expect, it } from 'vitest'
import {
  getMicrophoneCaptureFailureMessage,
  getMicrophoneCaptureFailureMessageKey
} from '../microphone-access'
import { translate } from '../../../../shared/i18n'
import { UI_LANGUAGE_CODES } from '../../../../shared/ui-language'

describe('getMicrophoneCaptureFailureMessage', () => {
  it('provides localized copy for every microphone failure and supported UI language', () => {
    for (const isWindows of [false, true])
      for (const name of [
        'NotAllowedError',
        'SecurityError',
        'NotFoundError',
        'NotReadableError',
        'TrackStartError',
        'UnknownError'
      ]) {
        const key = getMicrophoneCaptureFailureMessageKey({ name, message: '' }, isWindows)
        for (const language of UI_LANGUAGE_CODES.filter((l) => l !== 'en'))
          expect(translate(language, key)).not.toBe(translate('en', key))
      }
  })
  it('keeps the original revoked copy on non-Windows regardless of error name', () => {
    const expected =
      'Microphone access was revoked. AutoDoc needs it to record meetings. Enable it in System Settings → Privacy → Microphone.'

    for (const name of ['NotAllowedError', 'NotFoundError', 'NotReadableError', 'AnythingElse']) {
      expect(getMicrophoneCaptureFailureMessage({ name, message: name }, false)).toBe(expected)
    }
  })

  it('maps error names to specific messages on Windows', () => {
    expect(
      getMicrophoneCaptureFailureMessage({ name: 'NotAllowedError', message: '' }, true)
    ).toMatch(/blocked/i)
    expect(
      getMicrophoneCaptureFailureMessage({ name: 'NotFoundError', message: '' }, true)
    ).toMatch(/no microphone was detected/i)
    expect(
      getMicrophoneCaptureFailureMessage({ name: 'NotReadableError', message: '' }, true)
    ).toMatch(/unavailable or in use/i)
    expect(
      getMicrophoneCaptureFailureMessage({ name: 'SomethingElse', message: '' }, true)
    ).toMatch(/could not start the microphone/i)
  })
})
