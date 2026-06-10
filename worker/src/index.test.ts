import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from './index'

const env = {
  GOOGLE_CLIENT_ID: 'google-client-id',
  GOOGLE_CLIENT_SECRET: 'google-client-secret',
  MICROSOFT_CLIENT_ID: 'microsoft-client-id',
  MICROSOFT_CLIENT_SECRET: 'microsoft-client-secret',
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://auth.example.com${path}`, init)
}

async function fetchWorker(path: string, init?: RequestInit, overrides?: Record<string, unknown>): Promise<Response> {
  return worker.fetch(request(path, init), { ...env, ...overrides })
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AutoDoc auth worker', () => {
  it('starts Google OAuth through the worker callback', async () => {
    const response = await fetchWorker('/auth/google?state=abc123')
    const location = new URL(response.headers.get('Location') ?? '')

    expect(response.status).toBe(302)
    expect(location.origin).toBe('https://accounts.google.com')
    expect(location.searchParams.get('client_id')).toBe(env.GOOGLE_CLIENT_ID)
    expect(location.searchParams.get('redirect_uri')).toBe('https://auth.example.com/auth/callback')
    expect(location.searchParams.get('state')).toBe('abc123')
  })

  it('starts Microsoft OAuth through the worker callback', async () => {
    const response = await fetchWorker('/auth/microsoft?state=state-456')
    const location = new URL(response.headers.get('Location') ?? '')

    expect(response.status).toBe(302)
    expect(location.origin).toBe('https://login.microsoftonline.com')
    expect(location.searchParams.get('client_id')).toBe(env.MICROSOFT_CLIENT_ID)
    expect(location.searchParams.get('redirect_uri')).toBe('https://auth.example.com/auth/microsoft/callback')
    expect(location.searchParams.get('state')).toBe('state-456')
  })

  it('exchanges Google callback codes and redirects tokens to localhost', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ access_token: 'access-token' })))

    const response = await fetchWorker('/auth/callback?code=code-123&state=abc')
    const location = new URL(response.headers.get('Location') ?? '')
    const tokens = JSON.parse(atob(location.searchParams.get('tokens') ?? ''))

    expect(response.status).toBe(302)
    expect(location.origin).toBe('http://127.0.0.1:42813')
    expect(location.searchParams.get('state')).toBe('abc')
    expect(tokens).toEqual({ access_token: 'access-token' })
  })

  it('rejects wrong methods before reaching upstream OAuth providers', async () => {
    const upstreamFetch = vi.fn()
    vi.stubGlobal('fetch', upstreamFetch)

    const response = await fetchWorker('/auth/refresh')

    expect(response.status).toBe(405)
    expect(response.headers.get('Allow')).toBe('POST, OPTIONS')
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it('rejects malformed JSON before reaching upstream OAuth providers', async () => {
    const upstreamFetch = vi.fn()
    vi.stubGlobal('fetch', upstreamFetch)

    const response = await fetchWorker('/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Malformed JSON body' })
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it('rejects oversized JSON bodies before parsing', async () => {
    const upstreamFetch = vi.fn()
    vi.stubGlobal('fetch', upstreamFetch)

    const response = await fetchWorker('/auth/refresh', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': '32769',
      },
      body: JSON.stringify({ refresh_token: 'token' }),
    })

    expect(response.status).toBe(413)
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it('does not use wildcard CORS on token responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ access_token: 'new-token' })))

    const response = await fetchWorker('/auth/refresh', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://getautodoc.com',
      },
      body: JSON.stringify({ refresh_token: 'refresh-token' }),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://getautodoc.com')
    expect(response.headers.get('Access-Control-Allow-Origin')).not.toBe('*')
  })

  it('rejects disallowed CORS preflights', async () => {
    const response = await fetchWorker('/auth/refresh', {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example.com' },
    })

    expect(response.status).toBe(403)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  it('rejects arbitrary Microsoft redirect URIs', async () => {
    const upstreamFetch = vi.fn()
    vi.stubGlobal('fetch', upstreamFetch)

    const response = await fetchWorker('/microsoft/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: 'code-123',
        redirect_uri: 'https://attacker.example.com/callback',
      }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Invalid redirect_uri' })
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it('allows only the local Microsoft callback redirect URI for direct exchanges', async () => {
    const upstreamFetch = vi.fn().mockResolvedValue(Response.json({ access_token: 'new-token' }))
    vi.stubGlobal('fetch', upstreamFetch)

    const response = await fetchWorker('/microsoft/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: 'code-123',
        redirect_uri: 'http://127.0.0.1:42813/callback',
      }),
    })

    expect(response.status).toBe(200)
    expect(upstreamFetch).toHaveBeenCalledOnce()
  })

  it('returns 429 when the token-exchange rate limiter blocks a request', async () => {
    const upstreamFetch = vi.fn()
    const limiter = { limit: vi.fn().mockResolvedValue({ success: false }) }
    vi.stubGlobal('fetch', upstreamFetch)

    const response = await fetchWorker('/auth/refresh', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '203.0.113.10',
      },
      body: JSON.stringify({ refresh_token: 'refresh-token' }),
    }, {
      TOKEN_EXCHANGE_RATE_LIMITER: limiter,
    })

    expect(response.status).toBe(429)
    expect(limiter.limit).toHaveBeenCalledWith({
      key: 'token-exchange:/auth/refresh:203.0.113.10',
    })
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it('does not log token values', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ access_token: 'access-token' })))

    await fetchWorker('/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: 'refresh-secret' }),
    })

    const logged = logSpy.mock.calls.map((call) => call.join(' ')).join('\n')
    expect(logged).not.toContain('refresh-secret')
    expect(logged).not.toContain('access-token')
  })
})
