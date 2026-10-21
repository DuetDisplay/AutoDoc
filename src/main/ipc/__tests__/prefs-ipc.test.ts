import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  app: { setLoginItemSettings: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn() }
}))

const { getWindowsMeetingLanguageAvailability } = vi.hoisted(() => ({
  getWindowsMeetingLanguageAvailability: vi.fn()
}))

vi.mock('../../services/windows-multilingual-readiness', () => ({
  getWindowsMeetingLanguageAvailability: (...args: unknown[]) =>
    getWindowsMeetingLanguageAvailability(...args)
}))

vi.mock('../../services/mac-processing-profile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/mac-processing-profile')>()
  return {
    ...actual,
    // Host arch stays x64 on Windows; the real helper would treat a stubbed
    // darwin platform as a non-Apple-Silicon Mac and lock every language but en.
    macUsesSmallNotesModel: () => false
  }
})

vi.mock('electron-store', () => {
  return {
    default: vi.fn().mockImplementation((opts?: { defaults?: Record<string, unknown> }) => {
      const data: Record<string, unknown> = { ...(opts?.defaults ?? {}) }
      return {
        get: vi.fn((key: string, defaultValue?: unknown) => {
          return key in data ? data[key] : defaultValue
        }),
        set: vi.fn((key: string, value: unknown) => {
          data[key] = value
        })
      }
    })
  }
})

import Store from 'electron-store'
import { PrefsStore } from '../../services/prefs-store'
import { meetingLanguageNeedsMemoryMessage, registerPrefsIpc } from '../prefs-ipc'
import { BrowserWindow, ipcMain } from 'electron'
import { meetingLanguageAvailability } from '../../../shared/meeting-language'
import {
  bindWindowsNotesModelSource,
  currentMeetingLanguageAvailability,
  type WindowsNotesModelProfile
} from '../../services/meeting-language-availability'

