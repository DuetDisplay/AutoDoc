import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const ipcHandlers = new Map<string, () => void>()
  const windows: FakeNotificationWindow[] = []

  class FakeNotificationWindow {
    private listeners = new Map<string, () => void>()
    destroyed = false
    isDestroyed = vi.fn(() => this.destroyed)
    showInactive = vi.fn()
    loadURL = vi.fn()
    close = vi.fn(() => {
      this.destroyed = true
      this.listeners.get('closed')?.()
    })
    webContents = {
      executeJavaScript: vi.fn(() => Promise.resolve())
    }

    constructor() {
      windows.push(this)
    }

    on(event: string, handler: () => void) {
      this.listeners.set(event, handler)
      return this
    }

    once(event: string, handler: () => void) {
      this.listeners.set(event, handler)
      return this
    }
  }

  return {
    FakeNotificationWindow,
    ipcHandlers,
    windows,
    ipcOnce: vi.fn((channel: string, handler: () => void) => {
      ipcHandlers.set(channel, handler)
    }),
    ipcRemoveListener: vi.fn((channel: string, handler: () => void) => {
      if (ipcHandlers.get(channel) === handler) {
        ipcHandlers.delete(channel)
      }
    })
  }
})

vi.mock('electron', () => ({
  BrowserWindow: mocks.FakeNotificationWindow,
  screen: {
    getPrimaryDisplay: () => ({
      workArea: { x: 0, y: 0, width: 1440, height: 900 }
    })
  },
  ipcMain: {
    once: mocks.ipcOnce,
    removeListener: mocks.ipcRemoveListener
  }
}))

const { shouldSuppressNotificationActivation, showNotificationWindow } =
  await import('../notification-window')

function showTestNotification(options: Partial<Parameters<typeof showNotificationWindow>[0]> = {}) {
  showNotificationWindow({
    title: 'Notes Ready',
    body: 'Notes are ready.',
    primaryActionLabel: 'Open Notes',
    onPrimaryAction: vi.fn(),
    onDismiss: vi.fn(),
    autoDismissMs: 30_000,
    ...options
  })
}

describe('notification window activation suppression', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mocks.ipcHandlers.clear()
    mocks.windows.length = 0
  })

  afterEach(() => {
    for (const window of mocks.windows) {
      if (!window.destroyed) window.close()
    }
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('does not suppress app activation merely because a notification is visible', () => {
    showTestNotification()

    expect(shouldSuppressNotificationActivation()).toBe(false)
  })

  it('briefly suppresses app activation after notification dismiss', () => {
    showTestNotification()

    mocks.ipcHandlers.get('notification:dismiss')?.()

    expect(shouldSuppressNotificationActivation()).toBe(true)

    vi.advanceTimersByTime(1_001)

    expect(shouldSuppressNotificationActivation()).toBe(false)
  })

  it('does not suppress app activation after the primary action', () => {
    showTestNotification()

    mocks.ipcHandlers.get('notification:primary-action')?.()

    expect(shouldSuppressNotificationActivation()).toBe(false)
  })
})
