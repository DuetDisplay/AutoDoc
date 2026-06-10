import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GoogleCalendarProvider } from '../calendar'
import { MicrosoftCalendarProvider } from '../microsoft-calendar'

type RequestHandler = (
  req: { url?: string },
  res: {
    writeHead: (status: number, headers?: Record<string, string>) => void
    end: (body?: string) => void
  }
) => void

const { openExternal, tokenStore, httpState } = vi.hoisted(() => ({
  openExternal: vi.fn(),
  tokenStore: new Map<string, Record<string, unknown>>(),
  httpState: {
    handler: null as RequestHandler | null,
    listen: vi.fn(),
    close: vi.fn(),
    on: vi.fn()
  }
}))

vi.mock('electron', () => ({
  shell: {
    openExternal
  }
}))

vi.mock('http', () => ({
  default: {
    createServer: (handler: RequestHandler) => {
      httpState.handler = handler
      return {
        listen: httpState.listen,
        close: httpState.close,
        on: httpState.on
      }
    }
  }
}))

vi.mock('../token-store', () => ({
  saveTokensForAccount: (accountId: string, tokens: Record<string, unknown>) => {
    tokenStore.set(accountId, tokens)
  },
  loadTokensForAccount: (accountId: string) => tokenStore.get(accountId) ?? null,
  clearTokensForAccount: (accountId: string) => {
    tokenStore.delete(accountId)
  },
  hasTokensForAccount: (accountId: string) => tokenStore.has(accountId)
}))

vi.mock('../autodoc-log', () => ({
  logAutodocFailure: vi.fn()
}))

function encodeTokenData(tokens: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(tokens), 'utf8').toString('base64')
}

function requestLocalCallback(url: string): string {
  if (!httpState.handler) {
    throw new Error('OAuth callback server was not started')
  }

  let responseBody = ''
  httpState.handler(
    { url },
    {
      writeHead: vi.fn(),
      end: (body) => {
        responseBody = body ?? ''
      }
    }
  )
  return responseBody
}

async function waitForOpenExternal(): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const openedUrl = openExternal.mock.calls[0]?.[0]
    if (openedUrl) return openedUrl
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  throw new Error('Timed out waiting for OAuth browser launch')
}

describe('Calendar OAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tokenStore.clear()
    httpState.handler = null
    process.env.AUTODOC_OFFICIAL_BUILD = '1'
    delete process.env.AUTODOC_AUTH_WORKER_URL
    openExternal.mockResolvedValue(undefined)
    httpState.close.mockImplementation((callback?: () => void) => {
      callback?.()
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        if (String(url) === 'https://graph.microsoft.com/v1.0/me') {
          return {
            ok: true,
            json: async () => ({ mail: 'qa@example.com' })
          }
        }

        throw new Error(`Unexpected fetch: ${String(url)}`)
      })
    )
  })

  afterEach(() => {
    delete process.env.AUTODOC_OFFICIAL_BUILD
    delete process.env.AUTODOC_AUTH_WORKER_URL
  })

  it('starts Microsoft OAuth through the auth worker and completes from returned tokens', async () => {
    const provider = new MicrosoftCalendarProvider()

    const connectPromise = provider.connect()
    const openedUrl = await waitForOpenExternal()
    const authUrl = new URL(openedUrl)
    const state = authUrl.searchParams.get('state')

    expect(authUrl.origin).toBe('https://autodoc-auth.duetdisplay.workers.dev')
    expect(authUrl.pathname).toBe('/auth/microsoft')
    expect(state).toBeTruthy()

    expect(httpState.listen).toHaveBeenCalledWith(42813, '127.0.0.1')

    const callbackBody = requestLocalCallback(
      `/callback?tokens=${encodeURIComponent(
        encodeTokenData({
          access_token: 'microsoft-access-token',
          refresh_token: 'microsoft-refresh-token',
          expires_in: 3600
        })
      )}&state=${encodeURIComponent(state!)}`
    )
    const account = await connectPromise

    expect(callbackBody).toContain('Connected to Microsoft Outlook')
    expect(account).toEqual(
      expect.objectContaining({
        provider: 'microsoft',
        email: 'qa@example.com'
      })
    )
    expect(tokenStore.get(account.id)).toEqual(
      expect.objectContaining({
        access_token: 'microsoft-access-token',
        refresh_token: 'microsoft-refresh-token',
        expiry_date: expect.any(Number)
      })
    )
  })

  it('cancels a pending Microsoft OAuth callback listener', async () => {
    const provider = new MicrosoftCalendarProvider()

    const connectPromise = provider.connect()
    await waitForOpenExternal()

    provider.cancelConnect()

    await expect(connectPromise).rejects.toThrow('Calendar connection cancelled')
    expect(httpState.close).toHaveBeenCalled()
  })

  it('waits for the Microsoft OAuth listener to close before rejecting cancellation', async () => {
    const provider = new MicrosoftCalendarProvider()
    let closeCallback: (() => void) | undefined
    httpState.close.mockImplementation((callback?: () => void) => {
      closeCallback = callback
    })

    const connectPromise = provider.connect()
    await waitForOpenExternal()

    provider.cancelConnect()

    let settled = false
    const observedPromise = connectPromise.catch((error: Error) => {
      settled = true
      return error
    })
    await Promise.resolve()

    expect(settled).toBe(false)
    expect(closeCallback).toBeDefined()

    closeCallback?.()

    await expect(observedPromise).resolves.toEqual(
      expect.objectContaining({ message: 'Calendar connection cancelled' })
    )
  })

  it('waits for the Google OAuth listener to close before rejecting cancellation', async () => {
    const provider = new GoogleCalendarProvider()
    let closeCallback: (() => void) | undefined
    httpState.close.mockImplementation((callback?: () => void) => {
      closeCallback = callback
    })

    const connectPromise = provider.connect()
    await waitForOpenExternal()

    provider.cancelConnect()

    let settled = false
    const observedPromise = connectPromise.catch((error: Error) => {
      settled = true
      return error
    })
    await Promise.resolve()

    expect(settled).toBe(false)
    expect(closeCallback).toBeDefined()

    closeCallback?.()

    await expect(observedPromise).resolves.toEqual(
      expect.objectContaining({ message: 'Calendar connection cancelled' })
    )
  })
})
