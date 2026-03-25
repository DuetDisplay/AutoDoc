interface Env {
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
}

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const SCOPES = 'https://www.googleapis.com/auth/calendar.events.readonly'
const LOCAL_REDIRECT = 'http://127.0.0.1:42813'

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/auth/google') {
      return handleAuthStart(url, env)
    }

    if (url.pathname === '/auth/callback') {
      return handleCallback(url, env)
    }

    if (url.pathname === '/auth/refresh' && request.method === 'POST') {
      return handleRefresh(request, env)
    }

    return new Response('Not found', { status: 404 })
  },
}

function handleAuthStart(url: URL, env: Env): Response {
  const state = url.searchParams.get('state') ?? ''
  const workerCallback = `${url.origin}/auth/callback`

  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: workerCallback,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state,
  })

  return Response.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`, 302)
}

async function handleCallback(url: URL, env: Env): Promise<Response> {
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state') ?? ''
  const error = url.searchParams.get('error')

  if (error) {
    const redirect = `${LOCAL_REDIRECT}?error=${encodeURIComponent(error)}&state=${encodeURIComponent(state)}`
    return Response.redirect(redirect, 302)
  }

  if (!code) {
    return new Response('Missing authorization code', { status: 400 })
  }

  const workerCallback = `${url.origin}/auth/callback`

  const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: workerCallback,
      grant_type: 'authorization_code',
    }),
  })

  const tokens = await tokenResponse.json() as Record<string, unknown>

  if (!tokenResponse.ok) {
    const redirect = `${LOCAL_REDIRECT}?error=${encodeURIComponent(JSON.stringify(tokens))}&state=${encodeURIComponent(state)}`
    return Response.redirect(redirect, 302)
  }

  const tokenData = btoa(JSON.stringify(tokens))
  const redirect = `${LOCAL_REDIRECT}?tokens=${encodeURIComponent(tokenData)}&state=${encodeURIComponent(state)}`
  return Response.redirect(redirect, 302)
}

async function handleRefresh(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as { refresh_token?: string }
  const refreshToken = body.refresh_token

  if (!refreshToken) {
    return Response.json({ error: 'Missing refresh_token' }, { status: 400 })
  }

  const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
  })

  const tokens = await tokenResponse.json() as Record<string, unknown>

  return Response.json(tokens, {
    status: tokenResponse.ok ? 200 : 400,
    headers: { 'Access-Control-Allow-Origin': '*' },
  })
}
