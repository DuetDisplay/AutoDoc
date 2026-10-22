import { describe, expect, it } from 'vitest'
import { translate } from '../index'
import { dateLocaleForUiLanguage, htmlLangForUiLanguage, UI_LANGUAGE_CODES } from '../../ui-language'
import { en, type MessageKey } from '../messages/en'
import { CHROME_OVERLAY_KEYS } from '../messages/chrome-overlays'
import { UPCOMING_OVERLAY_KEYS } from '../messages/upcoming-overlays'

describe('UI language', () => {
  it('sets HTML lang tags that CSS :lang rules can match', () => {
    expect(htmlLangForUiLanguage('en')).toBe('en')
    expect(htmlLangForUiLanguage('ko')).toBe('ko')
    expect(htmlLangForUiLanguage('zh-Hans')).toBe('zh-Hans')
    expect(dateLocaleForUiLanguage('zh-Hans')).toBe('zh-CN')
  })

  it('falls back to English when a locale is missing a key', () => {
    expect(translate('lt', 'settings.watermarkDescription')).toContain('AutoDoc')
  })

  it('interpolates parameters without concatenating fragments', () => {
    expect(translate('ko', 'settings.version', { version: '1.3.0' })).toBe('AutoDoc v1.3.0')
    expect(translate('en', 'nav.recording', { time: '1:02' })).toBe('Recording · 1:02')
  })

  it('translates every Upcoming and sidebar-chrome string in every supported UI language', () => {
    // Product names and internationally identical technical terms
    const brandKeys = new Set<MessageKey>([
      'upcoming.microsoftOutlook',
      'upcoming.googleCalendar',
      'upcoming.sync', // 'Sync' is used unchanged in many European languages
    ])
    for (const language of UI_LANGUAGE_CODES) {
      if (language === 'en') continue
      for (const key of [...UPCOMING_OVERLAY_KEYS, ...CHROME_OVERLAY_KEYS]) {
        const value = translate(language, key)
        expect(value, `${language} ${key}`).toBeTruthy()
        if (!brandKeys.has(key)) {
          expect(value, `${language} ${key}`).not.toBe(en[key])
        }
      }
    }
  })

  it('translates every MessageKey in every supported UI language', () => {
    // Keys whose translated value may legitimately equal the English value
    const brandKeys = new Set<MessageKey>([
      'machine.pc',
      'machine.mac',
      'common.pc',
      'common.mac',
      'settings.version',
      'appearance.auto',
      // Product names and internationally identical technical terms
      'upcoming.microsoftOutlook',
      'upcoming.googleCalendar',
      'upcoming.sync',        // 'Sync' unchanged in many European languages
      'recordings.audio',     // 'Audio' unchanged in many European languages
      'recordings.video',     // 'Video' unchanged in many European languages
      'settings.total',       // 'Total' is correct in es/fr/pt/ro (Latin root)
      'meeting.notes',        // 'Notes' is correct French
      'search.note',          // 'note' is correct fr/pt/ro
      'segment.discussion',   // 'Discussion' is correct French
    ])
    const allKeys = Object.keys(en) as MessageKey[]
    for (const language of UI_LANGUAGE_CODES) {
      if (language === 'en') continue
      for (const key of allKeys) {
        const value = translate(language, key)
        expect(value, `${language} ${key} is empty`).toBeTruthy()
        if (!brandKeys.has(key)) {
          expect(value, `${language} ${key} falls back to English`).not.toBe(en[key])
        }
      }
    }
  })
})
