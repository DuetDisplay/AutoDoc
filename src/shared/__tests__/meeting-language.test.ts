import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MEETING_LANGUAGE,
  isEnglishMeetingLanguage,
  MEETING_LANGUAGE_DEFINITIONS,
  normalizeMeetingLanguage
} from '../meeting-language'

describe('meeting languages', () => {
  it('exposes exactly the 25 languages supported by Parakeet TDT 0.6B v3', () => {
    expect(MEETING_LANGUAGE_DEFINITIONS.map(({ code }) => code)).toEqual([
      'en',
      'bg',
      'hr',
      'cs',
      'da',
      'nl',
      'et',
      'fi',
      'fr',
      'de',
      'el',
      'hu',
      'it',
      'lv',
      'lt',
      'mt',
      'pl',
      'pt',
      'ro',
      'ru',
      'sk',
      'sl',
      'es',
      'sv',
      'uk'
    ])
  })

  it('defaults missing and invalid values to English', () => {
    expect(DEFAULT_MEETING_LANGUAGE).toBe('en')
    expect(normalizeMeetingLanguage(undefined)).toBe('en')
    expect(normalizeMeetingLanguage('auto')).toBe('en')
    expect(normalizeMeetingLanguage(' ES ')).toBe('es')
    expect(isEnglishMeetingLanguage(undefined)).toBe(true)
    expect(isEnglishMeetingLanguage('fr')).toBe(false)
  })
})
