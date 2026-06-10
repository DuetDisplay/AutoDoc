import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CalendarManager } from '../calendar-manager'
import {
  ReconnectRequiredCalendarAuthError,
  isReconnectRequiredMicrosoftAuthError
} from '../calendar-error-classification'

const { logAutodocFailure, captureMessage } = vi.hoisted(() => ({
  logAutodocFailure: vi.fn(),
  captureMessage: vi.fn()
}))

vi.mock('electron-store', () => ({
  default: class MockStore<T> {
    get(_key: keyof T, fallback: unknown) {
      return fallback
    }

    set(): void {
      // no-op
    }
  }
}))

vi.mock('../autodoc-log', () => ({
  logAutodocFailure
}))

vi.mock('../sentry-reporter', () => ({
  captureMessage
}))

function createProvider(overrides: Record<string, unknown> = {}) {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    fetchUpcomingEvents: vi.fn().mockResolvedValue([]),
    fetchRecentEvents: vi.fn().mockResolvedValue([]),
    refreshTokens: vi.fn(),
    fetchAccountEmail: vi.fn().mockResolvedValue(''),
    ...overrides
  }
}

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

const fetchScenarios = [
  {
    label: 'upcoming events',
    invoke: (manager: CalendarManager) => manager.fetchAllUpcomingEvents()
  },
  {
    label: 'recent events',
    invoke: (manager: CalendarManager) => manager.fetchAllRecentEvents()
  }
] as const

