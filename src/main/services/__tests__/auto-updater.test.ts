import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initAutoUpdater } from '../auto-updater'

const {
  logAutodocFailure,
  checkForUpdates,
  send,
  on,
  quitAndInstall,
  autoUpdater,
  setThrowOnConfigure
} = vi.hoisted(() => {
  let throwOnConfigure = false
  return {
    logAutodocFailure: vi.fn(),
    checkForUpdates: vi.fn(),
    send: vi.fn(),
    on: vi.fn(),
    quitAndInstall: vi.fn(),
    setThrowOnConfigure: (enabled: boolean) => {
      throwOnConfigure = enabled
    },
    autoUpdater: {
      get autoDownload() {
        return false
      },
      set autoDownload(_enabled: boolean) {
        if (throwOnConfigure) {
          throw new Error('App version is not a valid semver version: "0.1.27b"')
        }
      },
      autoInstallOnAppQuit: false,
      disableDifferentialDownload: false,
      on: (...args: unknown[]) => on(...args),
      checkForUpdates: (...args: unknown[]) => checkForUpdates(...args),
      quitAndInstall: (...args: unknown[]) => quitAndInstall(...args)
    }
  }
})

vi.mock('electron-updater', () => ({
  autoUpdater
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
    setThrowOnConfigure(false)
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

  it('keeps startup alive when updater initialization rejects the app version', () => {
    setThrowOnConfigure(true)

    expect(() => initAutoUpdater()).not.toThrow()

    expect(logAutodocFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        area: 'app',
        message: 'Auto-updater failed to initialize',
        error: expect.any(Error)
      })
    )
    expect(send).toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({
        state: 'error',
        error: expect.stringContaining('valid semver')
      })
    )
  })

  it('handles rejected update checks without unhandled rejections', async () => {
    checkForUpdates.mockRejectedValueOnce(new Error('404 Not Found'))

    initAutoUpdater()
    vi.advanceTimersByTime(5_000)
    await Promise.resolve()

    expect(logAutodocFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        area: 'app',
        message: 'Auto-updater failed to check for updates',
        error: expect.any(Error)
      })
    )
  })
})
