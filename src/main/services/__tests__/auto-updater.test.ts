import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initAutoUpdater } from '../auto-updater'

const { logAutodocFailure, checkForUpdates, send, on, quitAndInstall } = vi.hoisted(() => ({
  logAutodocFailure: vi.fn(),
  checkForUpdates: vi.fn(),
  send: vi.fn(),
  on: vi.fn(),
  quitAndInstall: vi.fn()
}))

vi.mock('electron-updater', () => ({
  autoUpdater: {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    disableDifferentialDownload: false,
    on,
    checkForUpdates,
    quitAndInstall
  }
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ webContents: { send } }]
  },
  app: {
    getVersion: () => '0.1.19'
  }
}))

vi.mock('@electron-toolkit/utils', () => ({
  is: {
    dev: false
  }
}))

vi.mock('../autodoc-log', () => ({
  logAutodocFailure
}))

describe('Auto-updater validity characterization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  it('still reports inaccessible update feeds as application failures', () => {
    initAutoUpdater()

    const errorHandler = on.mock.calls.find(
      ([eventName]) => eventName === 'error'
    )?.[1] as ((error: Error) => void) | undefined

    expect(errorHandler).toBeTypeOf('function')

    errorHandler?.(new Error('404 Not Found'))

    expect(logAutodocFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        area: 'app',
        message: 'Auto-updater failed',
        error: expect.any(Error)
      })
    )
    expect(send).toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({
        state: 'error',
        error: expect.stringContaining('Auto-update feed is not accessible')
      })
    )
  })
})
