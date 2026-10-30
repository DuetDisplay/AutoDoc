import { translate, type MessageKey } from '../../shared/i18n'
import { DEFAULT_UI_LANGUAGE, normalizeUiLanguage, type UiLanguageCode } from '../../shared/ui-language'

let currentLanguage: UiLanguageCode = DEFAULT_UI_LANGUAGE

export function getMainUiLanguage(): UiLanguageCode {
  return currentLanguage
}

export function setMainUiLanguage(language: unknown): UiLanguageCode {
  currentLanguage = normalizeUiLanguage(language)
  return currentLanguage
}

export function tMain(key: MessageKey, params?: Record<string, string | number>): string {
  return translate(currentLanguage, key, params)
}
