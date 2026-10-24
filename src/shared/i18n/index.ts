import { DEFAULT_UI_LANGUAGE, normalizeUiLanguage, type UiLanguageCode } from '../ui-language'
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
  const locale = normalizeUiLanguage(language)
  const catalog = catalogs[locale]
  let template = catalog[key] ?? en[key]
  if (!params) return template
  if (typeof params.percent === 'number') {
    const percent = new Intl.NumberFormat(locale, {
      style: 'percent',
      maximumFractionDigits: 1
    }).format(params.percent / 100)
    template = template.replace(/\{percent\}\s*%/g, () => percent)
  }
  return template.replace(/\{(\w+)\}/g, (_, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name)
      ? typeof params[name] === 'number'
        ? new Intl.NumberFormat(locale).format(params[name] as number)
        : String(params[name])
      : `{${name}}`
  )
}

export function createTranslator(language: UiLanguageCode) {
  return (key: MessageKey, params?: Record<string, string | number>): string =>
    translate(language, key, params)
}

export function resolveUiLanguage(value: unknown): UiLanguageCode {
  return normalizeUiLanguage(value ?? DEFAULT_UI_LANGUAGE)
}

export type PluralMessage = 'meetings' | 'attendees' | 'matches' | 'acrossMeetings'

export function translatePlural(
  language: UiLanguageCode,
  message: PluralMessage,
  count: number
): string {
  const category = new Intl.PluralRules(normalizeUiLanguage(language)).select(count)
  return translate(language, `count.${message}.${category}` as MessageKey, { count })
}