describe('PrefsStore', () => {
  let store: PrefsStore

  beforeEach(() => {
    store = new PrefsStore()
    getWindowsMeetingLanguageAvailability.mockReset()
    getWindowsMeetingLanguageAvailability.mockResolvedValue({
      availability: 'available',
      reason: null,
      engineId: null,
      firstUseDownloadBytes: 0,
      needsSelfTest: false
    })
  })

  it('shows the language announcement only for existing users and remembers dismissal', () => {
    expect(store.isMeetingLanguageAnnouncementPending()).toBe(false)
    // Simulate preferences written by a version before language onboarding existed.
    const persisted = vi.mocked(Store).mock.results.at(-1)!.value
    persisted.set('onboardingComplete', true)
    expect(store.isMeetingLanguageAnnouncementPending()).toBe(true)
    store.dismissMeetingLanguageAnnouncement()
    expect(store.isMeetingLanguageAnnouncementPending()).toBe(false)
    expect(store.getOnboardingLanguageConfirmed()).toBe(false)
  })

  it('does not announce languages after new-user onboarding or language confirmation', () => {
    store.setOnboardingComplete()
    expect(store.isMeetingLanguageAnnouncementPending()).toBe(false)
    const persisted = vi.mocked(Store).mock.results.at(-1)!.value
    persisted.set('meetingLanguageAnnouncementDismissed', false)
    store.confirmOnboardingLanguage()
    expect(store.isMeetingLanguageAnnouncementPending()).toBe(false)
  })

  it.each([true, false])(
    'gates the language announcement when restricted=%s',
    async (restricted) => {
      vi.mocked(Store).mock.results.at(-1)!.value.set('onboardingComplete', true)
      registerPrefsIpc(store, undefined, undefined, undefined, () =>
        meetingLanguageAvailability(restricted)
      )
      const registration = vi
        .mocked(ipcMain.handle)
        .mock.calls.findLast(
          ([channel]) => channel === 'prefs:get-meeting-language-announcement-pending'
        )!
      const pending = registration[1] as unknown as () => Promise<boolean>

      await expect(pending()).resolves.toBe(!restricted)
      expect(store.isMeetingLanguageAnnouncementPending()).toBe(true)
    }
  )

  it('waits for Windows hardware detection before deciding to announce languages', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    let profile: WindowsNotesModelProfile | null = null
    let finishDetection!: () => void
    const ready = new Promise<void>((resolve) => {
      finishDetection = resolve
    })
    bindWindowsNotesModelSource(
      () => profile,
      () => ready
    )
    try {
      vi.mocked(Store).mock.results.at(-1)!.value.set('onboardingComplete', true)
      const availability = vi.fn(() => currentMeetingLanguageAvailability())
      registerPrefsIpc(store, undefined, undefined, undefined, availability)
      const registration = vi
        .mocked(ipcMain.handle)
        .mock.calls.findLast(
          ([channel]) => channel === 'prefs:get-meeting-language-announcement-pending'
        )!
      const pending = (registration[1] as unknown as () => Promise<boolean>)()

      expect(availability).not.toHaveBeenCalled()
      profile = {
        id: 'win-low-spec',
        hardware: { logicalProcessors: 4, totalMemoryGiB: 8, freeMemoryGiB: 2 }
      }
      finishDetection()
      await expect(pending).resolves.toBe(false)
    } finally {
      finishDetection()
      bindWindowsNotesModelSource(() => null)
      platform.mockRestore()
    }
  })

  it('tracks language-step confirmation separately from the shared language preference', () => {
    expect(store.getOnboardingLanguageConfirmed()).toBe(false)
    store.setMeetingLanguage('fr')
    expect(store.getOnboardingLanguageConfirmed()).toBe(false)
    store.confirmOnboardingLanguage()
    expect(store.getOnboardingLanguageConfirmed()).toBe(true)
    expect(store.getMeetingLanguage()).toBe('fr')
  })

  it('returns false for onboardingComplete by default', () => {
    expect(store.isOnboardingComplete()).toBe(false)
  })

  it('sets onboardingComplete to true', () => {
    store.setOnboardingComplete()
    expect(store.isOnboardingComplete()).toBe(true)
  })

  it('defaults onboarding permission recovery flags to false', () => {
    expect(store.getOnboardingPermissionSettingsOpened('microphone')).toBe(false)
    expect(store.getOnboardingPermissionSettingsOpened('screen')).toBe(false)
  })

  it('persists onboarding permission recovery flags per panel', () => {
    store.setOnboardingPermissionSettingsOpened('microphone', true)
    store.setOnboardingPermissionSettingsOpened('screen', true)

    expect(store.getOnboardingPermissionSettingsOpened('microphone')).toBe(true)
    expect(store.getOnboardingPermissionSettingsOpened('screen')).toBe(true)
  })

  it('clears onboarding permission recovery flags when onboarding completes', () => {
    store.setOnboardingPermissionSettingsOpened('microphone', true)
    store.setOnboardingPermissionSettingsOpened('screen', true)

    store.setOnboardingComplete()

    expect(store.getOnboardingPermissionSettingsOpened('microphone')).toBe(false)
    expect(store.getOnboardingPermissionSettingsOpened('screen')).toBe(false)
  })

  it('defaults experimental speaker diarization to false', () => {
    expect(store.getExperimentalSpeakerDiarization()).toBe(false)
  })

  it('keeps experimental speaker diarization disabled', () => {
    store.setExperimentalSpeakerDiarization(true)
    expect(store.getExperimentalSpeakerDiarization()).toBe(false)
  })

  it('defaults diagnostic log upload consent to false', () => {
    expect(store.getDiagnosticLogUploadConsent()).toBe(false)
  })

  it('persists diagnostic log upload consent', () => {
    store.setDiagnosticLogUploadConsent(true)
    expect(store.getDiagnosticLogUploadConsent()).toBe(true)
  })

  it('shows the video watermark by default and persists changes', () => {
    expect(store.getVideoWatermarkVisible()).toBe(true)

    store.setVideoWatermarkVisible(false)

    expect(store.getVideoWatermarkVisible()).toBe(false)
  })

  it('defaults the meeting language to English and persists a supported selection', () => {
    expect(store.getMeetingLanguage()).toBe('en')

    store.setMeetingLanguage('fr')

    expect(store.getMeetingLanguage()).toBe('fr')
  })

  it('restores the previous saved language when a later pick is locked', () => {
    store.setMeetingLanguage('fr')
    store.setMeetingLanguage('es')
    expect(store.restorePreviousMeetingLanguageIfCurrent('es')).toBe('fr')
    expect(store.getMeetingLanguage()).toBe('fr')
    expect(store.restorePreviousMeetingLanguageIfCurrent('es')).toBe('fr')
  })

  it('restores English when the locked pick was the first saved language', () => {
    store.setMeetingLanguage('es')
    expect(store.restorePreviousMeetingLanguageIfCurrent('es')).toBe('en')
    expect(store.getMeetingLanguage()).toBe('en')
  })

  it('normalizes an invalid meeting language back to English', () => {
    store.setMeetingLanguage('auto')

    expect(store.getMeetingLanguage()).toBe('en')
  })

  it('registers meeting-language preference handlers', async () => {
    registerPrefsIpc(store)

    const handler = (channel: string) => {
      const registration = vi
        .mocked(ipcMain.handle)
        .mock.calls.findLast(([registered]) => registered === channel)
      if (!registration) throw new Error(`Expected ${channel} to be registered`)
      return registration[1] as unknown as (...args: unknown[]) => unknown
    }

    expect(handler('prefs:get-meeting-language')()).toBe('en')
    await handler('prefs:set-meeting-language')({}, 'fr')
    expect(handler('prefs:get-meeting-language')()).toBe('fr')
  })

  it('rejects meeting languages the small notes model cannot write', async () => {
    registerPrefsIpc(store, undefined, undefined, undefined, () =>
      meetingLanguageAvailability(true)
    )

    const handler = (channel: string) => {
      const registration = vi
        .mocked(ipcMain.handle)
        .mock.calls.findLast(([registered]) => registered === channel)
      if (!registration) throw new Error(`Expected ${channel} to be registered`)
      return registration[1] as unknown as (...args: unknown[]) => unknown
    }

    expect(await handler('prefs:get-meeting-language-availability')()).toMatchObject({
      restricted: true,
      availableLanguages: ['en']
    })
    await handler('prefs:set-meeting-language')({}, 'en')
    expect(store.getMeetingLanguage()).toBe('en')
    for (const language of ['de', 'ja']) {
      await expect(handler('prefs:set-meeting-language')({}, language)).rejects.toThrow(
        meetingLanguageNeedsMemoryMessage(language)
      )
    }
    expect(store.getMeetingLanguage()).toBe('en')
  })

  it('keeps the Mac notes-model memory error byte-identical', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    registerPrefsIpc(store, undefined, undefined, undefined, () =>
      meetingLanguageAvailability(true)
    )
    const handler = (channel: string) => {
      const registration = vi
        .mocked(ipcMain.handle)
        .mock.calls.findLast(([registered]) => registered === channel)
      if (!registration) throw new Error(`Expected ${channel} to be registered`)
      return registration[1] as unknown as (...args: unknown[]) => unknown
    }

    expect(meetingLanguageNeedsMemoryMessage('ja', 'darwin')).toBe(
      'Meeting language ja needs 16 GB of memory on this Mac'
    )
    await expect(handler('prefs:set-meeting-language')({}, 'ja')).rejects.toThrow(
      'Meeting language ja needs 16 GB of memory on this Mac'
    )
    expect(getWindowsMeetingLanguageAvailability).not.toHaveBeenCalled()
    platform.mockRestore()
  })

  it('uses PC wording without a memory size for the Windows notes-model error', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    registerPrefsIpc(store, undefined, undefined, undefined, () =>
      meetingLanguageAvailability(true)
    )
    const handler = (channel: string) => {
      const registration = vi
        .mocked(ipcMain.handle)
        .mock.calls.findLast(([registered]) => registered === channel)
      if (!registration) throw new Error(`Expected ${channel} to be registered`)
      return registration[1] as unknown as (...args: unknown[]) => unknown
    }

    expect(meetingLanguageNeedsMemoryMessage('ja', 'win32')).toBe(
      'Meeting language ja needs a more powerful PC'
    )
    await expect(handler('prefs:set-meeting-language')({}, 'ja')).rejects.toThrow(
      'Meeting language ja needs a more powerful PC'
    )
    platform.mockRestore()
  })

  it('rejects a Windows engine-locked language with the plan reason verbatim', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const reason = 'Spanish needs a supported graphics card on this PC.'
    getWindowsMeetingLanguageAvailability.mockResolvedValue({
      availability: 'locked',
      reason,
      engineId: null,
      firstUseDownloadBytes: 0,
      needsSelfTest: false
    })
    registerPrefsIpc(store)
    const handler = (channel: string) => {
      const registration = vi
        .mocked(ipcMain.handle)
        .mock.calls.findLast(([registered]) => registered === channel)
      if (!registration) throw new Error(`Expected ${channel} to be registered`)
      return registration[1] as unknown as (...args: unknown[]) => unknown
    }

    await expect(handler('prefs:set-meeting-language')({}, 'es')).rejects.toThrow(reason)
    expect(store.getMeetingLanguage()).toBe('en')
    expect(getWindowsMeetingLanguageAvailability).toHaveBeenCalledWith('es')
    platform.mockRestore()
  })

  it('rejects held and unknown language codes without changing the saved language', async () => {
    registerPrefsIpc(store)
    const handler = (channel: string) => {
      const registration = vi
        .mocked(ipcMain.handle)
        .mock.calls.findLast(([registered]) => registered === channel)
      if (!registration) throw new Error(`Expected ${channel} to be registered`)
      return registration[1] as unknown as (...args: unknown[]) => unknown
    }

    await handler('prefs:set-meeting-language')({}, 'de')
    await expect(handler('prefs:set-meeting-language')({}, 'mt')).rejects.toThrow()
    await expect(handler('prefs:set-meeting-language')({}, 'xx')).rejects.toThrow()
    expect(store.getMeetingLanguage()).toBe('de')
  })

  it('keeps the newest of overlapping Windows saves', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    let releaseFirst: (() => void) | null = null
    getWindowsMeetingLanguageAvailability.mockImplementation(async (language: string) => {
      if (language === 'fr') await new Promise<void>((resolve) => (releaseFirst = resolve))
      return {
        availability: 'available',
        reason: null,
        engineId: null,
        firstUseDownloadBytes: 0,
        needsSelfTest: false
      }
    })
    registerPrefsIpc(store)
    const handler = (channel: string) => {
      const registration = vi
        .mocked(ipcMain.handle)
        .mock.calls.findLast(([registered]) => registered === channel)
      if (!registration) throw new Error(`Expected ${channel} to be registered`)
      return registration[1] as unknown as (...args: unknown[]) => unknown
    }

    const first = handler('prefs:set-meeting-language')({}, 'fr') as Promise<void>
    await vi.waitFor(() => expect(releaseFirst).not.toBeNull())
    await handler('prefs:set-meeting-language')({}, 'ja')
    releaseFirst!()
    await first
    expect(store.getMeetingLanguage()).toBe('ja')
    getWindowsMeetingLanguageAvailability.mockReset()
    platform.mockRestore()
  })

  it('does not consult Windows engine availability on Mac', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    getWindowsMeetingLanguageAvailability.mockResolvedValue({
      availability: 'locked',
      reason: 'Spanish needs a supported graphics card on this PC.',
      engineId: null,
      firstUseDownloadBytes: 0,
      needsSelfTest: false
    })
    registerPrefsIpc(store, undefined, undefined, undefined, () =>
      meetingLanguageAvailability(false)
    )
    const handler = (channel: string) => {
      const registration = vi
        .mocked(ipcMain.handle)
        .mock.calls.findLast(([registered]) => registered === channel)
      if (!registration) throw new Error(`Expected ${channel} to be registered`)
      return registration[1] as unknown as (...args: unknown[]) => unknown
    }

    await handler('prefs:set-meeting-language')({}, 'es')
    expect(store.getMeetingLanguage()).toBe('es')
    expect(getWindowsMeetingLanguageAvailability).not.toHaveBeenCalled()
    platform.mockRestore()
  })

  it('broadcasts video watermark preference changes to renderer windows', () => {
    vi.mocked(ipcMain.handle).mockClear()
    registerPrefsIpc(store)

    const registration = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([channel]) => channel === 'prefs:set-video-watermark-visible')
    if (!registration) {
      throw new Error('Expected the video watermark preference handler to be registered')
    }

    const send = vi.fn()
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([
      { webContents: { send } }
    ] as unknown as ReturnType<typeof BrowserWindow.getAllWindows>)
    const handler = registration[1] as unknown as (event: unknown, visible: boolean) => void

    handler({}, false)

    expect(store.getVideoWatermarkVisible()).toBe(false)
    expect(send).toHaveBeenCalledWith('prefs:video-watermark-visible-changed', false)
  })

  it('persists the low-memory Mac processing banner dismissal flag', () => {
    expect(store.getLowSpecMacProcessingBannerDismissed()).toBe(false)

    store.setLowSpecMacProcessingBannerDismissed(true)

    expect(store.getLowSpecMacProcessingBannerDismissed()).toBe(true)
  })

  it('persists the notes engine upgrade ready dismissal and clears eligibility', () => {
    store.setNotesEngineUpgradeEligible(true)
    expect(store.getNotesEngineReadyDismissed()).toBe(false)

    store.setNotesEngineReadyDismissed(true)

    expect(store.getNotesEngineReadyDismissed()).toBe(true)
    expect(store.getNotesEngineUpgradeEligible()).toBe(false)
  })
})
