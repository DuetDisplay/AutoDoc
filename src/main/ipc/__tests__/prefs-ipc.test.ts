import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}))

vi.mock('electron-store', () => {
  return {
    default: vi.fn().mockImplementation(() => {
      const data: Record<string, unknown> = {}
      return {
        get: vi.fn((_key: string, defaultValue?: unknown) => {
          return _key in data ? data[_key] : defaultValue
        }),
        set: vi.fn((_key: string, value: unknown) => {
          data[_key] = value
        }),
      }
    }),
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
})
