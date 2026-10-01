import { describe, expect, it, vi } from 'vitest'
import { meetingLanguageAvailability } from '../../../shared/meeting-language'

vi.mock('../autodoc-log', () => ({ logAutodocEvent: vi.fn() }))

import { logAutodocEvent } from '../autodoc-log'
import { recordingMeetingLanguage } from '../meeting-language-availability'

describe('recordingMeetingLanguage', () => {
  it('keeps an available saved language', () => {
    expect(recordingMeetingLanguage('ja', meetingLanguageAvailability(false))).toBe('ja')
    expect(recordingMeetingLanguage('de', meetingLanguageAvailability(true))).toBe('de')
    expect(logAutodocEvent).not.toHaveBeenCalled()
  })

  it('records in English when the saved language needs the larger notes model', () => {
    expect(recordingMeetingLanguage('ja', meetingLanguageAvailability(true))).toBe('en')
    expect(logAutodocEvent).toHaveBeenCalledWith(
      expect.objectContaining({ area: 'recording', context: { savedLanguage: 'ja' } })
    )
  })
})
