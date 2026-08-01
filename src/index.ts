import { DurableObject } from 'cloudflare:workers'

export interface Env {
  OAUTH_STATE: DurableObjectNamespace<OAuthState>
  NOTION_CLIENT_ID: string
  NOTION_CLIENT_SECRET: string
  NOTION_REDIRECT_URI: string
  ALLOWED_RETURN_URIS: string
  OAUTH_ATTEMPT_TTL_SEC: string
  LOGIN_TICKET_TTL_SEC: string
}

type Json = Record<string, unknown>

const NOTION_AUTHORIZE_URL = 'https://api.notion.com/v1/oauth/authorize'
const NOTION_TOKEN_URL = 'https://api.notion.com/v1/oauth/token'
const NOTION_VERSION = '2026-03-11'

function json(body: Json, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

function methodNotAllowed(): Response {
  return json({ error: 'method_not_allowed' }, 405)
}

function randomId(bytes = 32): string {
  const data = new Uint8Array(bytes)
  crypto.getRandomValues(data)
  return [...data].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function allowedReturnUris(env: Env): Set<string> {
  return new Set(
    env.ALLOWED_RETURN_URIS.split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  )
}

function isAllowedReturnUri(env: Env, uri: string): boolean {
  return allowedReturnUris(env).has(uri)
}

function oauthStateObject(env: Env): DurableObjectStub<OAuthState> {
  return env.OAUTH_STATE.getByName('global-oauth-state')
}

async function parseJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = await request.json()
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

async function exchangeWithNotion(env: Env, body: Record<string, unknown>): Promise<Response> {
  const basic = btoa(`${env.NOTION_CLIENT_ID}:${env.NOTION_CLIENT_SECRET}`)

  return fetch(NOTION_TOKEN_URL, {
    method: 'POST',
    headers: {
      authorization: `Basic ${basic}`,
      'content-type': 'application/json',
      'notion-version': NOTION_VERSION,
    },
    body: JSON.stringify(body),
  })
}

function normalizeTokenResponse(data: Record<string, unknown>): Json {
  const expiresInSec =
    typeof data.expires_in === 'number'
      ? data.expires_in
      : typeof data.expiresInSec === 'number'
        ? data.expiresInSec
        : null
  const issuedAt = new Date()
  const accessTokenExpiresAt =
    expiresInSec === null ? null : new Date(issuedAt.getTime() + expiresInSec * 1000).toISOString()

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    botId: data.bot_id,
    workspaceId: data.workspace_id,
    workspaceName: data.workspace_name ?? null,
    workspaceIcon: data.workspace_icon ?? null,
    owner: data.owner ?? null,
    accessTokenIssuedAt: issuedAt.toISOString(),
    accessTokenExpiresAt,
    accessTokenExpiresInSec: expiresInSec,
  }
}

async function handleRefresh(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed()

  const body = await parseJson(request)
  const refreshToken = body.refreshToken

  if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
    return json({ error: 'missing_refresh_token' }, 400)
  }

  const notionResponse = await exchangeWithNotion(env, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  })

  if (!notionResponse.ok) {
    return json(
      {
        error:
          notionResponse.status === 400 || notionResponse.status === 401
            ? 'invalid_refresh_token'
            : 'notion_refresh_failed',
      },
      notionResponse.status === 400 || notionResponse.status === 401 ? 401 : 502,
    )
  }

  const data = (await notionResponse.json()) as Record<string, unknown>
  return json(normalizeTokenResponse(data))
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/health') {
      return json({ ok: true, service: 'giraph-oauth-broker' })
    }

    if (url.pathname === '/oauth/notion/refresh') {
      return handleRefresh(request, env)
    }

    if (
      url.pathname === '/oauth/notion/start' ||
      url.pathname === '/oauth/notion/callback' ||
      url.pathname === '/oauth/notion/complete'
    ) {
      return oauthStateObject(env).fetch(request)
    }

    return json({ error: 'not_found' }, 404)
  },
}

interface OAuthAttempt {
  attemptId: string
  appReturnUri: string
  expiresAt: number
}

interface LoginTicket {
  attemptId: string
  tokenResponse: Json
  expiresAt: number
}

interface StoredRow {
  [key: string]: SqlStorageValue
  value: string
  expires_at: number
}

