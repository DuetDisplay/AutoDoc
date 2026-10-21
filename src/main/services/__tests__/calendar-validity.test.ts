import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CalendarManager } from '../calendar-manager'
import {
  CalendarTransientError,
  ReconnectRequiredCalendarAuthError,
  isReconnectRequiredGoogleAuthError,
  isReconnectRequiredMicrosoftAuthError
} from '../calendar-error-classification'
import { GoogleCalendarProvider } from '../calendar'
import type { CalendarProvider } from '../calendar-types'

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

type TestCalendarManagerAccess = {
  providers: Map<string, CalendarProvider>
}

const { logAutodocFailure, captureMessage, eventsList } = vi.hoisted(() => ({
  logAutodocFailure: vi.fn(),
  captureMessage: vi.fn(),
  eventsList: vi.fn()
}))

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }))

vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: class {
        credentials: Record<string, unknown> = {}
        on(): void {
          // no-op
        }
        setCredentials(creds: Record<string, unknown>): void {
          this.credentials = creds
        }
      }
    },
    calendar: () => ({ events: { list: eventsList }, calendarList: { get: vi.fn() } })
  }
}))

vi.mock('../token-store', () => ({
  saveTokensForAccount: vi.fn(),
  loadTokensForAccount: vi.fn(() => ({
    access_token: 'access',
    refresh_token: 'refresh',
    expiry_date: Date.now() + 60 * 60_000
  })),
  clearTokensForAccount: vi.fn(),
  hasTokensForAccount: vi.fn(() => true)
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
  logAutodocFailure,
  logAutodocEvent: vi.fn()
}))

vi.mock('../sentry-reporter', () => ({
  captureMessage
}))

