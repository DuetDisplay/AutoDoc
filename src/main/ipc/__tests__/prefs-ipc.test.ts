import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  app: { setLoginItemSettings: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn() }
}))

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

import { PrefsStore } from '../../services/prefs-store'
import { registerPrefsIpc } from '../prefs-ipc'
import { BrowserWindow, ipcMain } from 'electron'

describe('PrefsStore', () => {
  let store: PrefsStore

  beforeEach(() => {
    store = new PrefsStore()
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
