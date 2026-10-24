import { describe, expect, it } from 'vitest'
import { translate } from '../index'
import {
  dateLocaleForUiLanguage,
  htmlLangForUiLanguage,
  UI_LANGUAGE_CODES
} from '../../ui-language'
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

  it('normalizes unsupported preferences to English', () => {
    expect(translate('unsupported' as never, 'nav.upcoming')).toBe(en['nav.upcoming'])
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
      'upcoming.sync' // 'Sync' is used unchanged in many European languages
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

  it('provides every catalog message for every supported UI language', () => {
    for (const language of UI_LANGUAGE_CODES) {
      for (const key of Object.keys(en) as MessageKey[]) {
        expect(translate(language, key).trim(), `${language} ${key}`).toBeTruthy()
      }
    }
  })
})
