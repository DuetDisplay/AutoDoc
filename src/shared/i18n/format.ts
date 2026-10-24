import { dateLocaleForUiLanguage, type UiLanguageCode } from '../ui-language'

export function formatUiNumber(
  language: UiLanguageCode,
  value: number,
  options?: Intl.NumberFormatOptions
): string {
  return new Intl.NumberFormat(dateLocaleForUiLanguage(language), options).format(value)
}

export function formatUiDuration(language: UiLanguageCode, seconds: number): string {
  const minutes = Math.ceil(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const format = (value: number, unit: string) =>
    new Intl.NumberFormat(dateLocaleForUiLanguage(language), {
      style: 'unit',
      unit,
      unitDisplay: 'short'
    }).format(value)
  return hours
    ? [format(hours, 'hour'), ...(minutes % 60 ? [format(minutes % 60, 'minute')] : [])].join(' ')
    : format(minutes, 'minute')
}