export class OAuthState extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)

    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS oauth_items (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        )
      `)
      this.deleteExpired()
    })
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/oauth/notion/start') {
      return this.handleStart(request)
    }

    if (url.pathname === '/oauth/notion/callback') {
      return this.handleCallback(request)
    }

    if (url.pathname === '/oauth/notion/complete') {
      return this.handleComplete(request)
    }

    return json({ error: 'not_found' }, 404)
  }

  private deleteExpired(): void {
    this.ctx.storage.sql.exec('DELETE FROM oauth_items WHERE expires_at <= ?', Date.now())
  }

  private putItem(key: string, value: unknown, expiresAt: number): void {
    this.deleteExpired()
    this.ctx.storage.sql.exec(
      `
        INSERT INTO oauth_items (key, value, expires_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          expires_at = excluded.expires_at
      `,
      key,
      JSON.stringify(value),
      expiresAt,
    )
  }

  private getItem<T>(key: string): T | null {
    this.deleteExpired()
    const row = this.ctx.storage.sql
      .exec<StoredRow>('SELECT value, expires_at FROM oauth_items WHERE key = ?', key)
      .toArray()[0]

    if (!row) return null
    if (row.expires_at <= Date.now()) {
      this.deleteItem(key)
      return null
    }
    return JSON.parse(row.value) as T
  }

  private deleteItem(key: string): void {
    this.ctx.storage.sql.exec('DELETE FROM oauth_items WHERE key = ?', key)
  }

  private async handleStart(request: Request): Promise<Response> {
    if (request.method !== 'POST') return methodNotAllowed()

    const body = await parseJson(request)
    const appReturnUri = body.appReturnUri

    if (typeof appReturnUri !== 'string' || !isAllowedReturnUri(this.env, appReturnUri)) {
      return json({ error: 'invalid_return_uri' }, 400)
    }

    const state = randomId()
    const attemptId = randomId(16)
    const ttlMs = Number(this.env.OAUTH_ATTEMPT_TTL_SEC || '600') * 1000
    const expiresAt = Date.now() + ttlMs

    const attempt: OAuthAttempt = {
      attemptId,
      appReturnUri,
      expiresAt,
    }

    this.putItem(`state:${state}`, attempt, expiresAt)

    const authorize = new URL(NOTION_AUTHORIZE_URL)
    authorize.searchParams.set('client_id', this.env.NOTION_CLIENT_ID)
    authorize.searchParams.set('redirect_uri', this.env.NOTION_REDIRECT_URI)
    authorize.searchParams.set('response_type', 'code')
    authorize.searchParams.set('owner', 'user')
    authorize.searchParams.set('state', state)

    return json({
      authorizeUrl: authorize.toString(),
      attemptId,
      expiresAt: new Date(expiresAt).toISOString(),
    })
  }

  private async handleCallback(request: Request): Promise<Response> {
    if (request.method !== 'GET') return methodNotAllowed()

    const url = new URL(request.url)
    const state = url.searchParams.get('state')
    if (!state) return this.renderFailure('Missing OAuth state.')

    const attempt = this.getItem<OAuthAttempt>(`state:${state}`)
    if (!attempt) {
      return this.renderFailure('OAuth attempt expired. Return to Giraph and try again.')
    }

    const error = url.searchParams.get('error')
    if (error) {
      this.deleteItem(`state:${state}`)
      const target = new URL(attempt.appReturnUri)
      target.searchParams.set('error', error === 'access_denied' ? 'access_denied' : 'oauth_error')
      target.searchParams.set('attempt_id', attempt.attemptId)
      return Response.redirect(target.toString(), 302)
    }

    const code = url.searchParams.get('code')
    if (!code) return this.renderFailure('Missing authorization code.')

    const notionResponse = await exchangeWithNotion(this.env, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.env.NOTION_REDIRECT_URI,
    })

    if (!notionResponse.ok) {
      return this.renderFailure('Token exchange failed. Return to Giraph and try again.')
    }

    const notionData = (await notionResponse.json()) as Record<string, unknown>
    const ticket = randomId()
    const ticketTtlMs = Number(this.env.LOGIN_TICKET_TTL_SEC || '300') * 1000
    const ticketExpiresAt = Date.now() + ticketTtlMs

    const loginTicket: LoginTicket = {
      attemptId: attempt.attemptId,
      tokenResponse: normalizeTokenResponse(notionData),
      expiresAt: ticketExpiresAt,
    }

    this.putItem(`ticket:${ticket}`, loginTicket, ticketExpiresAt)
    this.deleteItem(`state:${state}`)

    const target = new URL(attempt.appReturnUri)
    target.searchParams.set('ticket', ticket)
    target.searchParams.set('attempt_id', attempt.attemptId)
    return Response.redirect(target.toString(), 302)
  }

  private async handleComplete(request: Request): Promise<Response> {
    if (request.method !== 'POST') return methodNotAllowed()

    const body = await parseJson(request)
    const ticket = body.ticket
    const attemptId = body.attemptId

    if (typeof ticket !== 'string' || typeof attemptId !== 'string') {
      return json({ error: 'missing_ticket' }, 400)
    }

    const stored = this.getItem<LoginTicket>(`ticket:${ticket}`)
    if (!stored || stored.attemptId !== attemptId) {
      return json({ error: 'invalid_or_expired_ticket' }, 401)
    }

    this.deleteItem(`ticket:${ticket}`)
    return json(stored.tokenResponse)
  }

  private renderFailure(message: string): Response {
    const html = `<!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>Giraph connection failed</title>
        </head>
        <body style="font-family: system-ui; padding: 48px; text-align: center;">
          <h1>Connection failed</h1>
          <p>${escapeHtml(message)}</p>
          <p>You can close this tab and return to Giraph.</p>
        </body>
      </html>`

    return new Response(html, {
      status: 400,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      },
    })
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}
