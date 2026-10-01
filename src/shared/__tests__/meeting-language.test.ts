import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MEETING_LANGUAGE,
  getMeetingAsrRoute,
  getMeetingLanguageDefinition,
  isEnglishMeetingLanguage,
  isMeetingLanguageAvailable,
  isWhisperTurboMeetingLanguage,
  MEETING_LANGUAGE_DEFINITIONS,
  meetingLanguageAvailability,
  normalizeMeetingLanguage
} from '../meeting-language'

const CANARY_CODES = [
  'bg',
  'hr',
  'cs',
  'da',
  'nl',
  'et',
  'fi',
  'fr',
  'de',
  'hu',
  'it',
  'lv',
  'lt',
  'pl',
  'pt',
  'ro',
  'sk',
  'sl',
  'sv',
  'uk'
]

describe('meeting languages', () => {
  it('exposes English, 20 Canary EU languages, and Japanese, Chinese, Korean', () => {
    expect(MEETING_LANGUAGE_DEFINITIONS.map(({ code }) => code)).toEqual([
      'en',
      ...CANARY_CODES,
      'ja',
      'zh-Hans',
      'ko'
    ])
  })

  it('routes each language to exactly one transcription family', () => {
    expect(getMeetingAsrRoute('en')).toBe('english')
    for (const code of CANARY_CODES) expect(getMeetingAsrRoute(code)).toBe('canary')
    for (const code of ['ja', 'zh-Hans', 'ko']) {
      expect(getMeetingAsrRoute(code)).toBe('whisper-turbo')
      expect(isWhisperTurboMeetingLanguage(code)).toBe(true)
    }
    expect(isWhisperTurboMeetingLanguage('de')).toBe(false)
  })

  it('pins Simplified Chinese to the Whisper zh decoder', () => {
    expect(getMeetingLanguageDefinition('zh-Hans')).toMatchObject({
      label: 'Simplified Chinese',
      decoderLanguage: 'zh'
    })
  })

  it('defaults missing and invalid values to English', () => {
    expect(DEFAULT_MEETING_LANGUAGE).toBe('en')
    expect(normalizeMeetingLanguage(undefined)).toBe('en')
    expect(normalizeMeetingLanguage('auto')).toBe('en')
    expect(normalizeMeetingLanguage(' FR ')).toBe('fr')
    expect(isEnglishMeetingLanguage(undefined)).toBe(true)
    expect(isEnglishMeetingLanguage('fr')).toBe(false)
    expect(isEnglishMeetingLanguage('ja')).toBe(false)
    expect(getMeetingAsrRoute('auto')).toBe('english')
  })

  it.each(['zh', 'zh-cn', 'ZH-CN', 'zh-hans', 'zh-Hans', 'cmn'])(
    'accepts %s as Simplified Chinese',
    (alias) => {
      expect(normalizeMeetingLanguage(alias)).toBe('zh-Hans')
    }
  )

  it.each(['zh-Hant', 'zh-tw', 'yue', 'hi', 'th', 'el', 'es', 'mt', 'ru'])(
    'does not support %s',
    (code) => {
      expect(normalizeMeetingLanguage(code)).toBe('en')
    }
  )
})

describe('meetingLanguageAvailability', () => {
  it('offers every picker language unless the machine uses the small notes model', () => {
    const full = meetingLanguageAvailability(false)
    expect(full.restricted).toBe(false)
    expect(full.availableLanguages).toHaveLength(MEETING_LANGUAGE_DEFINITIONS.length)

    const small = meetingLanguageAvailability(true)
    expect(small.restricted).toBe(true)
    expect(small.availableLanguages).toEqual(['en', 'de', 'fr', 'it', 'pt'])
    expect(isMeetingLanguageAvailable('de', small)).toBe(true)
    expect(isMeetingLanguageAvailable('ja', small)).toBe(false)
    expect(isMeetingLanguageAvailable('pl', small)).toBe(false)
    // Unknown values normalize to English, which is always available.
    expect(isMeetingLanguageAvailable('auto', small)).toBe(true)
  })

  it('only offers languages that are in the picker', () => {
    const codes = MEETING_LANGUAGE_DEFINITIONS.map((definition) => definition.code)
    for (const code of meetingLanguageAvailability(true).availableLanguages) {
      expect(codes).toContain(code)
    }
  })
})
