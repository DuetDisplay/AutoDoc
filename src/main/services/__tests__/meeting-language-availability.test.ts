import { describe, expect, it, vi } from 'vitest'
import { meetingLanguageAvailability } from '../../../shared/meeting-language'
import { macUsesSmallNotesModel } from '../mac-processing-profile'

vi.mock('../autodoc-log', () => ({ logAutodocEvent: vi.fn() }))

import { logAutodocEvent } from '../autodoc-log'
import {
  currentMeetingLanguageAvailability,
  recordingMeetingLanguage
} from '../meeting-language-availability'

const lowSpecWindowsProfile = {
  id: 'win-low-spec' as const,
  hardware: { logicalProcessors: 4, totalMemoryGiB: 8, freeMemoryGiB: 2 }
}

const gpuWindowsProfile = {
  id: 'win-gpu' as const,
  hardware: { logicalProcessors: 16, totalMemoryGiB: 32, freeMemoryGiB: 16 }
}

const gpuEightGigWindowsProfile = {
  id: 'win-gpu' as const,
  hardware: { logicalProcessors: 16, totalMemoryGiB: 8.5, freeMemoryGiB: 3 }
}

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

  it('records in English when a Windows engine lock makes the saved language unavailable', () => {
    expect(
      recordingMeetingLanguage('es', {
        ...meetingLanguageAvailability(true),
        languageStates: {
          es: {
            availability: 'locked',
            reason: 'Spanish needs a supported graphics card on this PC.',
            firstUseDownloadBytes: 0
          }
        }
      })
    ).toBe('en')
  })
})

describe('currentMeetingLanguageAvailability', () => {
  it('keeps the Mac small-model rule on darwin', () => {
    expect(
      currentMeetingLanguageAvailability({
        platform: 'darwin',
        windowsProfile: lowSpecWindowsProfile
      })
    ).toEqual(meetingLanguageAvailability(macUsesSmallNotesModel()))
  })

  it('restricts Windows when notesModelForWindowsProfile is llama3.2:3b', () => {
    expect(
      currentMeetingLanguageAvailability({
        platform: 'win32',
        windowsProfile: lowSpecWindowsProfile
      })
    ).toEqual(meetingLanguageAvailability(true))
    expect(
      currentMeetingLanguageAvailability({
        platform: 'win32',
        windowsProfile: gpuEightGigWindowsProfile
      })
    ).toEqual(meetingLanguageAvailability(true))
  })

  it('does not restrict a Windows GPU machine on the larger notes model', () => {
    expect(
      currentMeetingLanguageAvailability({
        platform: 'win32',
        windowsProfile: gpuWindowsProfile
      })
    ).toEqual(meetingLanguageAvailability(false))
  })

  it('falls back to English when the Windows small-model list excludes the saved language', () => {
    expect(
      recordingMeetingLanguage(
        'ja',
        currentMeetingLanguageAvailability({
          platform: 'win32',
          windowsProfile: lowSpecWindowsProfile
        })
      )
    ).toBe('en')
    expect(
      recordingMeetingLanguage(
        'de',
        currentMeetingLanguageAvailability({
          platform: 'win32',
          windowsProfile: lowSpecWindowsProfile
        })
      )
    ).toBe('de')
  })
})
