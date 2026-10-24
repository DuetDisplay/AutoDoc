import { translate } from '../../../shared/i18n'
import { dateLocaleForUiLanguage, type UiLanguageCode } from '../../../shared/ui-language'
import { readCachedUiLanguage } from './document-language'

export function formatBytes(
  bytes: number | null | undefined,
  language: UiLanguageCode = readCachedUiLanguage()
): string {
  if (bytes == null) return translate(language, 'settings.loading')
  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte']
  let value = Math.max(0, bytes)
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return new Intl.NumberFormat(dateLocaleForUiLanguage(language), {
    style: 'unit',
    unit: units[index],
    unitDisplay: 'short',
    maximumFractionDigits: value >= 10 || index === 0 ? 0 : 1
  }).format(value)
}

export function formatMeetingLanguageFirstUseDownload(
  bytes: number,
  language: UiLanguageCode = readCachedUiLanguage()
): string | null {
  if (!Number.isFinite(bytes) || bytes <= 0) return null
  return translate(language, 'ui.aboutSizeDownloadOnFirstUse', {
    size: formatBytes(bytes, language)
  })
}
