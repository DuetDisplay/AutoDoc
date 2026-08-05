import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const ipcHandlers = new Map<string, () => void>()
  const windows: FakeNotificationWindow[] = []

  class FakeNotificationWindow {
    private listeners = new Map<string, () => void>()
    destroyed = false
    deferClosedEvent = false
    isDestroyed = vi.fn(() => this.destroyed)
    showInactive = vi.fn()
    loadURL = vi.fn()
    close = vi.fn(() => {
      this.destroyed = true
      if (!this.deferClosedEvent) {
        this.emitClosed()
      }
    })
    webContents = {
      executeJavaScript: vi.fn(() => Promise.resolve())
    }

    constructor() {
      windows.push(this)
    }

    on(event: string, handler: () => void): this {
      this.listeners.set(event, handler)
      return this
    }

    once(event: string, handler: () => void): this {
      this.listeners.set(event, handler)
      return this
    }

    emitClosed(): void {
      this.listeners.get('closed')?.()
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

const {
  hideNotificationWindow,
  onNotificationActivationSuppressionChange,
  resetNotificationActivationSuppressionForTests,
  shouldSuppressNotificationActivation,
  showNotificationWindow
} = await import('../notification-window')
const suppressionUnsubscribers: Array<() => void> = []

function subscribeToSuppressionChanges(listener: (isSuppressed: boolean) => void): () => void {
  const unsubscribe = onNotificationActivationSuppressionChange(listener)
  suppressionUnsubscribers.push(unsubscribe)
  return unsubscribe
}

function showTestNotification(
  options: Partial<Parameters<typeof showNotificationWindow>[0]> = {}
): void {
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
    resetNotificationActivationSuppressionForTests()
  })

  afterEach(() => {
    for (const window of mocks.windows) {
      if (!window.destroyed) window.close()
    }
    for (const unsubscribe of suppressionUnsubscribers.splice(0)) {
      unsubscribe()
    }
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('does not suppress app activation merely because a notification is visible', () => {
    showTestNotification()

    expect(shouldSuppressNotificationActivation()).toBe(false)
  })

  it('suppresses app activation before dismiss IPC for an opted-in notification', () => {
    showTestNotification({
      kind: 'meeting-detection',
      suppressAppActivationWhileVisible: true
    })

    expect(shouldSuppressNotificationActivation()).toBe(true)
  })

  it('notifies subscribers when visible suppression starts and ends', () => {
    const listener = vi.fn()
    subscribeToSuppressionChanges(listener)

    showTestNotification({
      kind: 'meeting-detection',
      suppressAppActivationWhileVisible: true
    })

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenLastCalledWith(true)

    mocks.windows[0].close()

    expect(listener).toHaveBeenCalledTimes(2)
    expect(listener).toHaveBeenLastCalledWith(false)
  })

  it('isolates subscriber failures from notification lifecycle updates', () => {
    const healthyListener = vi.fn()
    subscribeToSuppressionChanges(() => {
      throw new Error('listener failed')
    })
    subscribeToSuppressionChanges(healthyListener)

    expect(() =>
      showTestNotification({
        kind: 'meeting-detection',
        suppressAppActivationWhileVisible: true
      })
    ).not.toThrow()
    expect(healthyListener).toHaveBeenLastCalledWith(true)

    expect(() => mocks.windows[0].close()).not.toThrow()
    expect(healthyListener).toHaveBeenLastCalledWith(false)
  })

  it('stops notifying a subscriber after it unsubscribes', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeToSuppressionChanges(listener)

    unsubscribe()
    showTestNotification({
      kind: 'meeting-detection',
      suppressAppActivationWhileVisible: true
    })
    mocks.windows[0].close()

    expect(listener).not.toHaveBeenCalled()
  })

  it('notifies subscribers when visible suppression is reset', () => {
    const listener = vi.fn()
    subscribeToSuppressionChanges(listener)
    showTestNotification({
      kind: 'meeting-detection',
      suppressAppActivationWhileVisible: true
    })

    resetNotificationActivationSuppressionForTests()

    expect(listener).toHaveBeenLastCalledWith(false)
  })

  it('briefly suppresses app activation after notification dismiss', () => {
    showTestNotification()

    mocks.ipcHandlers.get('notification:dismiss')?.()

    expect(shouldSuppressNotificationActivation()).toBe(true)

    vi.advanceTimersByTime(1_001)

    expect(shouldSuppressNotificationActivation()).toBe(false)
  })

  it('clears visible suppression when the active notification closes', () => {
    showTestNotification({ suppressAppActivationWhileVisible: true })

    mocks.windows[0].close()

    expect(shouldSuppressNotificationActivation()).toBe(false)
  })

  it('does not let a replaced window clear the newer notification policy', () => {
    showTestNotification({ suppressAppActivationWhileVisible: true })
    const replacedWindow = mocks.windows[0]
    replacedWindow.deferClosedEvent = true

    showTestNotification({ suppressAppActivationWhileVisible: true })
    replacedWindow.emitClosed()

    expect(shouldSuppressNotificationActivation()).toBe(true)

    mocks.windows[1].close()
    expect(shouldSuppressNotificationActivation()).toBe(false)
  })

  it('does not emit false when a replaced window closes after its opted-in replacement', () => {
    const listener = vi.fn()
    subscribeToSuppressionChanges(listener)
    showTestNotification({
      kind: 'meeting-detection',
      suppressAppActivationWhileVisible: true
    })
    const replacedWindow = mocks.windows[0]
    replacedWindow.deferClosedEvent = true

    showTestNotification({
      kind: 'meeting-detection',
      suppressAppActivationWhileVisible: true
    })
    replacedWindow.emitClosed()

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenLastCalledWith(true)

    mocks.windows[1].close()
    expect(listener).toHaveBeenCalledTimes(2)
    expect(listener).toHaveBeenLastCalledWith(false)
  })

  it('emits false when an opted-in notification is replaced by a non-suppressing one', () => {
    const listener = vi.fn()
    subscribeToSuppressionChanges(listener)
    showTestNotification({
      kind: 'meeting-detection',
      suppressAppActivationWhileVisible: true
    })
    const replacedWindow = mocks.windows[0]
    replacedWindow.deferClosedEvent = true

    showTestNotification({ kind: 'notes-ready' })

    expect(listener).toHaveBeenCalledTimes(2)
    expect(listener).toHaveBeenNthCalledWith(1, true)
    expect(listener).toHaveBeenNthCalledWith(2, false)

    replacedWindow.emitClosed()
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('preserves trailing suppression after an opted-in notification closes', async () => {
    showTestNotification({ suppressAppActivationWhileVisible: true })

    mocks.ipcHandlers.get('notification:dismiss')?.()
    await Promise.resolve()
    await Promise.resolve()

    expect(mocks.windows[0].destroyed).toBe(true)
    expect(shouldSuppressNotificationActivation()).toBe(true)

    vi.advanceTimersByTime(1_001)
    expect(shouldSuppressNotificationActivation()).toBe(false)
  })

  it('clears visible suppression after a programmatic hide without adding a trailing delay', async () => {
    showTestNotification({
      kind: 'meeting-detection',
      suppressAppActivationWhileVisible: true
    })

    hideNotificationWindow('meeting-detection')
    await Promise.resolve()
    await Promise.resolve()

    expect(mocks.windows[0].destroyed).toBe(true)
    expect(shouldSuppressNotificationActivation()).toBe(false)
  })

  it('keeps trailing suppression after auto-dismiss closes the notification', async () => {
    showTestNotification({
      suppressAppActivationWhileVisible: true,
      autoDismissMs: 100
    })

    vi.advanceTimersByTime(100)
    await Promise.resolve()
    await Promise.resolve()

    expect(mocks.windows[0].destroyed).toBe(true)
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
