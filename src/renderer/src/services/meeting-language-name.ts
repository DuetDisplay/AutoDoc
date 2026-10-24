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
