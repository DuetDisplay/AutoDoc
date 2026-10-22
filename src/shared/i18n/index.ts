import {
  DEFAULT_UI_LANGUAGE,
  normalizeUiLanguage,
  type UiLanguageCode
} from '../ui-language'
import { en, type MessageCatalog, type MessageKey } from './messages/en'
import { localeCatalogs } from './messages/locales'

export type { MessageCatalog, MessageKey } from './messages/en'
export { en } from './messages/en'

const catalogs: Record<UiLanguageCode, Partial<MessageCatalog>> = {
  ...localeCatalogs,
  en
}

export function translate(
  language: UiLanguageCode,
  key: MessageKey,
  params?: Record<string, string | number>
): string {
  const catalog = catalogs[normalizeUiLanguage(language)]
  const template = catalog[key] ?? en[key]
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (_, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : `{${name}}`
  )
}

export function createTranslator(language: UiLanguageCode) {
  return (key: MessageKey, params?: Record<string, string | number>): string =>
    translate(language, key, params)
}

export function resolveUiLanguage(value: unknown): UiLanguageCode {
  return normalizeUiLanguage(value ?? DEFAULT_UI_LANGUAGE)
}
