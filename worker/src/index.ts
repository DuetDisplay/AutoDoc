interface Env {
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  MICROSOFT_CLIENT_ID: string
  MICROSOFT_CLIENT_SECRET: string
  ALLOWED_CORS_ORIGINS?: string
  AUTH_FLOW_RATE_LIMITER?: RateLimit
  TOKEN_EXCHANGE_RATE_LIMITER?: RateLimit
}

type Provider = 'google' | 'microsoft' | 'unknown'
type RateLimitGroup = 'auth-flow' | 'token-exchange'
type RouteConfig = {
  methods: readonly string[]
  provider: Provider
  rateLimitGroup: RateLimitGroup
}

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_SCOPES = 'https://www.googleapis.com/auth/calendar.events.readonly email'
const MICROSOFT_AUTH_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize'
const MICROSOFT_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token'
const MICROSOFT_SCOPES = 'Calendars.Read User.Read offline_access'
const LOCAL_REDIRECT = 'http://127.0.0.1:42813'
const LOCAL_MICROSOFT_CALLBACK = `${LOCAL_REDIRECT}/callback`
const MAX_STATE_LENGTH = 2048
const MAX_CODE_LENGTH = 8192
const MAX_TOKEN_LENGTH = 16_384
const MAX_JSON_BODY_BYTES = 32_768
const DEFAULT_ALLOWED_CORS_ORIGINS = [
  'http://127.0.0.1:42813',
  'http://localhost:42813',
  'https://getautodoc.com',
]

const ROUTES: Record<string, RouteConfig> = {
  '/auth/google': { methods: ['GET'], provider: 'google', rateLimitGroup: 'auth-flow' },
  '/auth/callback': { methods: ['GET'], provider: 'google', rateLimitGroup: 'auth-flow' },
  '/auth/refresh': { methods: ['POST'], provider: 'google', rateLimitGroup: 'token-exchange' },
  '/auth/microsoft': { methods: ['GET'], provider: 'microsoft', rateLimitGroup: 'auth-flow' },
  '/auth/microsoft/callback': {
    methods: ['GET'],
    provider: 'microsoft',
    rateLimitGroup: 'auth-flow',
  },
  '/microsoft/auth': {
    methods: ['POST'],
    provider: 'microsoft',
    rateLimitGroup: 'token-exchange',
  },
  '/microsoft/refresh': {
    methods: ['POST'],
    provider: 'microsoft',
    rateLimitGroup: 'token-exchange',
  },
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const startedAt = Date.now()
    const url = new URL(request.url)
    const route = ROUTES[url.pathname]
    let response: Response

    try {
      if (!route) {
        response = textResponse('Not found', 404)
      } else if (request.method === 'OPTIONS') {
        response = handleOptions(request, env, route)
      } else if (!route.methods.includes(request.method)) {
        response = methodNotAllowed(route)
      } else {
        const limited = await enforceRateLimit(request, env, url, route.rateLimitGroup)
        response = limited ?? await routeRequest(request, env, url)
      }
    } catch (error) {
      logWorkerError(error, url.pathname)
      response = jsonResponse({ error: 'Internal server error' }, 500, request, env)
    }

    logRequest(request, url, response, route?.provider ?? 'unknown', startedAt)
    return response
  },
} satisfies ExportedHandler<Env>

async function routeRequest(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === '/auth/google') {
    return handleGoogleAuthStart(url, env)
  }

  if (url.pathname === '/auth/callback') {
    return handleGoogleCallback(url, env)
  }

  if (url.pathname === '/auth/refresh') {
    return handleGoogleRefresh(request, env)
  }

  if (url.pathname === '/auth/microsoft') {
    return handleMicrosoftAuthStart(url, env)
  }

  if (url.pathname === '/auth/microsoft/callback') {
    return handleMicrosoftCallback(url, env)
  }

  if (url.pathname === '/microsoft/auth') {
    return handleMicrosoftAuth(request, env)
  }

  if (url.pathname === '/microsoft/refresh') {
    return handleMicrosoftRefresh(request, env)
  }

  return textResponse('Not found', 404)
}

