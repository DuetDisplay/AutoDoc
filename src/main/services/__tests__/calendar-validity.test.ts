import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CalendarManager } from '../calendar-manager'

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
      'Unsupported Microsoft mailbox disabled for calendar sync',
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
})
