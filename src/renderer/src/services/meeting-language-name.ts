import {
  dateLocaleForUiLanguage,
  UI_LANGUAGE_NATIVE_LABELS,
  type UiLanguageCode
} from '../../../shared/ui-language'
import type { MeetingLanguageCode } from '../../../shared/meeting-language'
import { readCachedUiLanguage } from './document-language'

export function meetingLanguageName(
  code: MeetingLanguageCode,
  language: UiLanguageCode = readCachedUiLanguage()
): string {
  return (
    new Intl.DisplayNames([dateLocaleForUiLanguage(language)], { type: 'language' }).of(code) ??
    UI_LANGUAGE_NATIVE_LABELS[code]
  )
}

/**
 * The name as a standalone label (picker value or option). Many locales' Intl names start
 * lowercase, which is right mid-sentence but wrong on its own; `meetingLanguageName` stays
 * lowercase for names interpolated into translated sentences.
 */
export function meetingLanguageLabel(
  code: MeetingLanguageCode,
  language: UiLanguageCode = readCachedUiLanguage()
): string {
  const name = meetingLanguageName(code, language)
  const first = name.match(/^./u)?.[0]
  return first
    ? first.toLocaleUpperCase(dateLocaleForUiLanguage(language)) + name.slice(first.length)
    : name
}