function handleGoogleAuthStart(url: URL, env: Env): Response {
  const state = readState(url)
  if (state === null) {
    return textResponse('Invalid state', 400)
  }

  const workerCallback = `${url.origin}/auth/callback`
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: workerCallback,
    response_type: 'code',
    scope: GOOGLE_SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state,
  })

  return Response.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`, 302)
}

async function handleGoogleCallback(url: URL, env: Env): Promise<Response> {
  const state = readState(url)
  if (state === null) {
    return textResponse('Invalid state', 400)
  }

  const error = readBoundedParam(url, 'error', 1024)
  if (error) {
    const redirect = `${LOCAL_REDIRECT}?error=${encodeURIComponent(error)}&state=${encodeURIComponent(state)}`
    return Response.redirect(redirect, 302)
  }

  const code = readBoundedParam(url, 'code', MAX_CODE_LENGTH)
  if (!code) {
    return textResponse('Missing authorization code', 400)
  }

  const workerCallback = `${url.origin}/auth/callback`
  const tokenResponse = await exchangeGoogleCode(env, code, workerCallback)
  const tokens = await readResponseJson(tokenResponse)

  if (!tokenResponse.ok) {
    const redirect = `${LOCAL_REDIRECT}?error=${encodeURIComponent(JSON.stringify(tokens))}&state=${encodeURIComponent(state)}`
    return Response.redirect(redirect, 302)
  }

  const tokenData = btoa(JSON.stringify(tokens))
  const redirect = `${LOCAL_REDIRECT}?tokens=${encodeURIComponent(tokenData)}&state=${encodeURIComponent(state)}`
  return Response.redirect(redirect, 302)
}

async function handleGoogleRefresh(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody<{ refresh_token?: unknown }>(request, env)
  if (!body.ok) {
    return body.response
  }

  const refreshToken = readBoundedString(body.value.refresh_token, MAX_TOKEN_LENGTH)
  if (!refreshToken) {
    return jsonResponse({ error: 'Missing refresh_token' }, 400, request, env)
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

  const tokens = await readResponseJson(tokenResponse)
  return jsonResponse(tokens, tokenResponse.ok ? 200 : 400, request, env)
}

function handleMicrosoftAuthStart(url: URL, env: Env): Response {
  const state = readState(url)
  if (state === null) {
    return textResponse('Invalid state', 400)
  }

  const workerCallback = `${url.origin}/auth/microsoft/callback`
  const params = new URLSearchParams({
    client_id: env.MICROSOFT_CLIENT_ID,
    redirect_uri: workerCallback,
    response_type: 'code',
    scope: MICROSOFT_SCOPES,
    response_mode: 'query',
    prompt: 'select_account',
    state,
  })

  return Response.redirect(`${MICROSOFT_AUTH_URL}?${params.toString()}`, 302)
}

async function handleMicrosoftCallback(url: URL, env: Env): Promise<Response> {
  const state = readState(url)
  if (state === null) {
    return textResponse('Invalid state', 400)
  }

  const error = readBoundedParam(url, 'error', 1024)
  const workerCallback = `${url.origin}/auth/microsoft/callback`

  if (error) {
    const redirect = `${LOCAL_MICROSOFT_CALLBACK}?error=${encodeURIComponent(error)}&state=${encodeURIComponent(state)}`
    return Response.redirect(redirect, 302)
  }

  const code = readBoundedParam(url, 'code', MAX_CODE_LENGTH)
  if (!code) {
    return textResponse('Missing authorization code', 400)
  }

  const tokenResponse = await exchangeMicrosoftCode(env, code, workerCallback)
  const tokens = await readResponseJson(tokenResponse)

  if (!tokenResponse.ok) {
    const redirect = `${LOCAL_MICROSOFT_CALLBACK}?error=${encodeURIComponent(JSON.stringify(tokens))}&state=${encodeURIComponent(state)}`
    return Response.redirect(redirect, 302)
  }

  const tokenData = btoa(JSON.stringify(tokens))
  const redirect = `${LOCAL_MICROSOFT_CALLBACK}?tokens=${encodeURIComponent(tokenData)}&state=${encodeURIComponent(state)}`
  return Response.redirect(redirect, 302)
}

async function handleMicrosoftAuth(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody<{ code?: unknown; redirect_uri?: unknown }>(request, env)
  if (!body.ok) {
    return body.response
  }

  const code = readBoundedString(body.value.code, MAX_CODE_LENGTH)
  const redirectUri = readBoundedString(body.value.redirect_uri, 2048)
  if (!code || !redirectUri) {
    return jsonResponse({ error: 'Missing code or redirect_uri' }, 400, request, env)
  }
  if (!isAllowedLocalRedirectUri(redirectUri)) {
    return jsonResponse({ error: 'Invalid redirect_uri' }, 400, request, env)
  }

  const tokenResponse = await exchangeMicrosoftCode(env, code, redirectUri)
  const tokens = await readResponseJson(tokenResponse)
  return jsonResponse(tokens, tokenResponse.ok ? 200 : 400, request, env)
}

async function exchangeGoogleCode(
  env: Env,
  code: string,
  redirectUri: string
): Promise<Response> {
  return fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  })
}

async function exchangeMicrosoftCode(
  env: Env,
  code: string,
  redirectUri: string
): Promise<Response> {
  return fetch(MICROSOFT_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.MICROSOFT_CLIENT_ID,
      client_secret: env.MICROSOFT_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  })
}

async function handleMicrosoftRefresh(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody<{ refresh_token?: unknown }>(request, env)
  if (!body.ok) {
    return body.response
  }

  const refreshToken = readBoundedString(body.value.refresh_token, MAX_TOKEN_LENGTH)
  if (!refreshToken) {
    return jsonResponse({ error: 'Missing refresh_token' }, 400, request, env)
  }

  const tokenResponse = await fetch(MICROSOFT_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: env.MICROSOFT_CLIENT_ID,
      client_secret: env.MICROSOFT_CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
  })

  const tokens = await readResponseJson(tokenResponse)
  return jsonResponse(tokens, tokenResponse.ok ? 200 : 400, request, env)
}

async function enforceRateLimit(
  request: Request,
  env: Env,
  url: URL,
  group: RateLimitGroup
): Promise<Response | null> {
  const limiter =
    group === 'token-exchange' ? env.TOKEN_EXCHANGE_RATE_LIMITER : env.AUTH_FLOW_RATE_LIMITER
  if (!limiter) {
    return null
  }

  const actor = request.headers.get('CF-Connecting-IP') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  const { success } = await limiter.limit({ key: `${group}:${url.pathname}:${actor}` })
  if (success) {
    return null
  }

  return jsonResponse({ error: 'Rate limit exceeded' }, 429, request, env)
}

async function readJsonBody<T>(
  request: Request,
  env: Env
): Promise<{ ok: true; value: T } | { ok: false; response: Response }> {
  const contentLength = Number(request.headers.get('Content-Length') ?? '0')
  if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BODY_BYTES) {
    return { ok: false, response: jsonResponse({ error: 'Request body too large' }, 413, request, env) }
  }

  const contentType = request.headers.get('Content-Type') ?? ''
  if (!contentType.toLowerCase().includes('application/json')) {
    return { ok: false, response: jsonResponse({ error: 'Content-Type must be application/json' }, 415, request, env) }
  }

  const text = await request.text()
  if (text.length > MAX_JSON_BODY_BYTES) {
    return { ok: false, response: jsonResponse({ error: 'Request body too large' }, 413, request, env) }
  }

  try {
    return { ok: true, value: JSON.parse(text) as T }
  } catch {
    return { ok: false, response: jsonResponse({ error: 'Malformed JSON body' }, 400, request, env) }
  }
}

async function readResponseJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return await response.json() as Record<string, unknown>
  } catch {
    return { error: 'Invalid OAuth provider response' }
  }
}

function readState(url: URL): string | null {
  const state = url.searchParams.get('state') ?? ''
  return state.length <= MAX_STATE_LENGTH ? state : null
}

function readBoundedParam(url: URL, name: string, maxLength: number): string | null {
  return readBoundedString(url.searchParams.get(name), maxLength)
}

function readBoundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > maxLength) {
    return null
  }
  return trimmed
}

function isAllowedLocalRedirectUri(value: string): boolean {
  try {
    const url = new URL(value)
    const allowedHost = url.hostname === '127.0.0.1' || url.hostname === 'localhost'
    return url.protocol === 'http:' &&
      allowedHost &&
      url.port === '42813' &&
      url.pathname === '/callback'
  } catch {
    return false
  }
}

function handleOptions(request: Request, env: Env, route: RouteConfig): Response {
  const origin = request.headers.get('Origin')
  if (origin && !isAllowedCorsOrigin(origin, env)) {
    return textResponse('Forbidden', 403)
  }

  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(request, env),
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': [...route.methods, 'OPTIONS'].join(', '),
      'Access-Control-Max-Age': '86400',
    },
  })
}

function methodNotAllowed(route: RouteConfig): Response {
  return textResponse('Method not allowed', 405, {
    Allow: [...route.methods, 'OPTIONS'].join(', '),
  })
}

function jsonResponse(
  body: Record<string, unknown>,
  status: number,
  request: Request,
  env: Env
): Response {
  return Response.json(body, {
    status,
    headers: corsHeaders(request, env),
  })
}

function textResponse(body: string, status: number, headers?: HeadersInit): Response {
  return new Response(body, { status, headers })
}

function corsHeaders(request: Request, env: Env): HeadersInit {
  const origin = request.headers.get('Origin')
  if (!origin || !isAllowedCorsOrigin(origin, env)) {
    return {}
  }

  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'false',
  }
}

function isAllowedCorsOrigin(origin: string, env: Env): boolean {
  const configured = env.ALLOWED_CORS_ORIGINS?.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean) ?? []
  return [...DEFAULT_ALLOWED_CORS_ORIGINS, ...configured].includes(origin)
}

function logRequest(
  request: Request,
  url: URL,
  response: Response,
  provider: Provider,
  startedAt: number
): void {
  const cf = request.cf as { colo?: string; country?: string } | undefined
  const status = response.status
  const outcome = status === 429
    ? 'rate_limited'
    : status >= 500
      ? 'server_error'
      : status >= 400
        ? 'client_error'
        : 'ok'

  console.log(JSON.stringify({
    event: 'autodoc_auth_request',
    method: request.method,
    path: url.pathname,
    provider,
    status,
    outcome,
    duration_ms: Date.now() - startedAt,
    colo: cf?.colo,
    country: cf?.country,
  }))
}

function logWorkerError(error: unknown, path: string): void {
  const message = error instanceof Error ? error.message : String(error)
  console.error(JSON.stringify({
    event: 'autodoc_auth_error',
    path,
    message,
  }))
}
