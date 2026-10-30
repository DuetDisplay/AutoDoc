import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler)
    })
  }
}))

import { registerAnalyticsIpc } from '../analytics-ipc'

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`)
  return handler
}

describe('analytics IPC', () => {
  it('binds pending download claims and acknowledgement to the requesting window', () => {
    const report = { version: '1.3.2', downloadedAt: '2026-10-29T20:00:00Z' }
    const store = {
      claimPendingUpdateDownload: vi.fn(() => report),
      acknowledgePendingUpdateDownload: vi.fn(() => true),
      releasePendingUpdateDownload: vi.fn()
    }
    const sender = { id: 7, once: vi.fn(), on: vi.fn() }
    registerAnalyticsIpc(store as never)
    expect(getHandler('analytics:get-pending-update-download')({ sender })).toEqual(report)
    expect(store.claimPendingUpdateDownload).toHaveBeenCalledWith(7)
    expect(getHandler('analytics:acknowledge-update-download')({ sender }, report)).toBe(true)
    expect(store.acknowledgePendingUpdateDownload).toHaveBeenCalledWith(report, 7)
    getHandler('analytics:release-update-download')({ sender })
    expect(store.releasePendingUpdateDownload).toHaveBeenCalledWith(7)
    const destroyed = sender.once.mock.calls.find((call) => call[0] === 'destroyed')![1]
    // Electron's destroyed WebContents cannot be queried; release must use the captured ID.
    Object.defineProperty(sender, 'id', {
      get: () => {
        throw new Error('Object has been destroyed')
      }
    })
    expect(() => destroyed()).not.toThrow()
    expect(store.releasePendingUpdateDownload).toHaveBeenLastCalledWith(7)
    expect(store.releasePendingUpdateDownload).toHaveBeenCalledTimes(2)
  })
  beforeEach(() => {
    mocks.handlers.clear()
  })

  it('reads and acknowledges only the transition supplied by the main-process store', () => {
    const transition = {
      previousVersion: '1.1.0',
      currentVersion: '1.1.1'
    }
    const analyticsStateStore = {
      getState: vi.fn(),
      recordLocalSignal: vi.fn(),
      markDailyActive: vi.fn(),
      startSession: vi.fn(),
      endSession: vi.fn(),
      getConsentSnapshot: vi.fn(),
      getPendingUpgrade: vi.fn(() => transition),
      acknowledgePendingUpgrade: vi.fn(() => true)
    }

    registerAnalyticsIpc(analyticsStateStore as never)

    expect(getHandler('analytics:get-pending-upgrade')({})).toEqual(transition)
    expect(getHandler('analytics:acknowledge-upgrade')({}, transition)).toBe(true)
    expect(analyticsStateStore.acknowledgePendingUpgrade).toHaveBeenCalledWith(transition)
  })
})
