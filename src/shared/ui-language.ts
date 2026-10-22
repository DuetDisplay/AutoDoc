import {
  DEFAULT_MEETING_LANGUAGE,
  MEETING_LANGUAGE_DEFINITIONS,
  isMeetingLanguageCode,
  normalizeMeetingLanguage,
  type MeetingLanguageCode
} from './meeting-language'

export type UiLanguageCode = MeetingLanguageCode

export const DEFAULT_UI_LANGUAGE = DEFAULT_MEETING_LANGUAGE
export const UI_LANGUAGE_STORAGE_KEY = 'autodoc-ui-language'
export const UI_LANGUAGE_CODES = MEETING_LANGUAGE_DEFINITIONS.map(({ code }) => code)

/** Native-script names so the picker stays recognizable in any UI language. */
export const UI_LANGUAGE_NATIVE_LABELS: Record<UiLanguageCode, string> = {
  en: 'English',
  bg: 'Български',
  hr: 'Hrvatski',
  cs: 'Čeština',
  da: 'Dansk',
  nl: 'Nederlands',
  et: 'Eesti',
  fi: 'Suomi',
  fr: 'Français',
  de: 'Deutsch',
  el: 'Ελληνικά',
  hu: 'Magyar',
  it: 'Italiano',
  lv: 'Latviešu',
  lt: 'Lietuvių',
  pl: 'Polski',
  pt: 'Português',
  ro: 'Română',
  ru: 'Русский',
  sk: 'Slovenčina',
  sl: 'Slovenščina',
  es: 'Español',
  sv: 'Svenska',
  uk: 'Українська',
  ja: '日本語',
  'zh-Hans': '简体中文',
  ko: '한국어'
}

export function isUiLanguageCode(value: unknown): value is UiLanguageCode {
  return isMeetingLanguageCode(value)
}

export function normalizeUiLanguage(value: unknown): UiLanguageCode {
  return normalizeMeetingLanguage(value)
}

export function htmlLangForUiLanguage(language: UiLanguageCode): string {
  return language === 'zh-Hans' ? 'zh-Hans' : language
}

export function dateLocaleForUiLanguage(language: UiLanguageCode): string {
  return language === 'zh-Hans' ? 'zh-CN' : language
}

export function defaultUiLanguageForLocale(locale: string): UiLanguageCode {
  const tag = locale.toLowerCase().replaceAll('_', '-')
  if (tag.startsWith('zh')) {
    return /hant|-(tw|hk|mo)(-|$)/.test(tag) ? DEFAULT_UI_LANGUAGE : 'zh-Hans'
  }
  return normalizeMeetingLanguage(tag.split('-')[0])
}