function createProvider(overrides: Record<string, unknown> = {}) {
  return {
    providerType: 'google' as const,
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

function createDeferred<T>(): Deferred<T> {
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
    ;(manager as unknown as TestCalendarManagerAccess).providers = new Map([
      ['google', googleProvider as CalendarProvider]
    ])

    await expect(manager.fetchAllUpcomingEvents()).resolves.toEqual([])

    expect(googleProvider.fetchUpcomingEvents).toHaveBeenCalledWith('google-account-1')
    expect(logAutodocFailure).not.toHaveBeenCalled()
  })

  it('supersedes an abandoned connect attempt when a new connection starts', async () => {
    const manager = new CalendarManager()
    const firstConnectDeferred = createDeferred<Awaited<ReturnType<CalendarManager['connect']>>>()
    const secondConnectDeferred = createDeferred<Awaited<ReturnType<CalendarManager['connect']>>>()
    const cancelConnect = vi.fn(() => {
      // The provider aborts its pending OAuth wait when asked to cancel.
      firstConnectDeferred.reject(new Error('Calendar connection cancelled'))
    })
    const connect = vi
      .fn()
      .mockImplementationOnce(() => firstConnectDeferred.promise)
      .mockImplementationOnce(() => secondConnectDeferred.promise)
    const googleProvider = createProvider({ connect, cancelConnect })

    ;(manager as unknown as TestCalendarManagerAccess).providers = new Map([
      ['google', googleProvider as CalendarProvider]
    ])

    const firstConnect = manager.connect('google')
    // The abandoned first attempt is cancelled rather than rejecting the new one.
    const firstOutcome = firstConnect.then(
      () => 'resolved' as const,
      (error: unknown) => error
    )

    const secondConnect = manager.connect('google')

    const account = {
      id: 'google-account-1',
      provider: 'google' as const,
      email: '',
      connectedAt: Date.now()
    }
    secondConnectDeferred.resolve(account)

    await expect(secondConnect).resolves.toEqual(account)
    await expect(firstOutcome).resolves.toBeInstanceOf(Error)
    expect(cancelConnect).toHaveBeenCalledTimes(1)
    expect(connect).toHaveBeenCalledTimes(2)
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

function gaxiosLikeError(
  status: number,
  message: string,
  extra: Record<string, unknown> = {}
): Error {
  return Object.assign(new Error(message), { status, code: status, ...extra })
}

describe('isReconnectRequiredGoogleAuthError', () => {
  it.each([
    [
      '403 insufficient authentication scopes',
      gaxiosLikeError(403, 'Request had insufficient authentication scopes.')
    ],
    [
      '403 with insufficientPermissions reason',
      gaxiosLikeError(403, 'Forbidden', { errors: [{ reason: 'insufficientPermissions' }] })
    ],
    [
      '403 with ACCESS_TOKEN_SCOPE_INSUFFICIENT detail',
      gaxiosLikeError(403, 'Forbidden', {
        response: {
          status: 403,
          data: { error: { details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } }
        }
      })
    ],
    [
      'refresh invalid_grant',
      new Error('Google token refresh failed: 400 {"error":"invalid_grant"}')
    ]
  ])('is true for %s', (_label, error) => {
    expect(isReconnectRequiredGoogleAuthError(error)).toBe(true)
  })

  it.each([
    [
      '403 rateLimitExceeded',
      gaxiosLikeError(403, 'Rate Limit Exceeded', { errors: [{ reason: 'rateLimitExceeded' }] })
    ],
    [
      '403 userRateLimitExceeded',
      gaxiosLikeError(403, 'User Rate Limit Exceeded', {
        errors: [{ reason: 'userRateLimitExceeded' }]
      })
    ],
    [
      '403 quotaExceeded',
      gaxiosLikeError(403, 'Quota exceeded', { errors: [{ reason: 'quotaExceeded' }] })
    ],
    [
      '403 accessNotConfigured',
      gaxiosLikeError(403, 'Google Calendar API has not been used in project', {
        errors: [{ reason: 'accessNotConfigured' }]
      })
    ],
    ['404 not found', gaxiosLikeError(404, 'Not Found')],
    ['bare 401', gaxiosLikeError(401, 'Invalid Credentials')],
    [
      'insufficient scopes text without 403',
      gaxiosLikeError(400, 'insufficient authentication scopes')
    ],
    ['generic error', new Error('boom')],
    ['non-error', undefined]
  ])('is false for %s', (_label, error) => {
    expect(isReconnectRequiredGoogleAuthError(error)).toBe(false)
  })
})

describe('GoogleCalendarProvider reconnect handling', () => {
  function createManager(provider: GoogleCalendarProvider): CalendarManager {
    const manager = new CalendarManager()
    ;(manager as any).accounts = [
      {
        id: 'google-account-1',
        provider: 'google',
        email: 'user@gmail.com',
        connectedAt: Date.now()
      }
    ]
    ;(manager as unknown as TestCalendarManagerAccess).providers = new Map([
      ['google', provider as CalendarProvider]
    ])
    return manager
  }

  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.AUTODOC_AUTH_WORKER_URL
    process.env.AUTODOC_OFFICIAL_BUILD = '1'
  })

  it.each(fetchScenarios)(
    'marks the account reconnect-required after a 403 insufficient-scopes error while fetching $label',
    async ({ invoke }) => {
      eventsList.mockRejectedValue(
        gaxiosLikeError(403, 'Request had insufficient authentication scopes.')
      )
      const manager = createManager(new GoogleCalendarProvider())

      await expect(invoke(manager)).resolves.toEqual([])
      await expect(invoke(manager)).resolves.toEqual([])

      expect(eventsList).toHaveBeenCalledTimes(1)
      expect((manager as any).accounts[0]).toEqual(
        expect.objectContaining({ syncIssue: 'reconnect-required' })
      )
      expect(captureMessage).toHaveBeenCalledTimes(1)
      expect(captureMessage).toHaveBeenCalledWith(
        'Calendar account requires reconnect',
        expect.objectContaining({
          tags: expect.objectContaining({
            provider: 'google',
            calendar_sync_issue: 'reconnect-required'
          })
        })
      )
    }
  )

  it.each([
    ['rateLimitExceeded', 'Rate Limit Exceeded'],
    ['quotaExceeded', 'Quota exceeded'],
    ['accessNotConfigured', 'Google Calendar API has not been used in project 123']
  ])('does not mark the account for a 403 %s error', async (reason, message) => {
    eventsList.mockRejectedValue(gaxiosLikeError(403, message, { errors: [{ reason }] }))
    const manager = createManager(new GoogleCalendarProvider())

    await expect(manager.fetchAllUpcomingEvents()).resolves.toEqual([])
    await expect(manager.fetchAllUpcomingEvents()).resolves.toEqual([])

    expect(eventsList).toHaveBeenCalledTimes(2)
    expect((manager as any).accounts[0]).toEqual(
      expect.not.objectContaining({ syncIssue: 'reconnect-required' })
    )
    expect(captureMessage).not.toHaveBeenCalled()
  })

  describe('token refresh', () => {
    const expiredTokens = {
      access_token: 'access',
      refresh_token: 'refresh',
      expiry_date: Date.now() - 1000
    }

    async function stubExpiredProvider(): Promise<GoogleCalendarProvider> {
      const { loadTokensForAccount } = await import('../token-store')
      vi.mocked(loadTokensForAccount).mockReturnValue(expiredTokens)
      return new GoogleCalendarProvider()
    }

    it('marks the account reconnect-required when refresh fails with invalid_grant', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 400,
          text: async () =>
            '{"error":"invalid_grant","error_description":"Token has been expired or revoked."}'
        })
      )
      const manager = createManager(await stubExpiredProvider())

      await expect(manager.fetchAllUpcomingEvents()).resolves.toEqual([])

      expect(eventsList).not.toHaveBeenCalled()
      expect((manager as any).accounts[0]).toEqual(
        expect.objectContaining({ syncIssue: 'reconnect-required' })
      )
      expect(captureMessage).toHaveBeenCalledTimes(1)
    })

    it('still treats a transient refresh failure as transient and does not mark the account', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed: ENOTFOUND')))
      const provider = await stubExpiredProvider()

      await expect(provider.fetchUpcomingEvents('google-account-1')).rejects.toBeInstanceOf(
        CalendarTransientError
      )

      const manager = createManager(provider)
      await expect(manager.fetchAllUpcomingEvents()).resolves.toEqual([])
      expect((manager as any).accounts[0]).toEqual(
        expect.not.objectContaining({ syncIssue: 'reconnect-required' })
      )
      expect(captureMessage).not.toHaveBeenCalled()
    })
  })
})
