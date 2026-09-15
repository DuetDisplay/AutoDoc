import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerCalendarIpc } from '../calendar-ipc'
import { setAutoRecord } from '../../services/auto-record-store'
import type { CalendarEvent, AutoRecordMode } from '../../../shared/types'
import type { CalendarManager } from '../../services/calendar-manager'

const { handle, send, logAutodocFailure, saved } = vi.hoisted(() => ({
  saved: new Map<string, unknown>(),
  handle: vi.fn(),
  send: vi.fn(),
  logAutodocFailure: vi.fn()
}))

vi.mock('electron-store', () => ({
  default: class {
    get(key: string, fallback: unknown) {
      return saved.get(key) ?? fallback
    }
    set(key: string, value: unknown) {
      saved.set(key, value)
    }
  }
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
    saved.clear()
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

    await expect(connectHandler?.({}, 'microsoft')).rejects.toThrow(
      'Provider rejected OAuth request'
    )

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

  it('cancels an in-progress calendar connection', () => {
    const manager = {
      cancelConnect: vi.fn()
    } as unknown as CalendarManager

    registerCalendarIpc(manager)

    const cancelHandler = handle.mock.calls.find(
      ([channel]) => channel === 'calendar:cancel-connect'
    )?.[1] as (() => void) | undefined

    cancelHandler?.()

    expect(manager.cancelConnect).toHaveBeenCalledTimes(1)
  })

  it.each(['google', 'microsoft'] as const)(
    'keeps %s sync and series edits consistent with saved preferences',
    async (provider) => {
      const events: CalendarEvent[] = [0, 1, 2, 3].map((i) => ({
        id: `${provider}_${i}`,
        externalId: String(i),
        accountId: 'account',
        provider,
        recurringEventId: i < 3 ? 'series' : null,
        title: `Meeting ${i}`,
        startTime: 1,
        endTime: 2,
        attendees: [],
        meetingUrl: null,
        autoRecord: 'off',
        syncedAt: 1
      }))
      const fetch = vi.fn().mockResolvedValue(events)
      const onUpdate = vi.fn()
      const publish = registerCalendarIpc(
        { fetchAllUpcomingEvents: fetch } as unknown as CalendarManager,
        onUpdate
      )
      const getEvents = handle.mock.calls.find(([channel]) => channel === 'calendar:get-events')![1]
      const edit = handle.mock.calls.find(([channel]) => channel === 'calendar:set-auto-record')![1]
      // A read must seed local publication too, even without an earlier sync callback.
      await getEvents()
      setAutoRecord(events[1].id, 'series', 'once')
      setAutoRecord(events[3].id, null, 'once')
      const expectModes = (modes: AutoRecordMode[]) => {
        expect(send).toHaveBeenLastCalledWith(
          'calendar:events-updated',
          events.map((event, i) => ({ ...event, autoRecord: modes[i] }))
        )
        expect(onUpdate).toHaveBeenLastCalledWith(
          events.map((event, i) => ({ ...event, autoRecord: modes[i] }))
        )
      }
      edit({}, events[0].id, 'series', 'series')
      expectModes(['series', 'once', 'series', 'once'])
      publish(events) // Raw provider defaults must never overwrite preferences.
      expectModes(['series', 'once', 'series', 'once'])
      edit({}, events[2].id, 'series', 'off')
      expectModes(['off', 'once', 'off', 'once'])
      edit({}, events[0].id, 'series', 'series')
      edit({}, events[0].id, 'series', 'once')
      expectModes(['once', 'once', 'off', 'once'])
      publish(events)
      expectModes(['once', 'once', 'off', 'once'])
      expect(fetch).toHaveBeenCalledTimes(1) // Preference edits need no provider request.
      expect(events.every((event) => event.autoRecord === 'off')).toBe(true)
    }
  )
})
