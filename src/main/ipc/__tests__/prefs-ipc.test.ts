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

  it('persists experimental speaker diarization', () => {
    store.setExperimentalSpeakerDiarization(true)
    expect(store.getExperimentalSpeakerDiarization()).toBe(true)
  })
})
