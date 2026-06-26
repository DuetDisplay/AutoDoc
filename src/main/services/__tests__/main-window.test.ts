import { beforeEach, describe, expect, it, vi } from 'vitest'
import { focusMainWindow, getMainWindow, registerMainWindow, resetMainWindowForTests } from '../main-window'

const mocks = vi.hoisted(() => ({
  getAllWindows: vi.fn(() => []),
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: mocks.getAllWindows,
  },
}))

interface MockWindow {
  isDestroyed: ReturnType<typeof vi.fn>
  isFocusable: ReturnType<typeof vi.fn>
  isMinimized: ReturnType<typeof vi.fn>
  restore: ReturnType<typeof vi.fn>
  show: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
}

function createWindow(options?: {
  destroyed?: boolean
  focusable?: boolean
  minimized?: boolean
}): MockWindow {
  return {
    isDestroyed: vi.fn(() => options?.destroyed ?? false),
    isFocusable: vi.fn(() => options?.focusable ?? true),
    isMinimized: vi.fn(() => options?.minimized ?? false),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    on: vi.fn(),
  }
}

describe('main-window helpers', () => {
  beforeEach(() => {
    resetMainWindowForTests()
    mocks.getAllWindows.mockReset()
    mocks.getAllWindows.mockReturnValue([])
  })

  it('prefers the registered main window over other open windows', () => {
    const notificationWindow = createWindow({ focusable: false })
    const mainWindow = createWindow()

    registerMainWindow(mainWindow as never)
    mocks.getAllWindows.mockReturnValue([notificationWindow, mainWindow] as never[])

    expect(getMainWindow()).toBe(mainWindow)
  })

  it('falls back to the first focusable window when no main window is registered', () => {
    const notificationWindow = createWindow({ focusable: false })
    const mainWindow = createWindow()

    mocks.getAllWindows.mockReturnValue([notificationWindow, mainWindow] as never[])

    expect(getMainWindow()).toBe(mainWindow)
  })

  it('restores, shows, and focuses the main window', () => {
    const mainWindow = createWindow({ minimized: true })

    registerMainWindow(mainWindow as never)

    expect(focusMainWindow()).toBe(true)
    expect(mainWindow.restore).toHaveBeenCalledTimes(1)
    expect(mainWindow.show).toHaveBeenCalledTimes(1)
    expect(mainWindow.focus).toHaveBeenCalledTimes(1)
  })

  it('returns false when only a non-focusable window exists', () => {
    const notificationWindow = createWindow({ focusable: false })

    mocks.getAllWindows.mockReturnValue([notificationWindow] as never[])

    expect(focusMainWindow()).toBe(false)
    expect(notificationWindow.show).not.toHaveBeenCalled()
    expect(notificationWindow.focus).not.toHaveBeenCalled()
  })
})
