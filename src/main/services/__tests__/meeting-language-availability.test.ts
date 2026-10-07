import { describe, expect, it, vi, beforeEach } from 'vitest'
import { meetingLanguageAvailability } from '../../../shared/meeting-language'
import { macUsesSmallNotesModel } from '../mac-processing-profile'

vi.mock('../autodoc-log', () => ({ logAutodocEvent: vi.fn() }))

const getWindowsMeetingLanguageAvailability = vi.hoisted(() => vi.fn())

vi.mock('../windows-multilingual-readiness', () => ({
  getWindowsMeetingLanguageAvailability: (...args: unknown[]) =>
    getWindowsMeetingLanguageAvailability(...args)
}))

import { logAutodocEvent } from '../autodoc-log'
import {
  bindMeetingLanguagePreferenceStore,
  currentMeetingLanguageAvailability,
  recordingMeetingLanguage,
  resolveRecordingMeetingLanguage,
  restorePreviousMeetingLanguageIfWindowsLocked,
  restorePreviousMeetingLanguageOnLock
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
    expect(recordingMeetingLanguage('en', meetingLanguageAvailability(true))).toBe('en')
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
    ).toBe('en')
  })
})

function preferenceStore(initial: 'en' | 'de' | 'es' | 'fr' = 'es') {
  let current = initial
  const previous: typeof initial | 'en' = 'en'
  return {
    getMeetingLanguage: () => current,
    restorePreviousMeetingLanguageIfCurrent(locked: unknown) {
      if (current !== locked) return current
      current = previous
      return current
    }
  }
}

describe('restorePreviousMeetingLanguageOnLock', () => {
  beforeEach(() => {
    bindMeetingLanguagePreferenceStore(null)
  })

  it('restores the previous saved language for the locked pick', () => {
    const store = preferenceStore('es')
    bindMeetingLanguagePreferenceStore(store)
    expect(restorePreviousMeetingLanguageOnLock('es')).toBe('en')
    expect(store.getMeetingLanguage()).toBe('en')
  })

  it('does not restore when a different language is saved', () => {
    const store = preferenceStore('fr')
    bindMeetingLanguagePreferenceStore(store)
    expect(restorePreviousMeetingLanguageOnLock('es')).toBeNull()
    expect(store.getMeetingLanguage()).toBe('fr')
  })
})

describe('restorePreviousMeetingLanguageIfWindowsLocked', () => {
  beforeEach(() => {
    bindMeetingLanguagePreferenceStore(null)
    getWindowsMeetingLanguageAvailability.mockReset()
  })

  it('restores when Windows routing or self-test reports locked', async () => {
    if (process.platform !== 'win32') return
    const store = preferenceStore('es')
    bindMeetingLanguagePreferenceStore(store)
    getWindowsMeetingLanguageAvailability.mockResolvedValue({
      availability: 'locked',
      reason: 'Spanish needs a supported graphics card on this PC.',
      engineId: null,
      firstUseDownloadBytes: 0,
      needsSelfTest: false
    })

    await expect(restorePreviousMeetingLanguageIfWindowsLocked('es')).resolves.toBe('en')
    expect(store.getMeetingLanguage()).toBe('en')
    expect(getWindowsMeetingLanguageAvailability).toHaveBeenCalledWith('es')
  })

  it('does not restore on a download or other non-lock setup failure', async () => {
    if (process.platform !== 'win32') return
    const store = preferenceStore('es')
    bindMeetingLanguagePreferenceStore(store)
    getWindowsMeetingLanguageAvailability.mockResolvedValue({
      availability: 'available',
      reason: null,
      engineId: 'whisper-turbo-cuda',
      firstUseDownloadBytes: 100,
      needsSelfTest: true
    })

    await expect(restorePreviousMeetingLanguageIfWindowsLocked('es')).resolves.toBeNull()
    expect(store.getMeetingLanguage()).toBe('es')
  })
})

describe('resolveRecordingMeetingLanguage', () => {
  beforeEach(() => {
    getWindowsMeetingLanguageAvailability.mockReset()
  })

  it('records in English when a Windows engine lock makes the saved language unavailable', async () => {
    if (process.platform !== 'win32') return
    getWindowsMeetingLanguageAvailability.mockResolvedValue({
      availability: 'locked',
      reason: 'Spanish needs a supported graphics card on this PC.',
      engineId: null,
      firstUseDownloadBytes: 0,
      needsSelfTest: false
    })

    await expect(
      resolveRecordingMeetingLanguage('es', meetingLanguageAvailability(false))
    ).resolves.toBe('en')
    expect(getWindowsMeetingLanguageAvailability).toHaveBeenCalledWith('es')
  })

  it('keeps an available Windows language', async () => {
    if (process.platform !== 'win32') return
    getWindowsMeetingLanguageAvailability.mockResolvedValue({
      availability: 'available',
      reason: null,
      engineId: 'canary-cpu',
      firstUseDownloadBytes: 0,
      needsSelfTest: false
    })

    await expect(
      resolveRecordingMeetingLanguage('es', meetingLanguageAvailability(false))
    ).resolves.toBe('es')
  })
})
