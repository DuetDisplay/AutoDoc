import {
  DEFAULT_UI_LANGUAGE,
  htmlLangForUiLanguage,
  normalizeUiLanguage,
  UI_LANGUAGE_STORAGE_KEY,
  type UiLanguageCode
} from '../../../shared/ui-language'

export function readCachedUiLanguage(): UiLanguageCode {
  try {
    return normalizeUiLanguage(window.localStorage.getItem(UI_LANGUAGE_STORAGE_KEY))
  } catch {
    return DEFAULT_UI_LANGUAGE
  }
}

export function applyDocumentLanguage(language: UiLanguageCode): void {
  const next = normalizeUiLanguage(language)
  try {
    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, next)
  } catch {
    // Private mode or blocked storage should not prevent lang from applying.
  }
  document.documentElement.lang = htmlLangForUiLanguage(next)
}

applyDocumentLanguage(readCachedUiLanguage())