describe('Calendar sync hardening', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('suppresses transient provider fetch failures instead of reporting them as product errors', async () => {
    const manager = new CalendarManager()
    const googleProvider = createProvider({
      fetchUpcomingEvents: vi.fn().mockRejectedValue(new Error('fetch failed: ENOTFOUND'))
    })

    ;(manager as any).accounts = [
      {
        id: 'google-account-1',
        provider: 'google',
        email: 'test@example.com',
        connectedAt: Date.now()
      }
    ]
    ;(manager as any).providers = new Map([['google', googleProvider]])

    await expect(manager.fetchAllUpcomingEvents()).resolves.toEqual([])

    expect(googleProvider.fetchUpcomingEvents).toHaveBeenCalledWith('google-account-1')
    expect(logAutodocFailure).not.toHaveBeenCalled()
  })

  it('keeps a cancelled connect attempt locked until the provider promise settles', async () => {
    const manager = new CalendarManager()
    const deferredConnect = createDeferred<Awaited<ReturnType<CalendarManager['connect']>>>()
    const cancelConnect = vi.fn()
    const googleProvider = createProvider({
      connect: vi.fn(() => deferredConnect.promise),
      cancelConnect
    })

    ;(manager as any).providers = new Map([['google', googleProvider]])

    const firstConnect = manager.connect('google')
    manager.cancelConnect()

    await expect(manager.connect('google')).rejects.toThrow(
      'Another calendar connection is already in progress'
    )

    deferredConnect.reject(new Error('Calendar connection cancelled'))

    await expect(firstConnect).rejects.toThrow('Calendar connection cancelled')
    expect(cancelConnect).toHaveBeenCalledTimes(1)
  })

  it('disables unsupported Microsoft mailboxes after the first unsupported response', async () => {
    const manager = new CalendarManager()
    const microsoftProvider = createProvider({
      fetchUpcomingEvents: vi
        .fn()
        .mockRejectedValue(
          new Error(
            'Microsoft Graph API error 403: {"error":{"code":"MailboxNotEnabledForRESTAPI"}}'
          )
        )
    })

    ;(manager as any).accounts = [
      {
        id: 'microsoft-account-1',
        provider: 'microsoft',
        email: 'user@contoso.com',
        connectedAt: Date.now()
      }
    ]
    ;(manager as any).providers = new Map([['microsoft', microsoftProvider]])

    await expect(manager.fetchAllUpcomingEvents()).resolves.toEqual([])
    await expect(manager.fetchAllUpcomingEvents()).resolves.toEqual([])

    expect(microsoftProvider.fetchUpcomingEvents).toHaveBeenCalledTimes(1)
    expect(microsoftProvider.disconnect).not.toHaveBeenCalled()
    expect((manager as any).accounts).toHaveLength(1)
    expect((manager as any).accounts[0]).toEqual(
      expect.objectContaining({
        id: 'microsoft-account-1',
        syncIssue: 'unsupported-mailbox'
      })
    )
    expect(logAutodocFailure).not.toHaveBeenCalled()
    expect(captureMessage).toHaveBeenCalledTimes(1)
    expect(captureMessage).toHaveBeenCalledWith(
      'Unsupported calendar account disabled for calendar sync',
      expect.objectContaining({
        area: 'calendar',
        level: 'info',
        tags: expect.objectContaining({
          provider: 'microsoft',
          calendar_sync_issue: 'unsupported-mailbox'
        })
      })
    )
  })

  it('does not classify invalid_client as a reconnect-required Microsoft auth failure', () => {
    expect(
      isReconnectRequiredMicrosoftAuthError(
        new Error(
          'Microsoft token refresh failed: 400 {"error":"invalid_client","error_description":"AADSTS7000215: Invalid client secret provided."}'
        )
      )
    ).toBe(false)
  })

  it.each(fetchScenarios)(
    'marks Microsoft accounts as reconnect-required after a recoverable auth failure while fetching $label',
    async ({ invoke }) => {
      const manager = new CalendarManager()
      const fetchFailure = vi
        .fn()
        .mockRejectedValue(
          new ReconnectRequiredCalendarAuthError(
            'Microsoft token refresh failed: 400 {"error":"interaction_required","error_description":"AADSTS50078: User interaction is required to renew consent."}'
          )
        )
      const microsoftProvider = createProvider({
        fetchUpcomingEvents: fetchFailure,
        fetchRecentEvents: fetchFailure
      })

      ;(manager as any).accounts = [
        {
          id: 'microsoft-account-1',
          provider: 'microsoft',
          email: 'user@contoso.com',
          connectedAt: Date.now()
        }
      ]
      ;(manager as any).providers = new Map([['microsoft', microsoftProvider]])

      await expect(invoke(manager)).resolves.toEqual([])
      await expect(invoke(manager)).resolves.toEqual([])

      expect(fetchFailure).toHaveBeenCalledTimes(1)
      expect((manager as any).accounts).toHaveLength(1)
      expect((manager as any).accounts[0]).toEqual(
        expect.objectContaining({
          id: 'microsoft-account-1',
          syncIssue: 'reconnect-required'
        })
      )
      expect(logAutodocFailure).not.toHaveBeenCalled()
      expect(captureMessage).toHaveBeenCalledTimes(1)
      expect(captureMessage).toHaveBeenCalledWith(
        'Calendar account requires reconnect',
        expect.objectContaining({
          area: 'calendar',
          level: 'info',
          tags: expect.objectContaining({
            provider: 'microsoft',
            calendar_sync_issue: 'reconnect-required'
          })
        })
      )
    }
  )

  it.each(fetchScenarios)(
    'does not mark Google accounts as reconnect-required for generic auth error strings while fetching $label',
    async ({ invoke }) => {
      const manager = new CalendarManager()
      const fetchFailure = vi
        .fn()
        .mockRejectedValue(
          new Error(
            'Google token refresh failed: 400 {"error":"invalid_grant","error_description":"Token has been expired or revoked."}'
          )
        )
      const googleProvider = createProvider({
        fetchUpcomingEvents: fetchFailure,
        fetchRecentEvents: fetchFailure
      })

      ;(manager as any).accounts = [
        {
          id: 'google-account-1',
          provider: 'google',
          email: 'user@gmail.com',
          connectedAt: Date.now()
        }
      ]
      ;(manager as any).providers = new Map([['google', googleProvider]])

      await expect(invoke(manager)).resolves.toEqual([])
      await expect(invoke(manager)).resolves.toEqual([])

      expect(fetchFailure).toHaveBeenCalledTimes(2)
      expect((manager as any).accounts).toHaveLength(1)
      expect((manager as any).accounts[0]).toEqual(
        expect.not.objectContaining({
          syncIssue: 'reconnect-required'
        })
      )
      expect(captureMessage).not.toHaveBeenCalled()
      expect(logAutodocFailure).toHaveBeenCalledTimes(2)
    }
  )
})
