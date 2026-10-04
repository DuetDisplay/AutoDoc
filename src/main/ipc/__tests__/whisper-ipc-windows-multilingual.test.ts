import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn() }
}))

const getWindowsMeetingLanguageAvailability = vi.fn()
const ensureWindowsMultilingualEngineReady = vi.fn()

vi.mock('../../services/windows-multilingual-readiness', () => ({
  getWindowsMeetingLanguageAvailability: (...args: unknown[]) =>
    getWindowsMeetingLanguageAvailability(...args),
  ensureWindowsMultilingualEngineReady: (...args: unknown[]) =>
    ensureWindowsMultilingualEngineReady(...args)
}))

vi.mock('../../services/e2e-fixtures', () => ({
  getE2EWhisperStatus: vi.fn(),
  retryE2EWhisperSetup: vi.fn()
}))

import { ipcMain } from 'electron'
import { registerWhisperIpc } from '../whisper-ipc'

function handler(channel: string) {
  const registration = vi
    .mocked(ipcMain.handle)
    .mock.calls.findLast(([registered]) => registered === channel)
  if (!registration) throw new Error(`Expected ${channel} to be registered`)
  return registration[1] as (...args: unknown[]) => unknown
}

describe('whisper Windows multilingual IPC', () => {
  beforeEach(() => {
    vi.mocked(ipcMain.handle).mockClear()
    getWindowsMeetingLanguageAvailability.mockReset()
    ensureWindowsMultilingualEngineReady.mockReset()
    registerWhisperIpc(
      { startSetup: vi.fn() } as never,
      () => ({ phase: 'ready', percent: 100 })
    )
  })

  it('registers availability and ensure handlers', () => {
    expect(handler('whisper:get-windows-meeting-language-availability')).toEqual(
      expect.any(Function)
    )
    expect(handler('whisper:ensure-windows-multilingual-engine')).toEqual(expect.any(Function))
  })

  it('returns Windows availability on win32', async () => {
    if (process.platform !== 'win32') return
    getWindowsMeetingLanguageAvailability.mockResolvedValue({
      availability: 'slower',
      reason: null,
      engineId: 'whisper-turbo-cpu',
      firstUseDownloadBytes: 0
    })

    await expect(handler('whisper:get-windows-meeting-language-availability')({}, 'es')).resolves.toEqual(
      {
        availability: 'slower',
        reason: null,
        engineId: 'whisper-turbo-cpu',
        firstUseDownloadBytes: 0
      }
    )
    expect(getWindowsMeetingLanguageAvailability).toHaveBeenCalledWith('es')
  })

  it('returns a trimmed ready result on win32', async () => {
    if (process.platform !== 'win32') return
    ensureWindowsMultilingualEngineReady.mockResolvedValue({
      engineId: 'canary-cpu',
      availability: 'slower',
      reason: null,
      fallbackFrom: 'canary-cuda',
      fallbackReason: 'canary-cuda self-test failed',
      pythonPath: '/hidden',
      processEnv: { SECRET: '1' }
    })

    await expect(handler('whisper:ensure-windows-multilingual-engine')({}, 'de')).resolves.toEqual({
      engineId: 'canary-cpu',
      availability: 'slower',
      reason: null,
      fallbackFrom: 'canary-cuda',
      fallbackReason: 'canary-cuda self-test failed'
    })
    expect(ensureWindowsMultilingualEngineReady).toHaveBeenCalledWith('de')
  })
})
