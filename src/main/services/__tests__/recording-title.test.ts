import { describe, it, expect } from 'vitest'
import {
  buildRecordingTitle,
  formatRecordingDateSuffix,
  buildRecordingTitleAliases
} from '../recording-title'
import { UI_LANGUAGE_CODES, dateLocaleForUiLanguage } from '../../../shared/ui-language'
import { translate } from '../../../shared/i18n'

describe('localized recording titles', () => {
  it('keeps malformed legacy timestamps from breaking the recording list', () => {
    for (const timestamp of [NaN, Infinity, Number.MAX_VALUE]) {
      expect(buildRecordingTitle(null, timestamp, 'Customer meeting', 'ja')).toBe(
        'Customer meeting'
      )
      expect(buildRecordingTitle(null, timestamp, null, 'ja')).toBe(translate('ja', 'ui.recording'))
    }
  })
  const date = new Date(2026, 9, 27, 14, 30).getTime()
  it.each(UI_LANGUAGE_CODES)('formats generated dates and unnamed titles in %s', (language) => {
    const suffix = new Intl.DateTimeFormat(dateLocaleForUiLanguage(language), {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    }).format(date)
    expect(formatRecordingDateSuffix(date, language)).toBe(suffix)
    expect(buildRecordingTitle(null, date, 'Customer meeting', language)).toBe(
      `Customer meeting — ${suffix}`
    )
    expect(buildRecordingTitle(null, date, null, language)).toBe(
      translate(language, 'recording.unnamed', { date: suffix })
    )
    expect(
      buildRecordingTitle({ customTitle: 'My own 日本語 title' } as any, date, null, language)
    ).toBe('My own 日本語 title')
  })
  it('keeps the old date wording searchable', () => {
    const createdAt = new Date(date)
    const oldSuffix = `${createdAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} at ${createdAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
    expect(
      buildRecordingTitleAliases({
        title: buildRecordingTitle(null, date, 'Customer meeting', 'ja'),
        metadata: null,
        calendarTitle: 'Customer meeting',
        startedAt: date
      })
    ).toContain(oldSuffix)
  })
})
