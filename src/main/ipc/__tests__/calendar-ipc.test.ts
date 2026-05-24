import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerCalendarIpc } from '../calendar-ipc'
import type { CalendarManager } from '../../services/calendar-manager'

const { handle, send, logAutodocFailure } = vi.hoisted(() => ({
  handle: vi.fn(),
  send: vi.fn(),
  logAutodocFailure: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle },
  BrowserWindow: {
    getAllWindows: () => [{ webContents: { send } }]
  }
}))

vi.mock('../../services/autodoc-log', () => ({
  logAutodocFailure
}))

describe('calendar IPC', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.AUTODOC_AUTH_WORKER_URL
    delete process.env.AUTODOC_OFFICIAL_BUILD
  })

  it('logs calendar connection failures with provider and build configuration', async () => {
    const manager = {
      connect: vi.fn().mockRejectedValue(new Error('Calendar OAuth is not configured')),
      fetchAllUpcomingEvents: vi.fn(),
      getAccounts: vi.fn(() => []),
      startSync: vi.fn()
    } as unknown as CalendarManager

    registerCalendarIpc(manager)

    const connectHandler = handle.mock.calls.find(
      ([channel]) => channel === 'calendar:connect'
    )?.[1] as ((_event: unknown, provider: 'google' | 'microsoft') => Promise<unknown>) | undefined

    await expect(connectHandler?.({}, 'google')).rejects.toThrow('Calendar OAuth is not configured')

    expect(logAutodocFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        area: 'calendar',
        message: 'Calendar connection failed',
        error: expect.any(Error),
        context: expect.objectContaining({
          provider: 'google',
          authWorkerConfigured: false,
          officialBuild: false
        })
      })
    )
  })

  it('treats official builds as calendar auth configured through the built-in auth worker', async () => {
    process.env.AUTODOC_OFFICIAL_BUILD = '1'
    const manager = {
      connect: vi.fn().mockRejectedValue(new Error('Provider rejected OAuth request')),
      fetchAllUpcomingEvents: vi.fn(),
      getAccounts: vi.fn(() => []),
      startSync: vi.fn()
    } as unknown as CalendarManager

    registerCalendarIpc(manager)

    const connectHandler = handle.mock.calls.find(
      ([channel]) => channel === 'calendar:connect'
    )?.[1] as ((_event: unknown, provider: 'google' | 'microsoft') => Promise<unknown>) | undefined

    await expect(connectHandler?.({}, 'microsoft')).rejects.toThrow('Provider rejected OAuth request')

    expect(logAutodocFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          provider: 'microsoft',
          authWorkerConfigured: true,
          officialBuild: true
        })
      })
    )
  })
})
