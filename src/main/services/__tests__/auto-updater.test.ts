import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initAutoUpdater, installUpdate } from '../auto-updater'

const {
  logAutodocFailure,
  checkForUpdates,
  send,
  on,
  quitAndInstall,
  setFeedURL,
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
    setFeedURL: vi.fn(),
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
      setFeedURL: (...args: unknown[]) => setFeedURL(...args),
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
    delete process.env.AUTODOC_TEST_MODE
    delete process.env.AUTODOC_UPDATE_FEED_URL
    delete process.env.AUTODOC_UPDATE_QUIT_AND_INSTALL_ON_DOWNLOAD
  })

  it('still reports inaccessible update feeds as application failures', () => {
    initAutoUpdater()

    const errorHandler = on.mock.calls.find(([eventName]) => eventName === 'error')?.[1] as
      | ((error: Error) => void)
      | undefined

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

  it('uses a generic update feed override for smoke tests', () => {
    process.env.AUTODOC_UPDATE_FEED_URL = 'http://127.0.0.1:18765'

    initAutoUpdater()

    expect(setFeedURL).toHaveBeenCalledWith({
      provider: 'generic',
      url: 'http://127.0.0.1:18765/'
    })
  })

  it('can run the same install path as Settings after a smoke-test download', () => {
    process.env.AUTODOC_TEST_MODE = '1'
    process.env.AUTODOC_UPDATE_QUIT_AND_INSTALL_ON_DOWNLOAD = '1'
    const prepareForInstall = vi.fn()

    initAutoUpdater({ prepareForInstall })

    const downloadedHandler = on.mock.calls.find(
      ([eventName]) => eventName === 'update-downloaded'
    )?.[1] as ((info: { version: string }) => void) | undefined

    expect(downloadedHandler).toBeTypeOf('function')

    downloadedHandler?.({ version: '0.1.24' })
    vi.advanceTimersByTime(1_000)

    expect(quitAndInstall).toHaveBeenCalled()
    expect(prepareForInstall.mock.invocationCallOrder[0]).toBeLessThan(
      quitAndInstall.mock.invocationCallOrder[0]
    )
  })

  it('notifies the app shell when an update is downloaded', () => {
    const onUpdateDownloaded = vi.fn()

    initAutoUpdater({ onUpdateDownloaded })

    const downloadedHandler = on.mock.calls.find(
      ([eventName]) => eventName === 'update-downloaded'
    )?.[1] as ((info: { version: string }) => void) | undefined

    downloadedHandler?.({ version: '0.1.24' })

    expect(onUpdateDownloaded).toHaveBeenCalledWith({
      state: 'downloaded',
      version: '0.1.24'
    })
  })

  it('prepares the app to fully quit before installing an update', () => {
    const prepareForInstall = vi.fn()

    initAutoUpdater({ prepareForInstall })

    installUpdate()

    expect(quitAndInstall).toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({ state: 'installing' })
    )
    expect(prepareForInstall.mock.invocationCallOrder[0]).toBeLessThan(
      quitAndInstall.mock.invocationCallOrder[0]
    )
  })

  it('does not auto-install after download outside smoke tests', () => {
    process.env.AUTODOC_UPDATE_QUIT_AND_INSTALL_ON_DOWNLOAD = '1'

    initAutoUpdater()

    const downloadedHandler = on.mock.calls.find(
      ([eventName]) => eventName === 'update-downloaded'
    )?.[1] as ((info: { version: string }) => void) | undefined

    downloadedHandler?.({ version: '0.1.24' })
    vi.advanceTimersByTime(1_000)

    expect(quitAndInstall).not.toHaveBeenCalled()
  })
})
