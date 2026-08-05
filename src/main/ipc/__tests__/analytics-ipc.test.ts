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
