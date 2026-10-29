import { afterEach, describe, expect, it } from 'vitest'
import { translate } from '../../../../shared/i18n'
import type { MeetingLanguageEngineState } from '../../../../shared/meeting-language'
import { applyDocumentLanguage } from '../document-language'
import { formatMeetingLanguageFirstUseDownload } from '../format-bytes'
import { meetingLanguageReasonText, meetingLanguageSelectableNote } from '../meeting-language-copy'

const available = (overrides: Partial<MeetingLanguageEngineState>): MeetingLanguageEngineState => ({
  availability: 'available',
  reason: null,
  firstUseDownloadBytes: 0,
  ...overrides
})

describe('meeting language copy', () => {
  afterEach(() => applyDocumentLanguage('en'))

  it('shows the localized Mac setup reason with the first-use size', () => {
    const size = formatMeetingLanguageFirstUseDownload(1_610_612_736)
    expect(
      meetingLanguageSelectableNote(
        available({
          reason: 'Failed to download speech model: 503',
          reasonCode: 'setup-download-failed',
          firstUseDownloadBytes: 1_610_612_736
        })
      )
    ).toBe(`The speech model download didn't finish. Try again. · ${size}`)
  })

  it('reuses the existing disk-space text for a full disk', () => {
    expect(
      meetingLanguageSelectableNote(available({ reason: 'ENOSPC', reasonCode: 'setup-disk-full' }))
    ).toBe(translate('en', 'ui.notEnoughDiskSpaceFreeUpSpaceAndTryAgain'))
  })

  it('uses the generic localized setup message for an unknown Mac error', () => {
    applyDocumentLanguage('de')
    const note = meetingLanguageSelectableNote(available({ reason: 'weird English error' }))
    expect(note).toBe(translate('de', 'picker.reasonSetupFailed'))
    expect(note).not.toMatch(/weird English error/)
  })

  it('shows no note for an available language without a reason', () => {
    expect(meetingLanguageSelectableNote(available({}))).toBeNull()
  })

  it('inserts the language name into the graphics card reason', () => {
    expect(meetingLanguageReasonText('needs-supported-graphics-card', 'Spanish', 'en')).toBe(
      'Spanish needs a supported graphics card on this PC.'
    )
    expect(meetingLanguageReasonText(null, 'Spanish', 'en')).toBeNull()
  })
})
