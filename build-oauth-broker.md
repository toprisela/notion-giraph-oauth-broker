# Build Guide: Giraph Notion OAuth Broker

## Goal

Build the smallest practical OAuth broker for Giraph using:

- Cloudflare Workers;
- one Cloudflare Durable Object for short-lived OAuth attempts and login tickets;
- `auth.connectyourcharger.com` as the initial production hostname;
- Notion OAuth client ID/secret stored as Cloudflare secrets.

This broker is not a full Giraph backend. It only handles:

1. Notion OAuth start;
2. Notion OAuth callback/code exchange;
3. short-lived ticket redemption by the app;
4. Notion refresh-token exchange;
5. optional future token revocation.

The Giraph desktop/iPad apps should still call the Notion API directly with the
current access token and should still store their own local cache.

## Why Cloudflare Workers + Durable Objects

Use Cloudflare Workers because it is the simplest low-cost deployment model:

- no server/VPS to maintain;
- free tier is large enough for early Giraph usage;
- request metrics are visible in the Cloudflare dashboard;
- paid upgrade does not require code changes;
- budget alerts can warn about usage-based spend.

Use a Durable Object instead of Workers KV for OAuth attempts/tickets because the
app will redeem a ticket immediately after the broker creates it. Durable
Objects provide strongly consistent state for that short handoff. Workers KV is
excellent for many use cases, but its eventual consistency model is a bad fit
for "write ticket, immediately read ticket."

Relevant Cloudflare docs:

- Workers pricing: `https://developers.cloudflare.com/workers/platform/pricing/`
- Durable Objects pricing: `https://developers.cloudflare.com/durable-objects/platform/pricing/`
- Durable Objects overview: `https://developers.cloudflare.com/durable-objects/`
- Worker custom domains: `https://developers.cloudflare.com/workers/configuration/routing/custom-domains/`
- Worker metrics: `https://developers.cloudflare.com/workers/observability/metrics-and-analytics/`
- Worker secrets: `https://developers.cloudflare.com/workers/configuration/secrets/`
- Budget alerts: `https://developers.cloudflare.com/billing/manage/budget-alerts/`

Relevant Notion docs:

- Authorization guide: `https://developers.notion.com/guides/get-started/authorization`
- Create token: `https://developers.notion.com/reference/create-a-token`
- Refresh token: `https://developers.notion.com/reference/refresh-a-token`

## Expected Cost Shape

Cloudflare Workers Free currently gives enough capacity for an OAuth broker
prototype/launch.

Approximate broker request count:

- login start: 1 request;
- Notion callback to broker: 1 request;
- app ticket redemption: 1 request;
- refresh: 1 request each time a token must be refreshed.

Example capacity on a 100,000 requests/day free Worker limit:

| Average broker requests per active user per day | Approximate active users/day |
| ----------------------------------------------- | ---------------------------: |
| 1                                               |                      100,000 |
| 3                                               |                       33,000 |
| 8                                               |                       12,500 |
| 24                                              |                        4,100 |

Real Giraph usage should be closer to the low/middle rows because cached graph
browsing does not call the broker.

Start on Cloudflare Free. Move to Workers Paid only when:

- request volume approaches the free daily limit;
- Durable Object limits become a real launch concern;
- you want production support/paid-plan behavior;
- budget alerts and billing controls are configured.

## Architecture

```text
Giraph Electron app
  POST /oauth/notion/start
    ↓
Cloudflare Worker + Durable Object
  creates state and Notion authorize URL
    ↓
Giraph opens Notion OAuth in browser
    ↓
Notion redirects to:
  https://auth.connectyourcharger.com/oauth/notion/callback?code=...&state=...
    ↓
Broker exchanges code with Notion using client secret
    ↓
Broker stores token response under short-lived opaque ticket
    ↓
Broker redirects browser back to:
  http://localhost:41987/callback?ticket=...&attempt_id=...
    ↓
Giraph app redeems ticket:
  POST /oauth/notion/complete
    ↓
Broker returns tokens over HTTPS JSON
    ↓
Giraph stores tokens locally and calls Notion directly for sync
```

Refresh:

```text
Giraph app
  POST /oauth/notion/refresh with refresh_token
    ↓
Broker calls Notion token endpoint with client secret
    ↓
Broker returns new access_token + new refresh_token
    ↓
Giraph atomically replaces both local tokens
```

## Public Endpoints

Initial production base URL:

```text
https://auth.connectyourcharger.com
```

Endpoints:

```text
GET  /health
POST /oauth/notion/start
GET  /oauth/notion/callback
POST /oauth/notion/complete
POST /oauth/notion/refresh
POST /oauth/notion/revoke    optional later
```

## Security Rules

- Never put Notion access tokens or refresh tokens in browser redirect URLs.
- Browser redirects may contain only:
  - opaque `ticket`;
  - opaque `attempt_id`;
  - safe error codes.
- The broker must allow only exact app return URIs.
- For the first Electron release, allow only:

  ```text
  http://localhost:41987/callback
  ```

- Later, add exact iPad return URIs only after the iPad app exists.
- OAuth state and login tickets must be random, high entropy, short-lived, and
  one-time-use.
- Every stored OAuth attempt and login ticket must schedule the Durable Object's
  cleanup alarm for the earliest expiry. The alarm deletes expired rows and
  reschedules itself until no OAuth data remains; expiry must never depend on a
  later user request arriving.
- Store Notion client secret only in Cloudflare secrets.
- Do not log authorization codes, tickets, access tokens, or refresh tokens.
- Disable persisted Workers invocation logs. OAuth callback query strings carry
  short-lived authorization codes and state values, so request URLs must not be
  retained. Keep Cloudflare's aggregate Worker metrics for operational health.
- A network/broker failure must not cause the Giraph app to delete local tokens.
- Refresh-token rotation must be atomic from the app's point of view: the app
  must replace both tokens only after a successful refresh response.

## Step 1: Create Or Prepare Cloudflare Account

1. Create/log into Cloudflare.
2. Stay on the Free plan for the first version.
3. Add `connectyourcharger.com` as a Cloudflare zone if it is not already there.
4. If the domain registrar is outside Cloudflare, update the domain's
   nameservers to the Cloudflare nameservers shown in the Cloudflare dashboard.
5. Wait until Cloudflare shows the zone as active.

Cloudflare must be authoritative for the `connectyourcharger.com` DNS zone so it
can create the `auth.connectyourcharger.com` Worker Custom Domain record, issue
and renew its TLS certificate, and route requests for that hostname to the
Worker. This does not require proxying unrelated website or email records:
leave those records configured for their existing providers and use DNS-only
mode where appropriate. Only `auth.connectyourcharger.com` is bound to the
OAuth broker.

## Step 2: Create Or Update The Notion Public Connection

In Notion:

1. Open:

   ```text
   https://www.notion.so/my-integrations
   ```

2. Create or open the Giraph public connection.
3. Add this redirect URI exactly:

   ```text
   https://auth.connectyourcharger.com/oauth/notion/callback
   ```

4. Copy the OAuth client ID.
5. Copy the OAuth client secret.
6. Confirm the connection has only the capabilities Giraph needs:
   - read selected pages/databases;
   - read comments/blocks if the current app needs mentions/comments;
   - read workspace users if required by existing Notion permission setup.

Important: if you create a brand-new Notion connection/client ID, existing app
users will probably need to reconnect. If you keep the same client ID and only
move token exchange to the broker, existing refresh tokens may continue to work.

## Step 3: Create A Separate Broker Project

Create this outside the Giraph app repo. Recommended folder name:

```text
giraph-oauth-broker
```

Commands:

```shell
mkdir giraph-oauth-broker
cd giraph-oauth-broker
npm init -y
npm install --save-dev wrangler typescript @cloudflare/workers-types
mkdir src
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "types": ["@cloudflare/workers-types"],
    "noEmit": true
  },
  "include": ["src"]
}
```

Update `package.json` scripts:

```json
{
  "scripts": {
    "ci:local": "npm run typecheck && npm test && wrangler deploy --dry-run",
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run && node --test test/wrangler-config.test.mjs",
    "typecheck": "tsc --noEmit && tsc --noEmit -p test/tsconfig.json"
  }
}
```

## Step 4: Add Wrangler Configuration

Create `wrangler.jsonc`:

```jsonc
{
  "name": "giraph-oauth-broker",
  "main": "src/index.ts",
  "compatibility_date": "2026-07-18",
  "observability": {
    "enabled": false,
    "logs": {
      "enabled": false,
      "invocation_logs": false,
      "persist": false
    }
  },
  "durable_objects": {
    "bindings": [
      {
        "name": "OAUTH_STATE",
        "class_name": "OAuthState",
      },
    ],
  },
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["OAuthState"],
    },
  ],
  "vars": {
    "NOTION_REDIRECT_URI": "https://auth.connectyourcharger.com/oauth/notion/callback",
    "ALLOWED_RETURN_URIS": "http://localhost:41987/callback",
    "OAUTH_ATTEMPT_TTL_SEC": "600",
    "LOGIN_TICKET_TTL_SEC": "300",
    "MAX_JSON_BODY_BYTES": "2048",
    "ABUSE_WINDOW_SEC": "60",
    "OAUTH_START_LIMIT_PER_WINDOW": "30",
    "TICKET_COMPLETE_LIMIT_PER_WINDOW": "60",
    "REFRESH_LIMIT_PER_WINDOW": "120",
  },
  "routes": [
    {
      "pattern": "auth.connectyourcharger.com",
      "custom_domain": true,
    },
  ],
}
```

Notes:

- `OAUTH_ATTEMPT_TTL_SEC=600` gives the user 10 minutes to complete Notion
  consent.
- `LOGIN_TICKET_TTL_SEC=300` gives the app 5 minutes to redeem the broker ticket.
- `MAX_JSON_BODY_BYTES=2048` is enough for the broker's tiny JSON payloads and
  prevents accidentally buffering large request bodies.
- The abuse-window limits are conservative per-IP caps for abnormal retry loops
  and scripted traffic. They are intentionally generous for shared home or office
  networks.
- The broker uses the dedicated `auth.connectyourcharger.com` hostname so it
  does not replace or intercept traffic for the root domain.

## Step 5: Add Secrets

Log into Cloudflare Wrangler:

```shell
npx wrangler login
```

Set secrets:

```shell
npx wrangler secret put NOTION_CLIENT_ID
npx wrangler secret put NOTION_CLIENT_SECRET
```

Paste the values copied from the Notion integration dashboard.

Do not commit secrets to Git.

## Step 6: Implement The Worker

Create `src/index.ts`:

```ts
export interface Env {
  OAUTH_STATE: DurableObjectNamespace<OAuthState>
  NOTION_CLIENT_ID: string
  NOTION_CLIENT_SECRET: string
  NOTION_REDIRECT_URI: string
  ALLOWED_RETURN_URIS: string
  OAUTH_ATTEMPT_TTL_SEC: string
  LOGIN_TICKET_TTL_SEC: string
  MAX_JSON_BODY_BYTES: string
  ABUSE_WINDOW_SEC: string
  OAUTH_START_LIMIT_PER_WINDOW: string
  TICKET_COMPLETE_LIMIT_PER_WINDOW: string
  REFRESH_LIMIT_PER_WINDOW: string
}

type Json = Record<string, unknown>

type JsonParseResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; response: Response }

type TextReadResult = { ok: true; text: string } | { ok: false; response: Response }

const NOTION_AUTHORIZE_URL = 'https://api.notion.com/v1/oauth/authorize'
const NOTION_TOKEN_URL = 'https://api.notion.com/v1/oauth/token'

function json(body: Json, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
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

function oauthStateObject(env: Env): DurableObjectStub {
  const id = env.OAUTH_STATE.idFromName('global-oauth-state')
  return env.OAUTH_STATE.get(id)
}

function isLocalDevelopmentRequest(url: URL): boolean {
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
}

function isHttpsRequest(request: Request, url: URL): boolean {
  if (url.protocol === 'https:') return true
  return request.headers.get('cf-visitor')?.includes('"scheme":"https"') ?? false
}

function maxJsonBodyBytes(env: Env): number {
  return Number(env.MAX_JSON_BODY_BYTES || '2048')
}

async function readTextWithLimit(request: Request, maxBytes: number): Promise<TextReadResult> {
  const contentLength = request.headers.get('content-length')
  if (contentLength !== null && Number(contentLength) > maxBytes) {
    return { ok: false, response: json({ error: 'request_too_large' }, 413) }
  }

  if (!request.body) return { ok: true, text: '' }

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue

    totalBytes += value.byteLength
    if (totalBytes > maxBytes) {
      await reader.cancel()
      return { ok: false, response: json({ error: 'request_too_large' }, 413) }
    }

    chunks.push(value)
  }

  const body = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }

  return { ok: true, text: new TextDecoder().decode(body) }
}

async function parseJsonRequest(request: Request, maxBytes: number): Promise<JsonParseResult> {
  const read = await readTextWithLimit(request, maxBytes)
  if (!read.ok) return read

  try {
    const parsed = read.text.length > 0 ? JSON.parse(read.text) : {}
    const body =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {}
    return { ok: true, body }
  } catch {
    return { ok: false, response: json({ error: 'invalid_json' }, 400) }
  }
}

async function exchangeWithNotion(env: Env, body: Record<string, unknown>): Promise<Response> {
  const basic = btoa(`${env.NOTION_CLIENT_ID}:${env.NOTION_CLIENT_SECRET}`)
  return fetch(NOTION_TOKEN_URL, {
    method: 'POST',
    headers: {
      authorization: `Basic ${basic}`,
      'content-type': 'application/json',
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (!isLocalDevelopmentRequest(url) && !isHttpsRequest(request, url)) {
      return json({ error: 'https_required' }, 403)
    }

    if (url.pathname === '/health') {
      return json({ ok: true, service: 'giraph-oauth-broker' })
    }

    if (
      url.pathname === '/oauth/notion/start' ||
      url.pathname === '/oauth/notion/callback' ||
      url.pathname === '/oauth/notion/complete' ||
      url.pathname === '/oauth/notion/refresh'
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
  value: string
  expires_at: number
}

interface NextExpiryRow {
  next_expiry: number | null
}

interface StoredAbuseCounterRow {
  count: number
  reset_at: number
}

export class OAuthState {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS oauth_items (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        )
      `)
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS abuse_counters (
          key TEXT PRIMARY KEY,
          count INTEGER NOT NULL,
          reset_at INTEGER NOT NULL
        )
      `)
      this.deleteExpired()
      await this.scheduleNextCleanup()
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

    if (url.pathname === '/oauth/notion/refresh') {
      return this.handleRefresh(request)
    }

    return json({ error: 'not_found' }, 404)
  }

  async alarm(): Promise<void> {
    this.deleteExpired()
    await this.scheduleNextCleanup()
  }

  private deleteExpired(): void {
    const now = Date.now()
    this.ctx.storage.sql.exec('DELETE FROM oauth_items WHERE expires_at <= ?', now)
    this.ctx.storage.sql.exec('DELETE FROM abuse_counters WHERE reset_at <= ?', now)
  }

  private async putItem(key: string, value: unknown, expiresAt: number): Promise<void> {
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
    await this.scheduleNextCleanup()
  }

  private async getItem<T>(key: string): Promise<T | null> {
    this.deleteExpired()
    await this.scheduleNextCleanup()
    const row = this.ctx.storage.sql
      .exec('SELECT value, expires_at FROM oauth_items WHERE key = ?', key)
      .one<StoredRow | null>()

    if (!row) return null
    if (row.expires_at <= Date.now()) {
      await this.deleteItem(key)
      return null
    }
    return JSON.parse(row.value) as T
  }

  private async deleteItem(key: string): Promise<void> {
    this.ctx.storage.sql.exec('DELETE FROM oauth_items WHERE key = ?', key)
    await this.scheduleNextCleanup()
  }

  private async scheduleNextCleanup(): Promise<void> {
    const row = this.ctx.storage.sql
      .exec('SELECT MIN(expires_at) AS next_expiry FROM oauth_items')
      .one<NextExpiryRow | null>()
    const nextExpiry = row?.next_expiry

    if (typeof nextExpiry !== 'number') {
      await this.ctx.storage.deleteAlarm()
      return
    }

    await this.ctx.storage.setAlarm(Math.max(nextExpiry, Date.now() + 1))
  }

  private clientAbuseKey(scope: string, request: Request): string {
    return `abuse:${scope}:${request.headers.get('cf-connecting-ip') || 'local-dev'}`
  }

  private checkRateLimit(scope: string, request: Request, limit: number): Response | null {
    this.deleteExpired()

    const now = Date.now()
    const windowMs = Number(this.env.ABUSE_WINDOW_SEC || '60') * 1000
    const key = this.clientAbuseKey(scope, request)
    const row = this.ctx.storage.sql
      .exec('SELECT count, reset_at FROM abuse_counters WHERE key = ?', key)
      .one<StoredAbuseCounterRow | null>()

    if (!row || row.reset_at <= now) {
      this.ctx.storage.sql.exec(
        'INSERT OR REPLACE INTO abuse_counters (key, count, reset_at) VALUES (?, ?, ?)',
        key,
        1,
        now + windowMs,
      )
      return null
    }

    if (row.count >= limit) {
      const retryAfter = Math.max(1, Math.ceil((row.reset_at - now) / 1000))
      return json({ error: 'rate_limited' }, 429, { 'retry-after': String(retryAfter) })
    }

    this.ctx.storage.sql.exec('UPDATE abuse_counters SET count = count + 1 WHERE key = ?', key)
    return null
  }

  private async handleStart(request: Request): Promise<Response> {
    if (request.method !== 'POST') return methodNotAllowed()

    const limited = this.checkRateLimit(
      'oauth_start',
      request,
      Number(this.env.OAUTH_START_LIMIT_PER_WINDOW || '30'),
    )
    if (limited) return limited

    const parsed = await parseJsonRequest(request, maxJsonBodyBytes(this.env))
    if (!parsed.ok) return parsed.response

    const body = parsed.body
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

    await this.putItem(`state:${state}`, attempt, expiresAt)

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

    const attempt = await this.getItem<OAuthAttempt>(`state:${state}`)
    if (!attempt)
      return this.renderFailure('OAuth attempt expired. Return to Giraph and try again.')

    const error = url.searchParams.get('error')
    if (error) {
      await this.deleteItem(`state:${state}`)
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

    await this.putItem(`ticket:${ticket}`, loginTicket, ticketExpiresAt)
    await this.deleteItem(`state:${state}`)

    const target = new URL(attempt.appReturnUri)
    target.searchParams.set('ticket', ticket)
    target.searchParams.set('attempt_id', attempt.attemptId)
    return Response.redirect(target.toString(), 302)
  }

  private async handleComplete(request: Request): Promise<Response> {
    if (request.method !== 'POST') return methodNotAllowed()

    const limited = this.checkRateLimit(
      'ticket_complete',
      request,
      Number(this.env.TICKET_COMPLETE_LIMIT_PER_WINDOW || '60'),
    )
    if (limited) return limited

    const parsed = await parseJsonRequest(request, maxJsonBodyBytes(this.env))
    if (!parsed.ok) return parsed.response

    const body = parsed.body
    const ticket = body.ticket
    const attemptId = body.attemptId

    if (typeof ticket !== 'string' || typeof attemptId !== 'string') {
      return json({ error: 'missing_ticket' }, 400)
    }

    const stored = await this.getItem<LoginTicket>(`ticket:${ticket}`)
    if (!stored || stored.attemptId !== attemptId) {
      return json({ error: 'invalid_or_expired_ticket' }, 401)
    }

    await this.deleteItem(`ticket:${ticket}`)
    return json(stored.tokenResponse)
  }

  private async handleRefresh(request: Request): Promise<Response> {
    if (request.method !== 'POST') return methodNotAllowed()

    const limited = this.checkRateLimit(
      'refresh',
      request,
      Number(this.env.REFRESH_LIMIT_PER_WINDOW || '120'),
    )
    if (limited) return limited

    const parsed = await parseJsonRequest(request, maxJsonBodyBytes(this.env))
    if (!parsed.ok) return parsed.response

    const refreshToken = parsed.body.refreshToken

    if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
      return json({ error: 'missing_refresh_token' }, 400)
    }

    const notionResponse = await exchangeWithNotion(this.env, {
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
```

## Step 7: Typecheck Locally

Run:

```shell
npm run typecheck
```

If TypeScript reports Cloudflare-specific typing issues, make sure:

- `@cloudflare/workers-types` is installed;
- `tsconfig.json` includes `"types": ["@cloudflare/workers-types"]`;
- `wrangler.jsonc` declares the Durable Object binding and migration.

## Step 8: Run Locally

Run:

```shell
npm run dev
```

Wrangler will print a local URL, usually:

```text
http://localhost:8787
```

Test health:

```shell
curl http://localhost:8787/health
```

Expected response:

```json
{
  "ok": true,
  "service": "giraph-oauth-broker"
}
```

For local OAuth testing, you have two choices:

1. Test only `/health` and deploy before testing real Notion OAuth.
2. Temporarily add a local Notion redirect URI if Notion allows it:

   ```text
   http://localhost:8787/oauth/notion/callback
   ```

   Then temporarily change `NOTION_REDIRECT_URI` in Wrangler local vars.

The simplest path is to deploy and test against the real
`https://auth.connectyourcharger.com/oauth/notion/callback` redirect.

## Step 9: Deploy

Run:

```shell
npm run deploy
```

After deploy, test:

```shell
curl https://auth.connectyourcharger.com/health
```

Expected:

```json
{
  "ok": true,
  "service": "giraph-oauth-broker"
}
```

If the custom domain does not work:

1. Open Cloudflare dashboard.
2. Go to `Workers & Pages`.
3. Select `giraph-oauth-broker`.
4. Go to `Settings` -> `Domains & Routes`.
5. Add `auth.connectyourcharger.com` as a Custom Domain.
6. Wait for Cloudflare to create/activate the DNS record.

## Step 10: Configure Cloudflare Cost Monitoring

In Cloudflare dashboard:

1. Open your account.
2. Go to `Manage Account` -> `Billing`.
3. Open `Billable Usage`.
4. Create budget alerts:
   - `$1` warning;
   - `$5` warning;
   - `$10` urgent warning.
5. Add your email address as recipient.

Budget alerts are informational. They warn you; they do not automatically stop
usage. To keep the first release no-surprise, stay on the Free plan until the
broker is proven and usage is understood.

## Step 11: Monitor Requests

In Cloudflare dashboard:

1. Go to `Workers & Pages`.
2. Select `giraph-oauth-broker`.
3. Open `Metrics`.
4. Watch:
   - total requests;
   - errors;
   - subrequests;
   - CPU/resource errors.

Daily operational check during launch:

```text
Requests today
Errors today
Refresh endpoint errors
Notion token exchange failures
Notion refresh failures
```

Persisted Workers Logs are off (`observability.enabled`, `logs.enabled`,
`invocation_logs`, and `persist` are all `false`) because OAuth callback
URLs contain short-lived authorization codes and state values. Use the aggregate
Workers metrics above. If endpoint-level counters are needed later, add
allowlisted numeric metrics only; do not retain request URLs, query strings,
headers, bodies, tokens, tickets, user ids, or workspace ids.

## Step 12: Add Basic Abuse Protection

The Worker code above already includes the first-version abuse protection without
creating accounts:

- production requests must arrive over HTTPS; local `localhost` development is
  exempt;
- `appReturnUri` must exactly match one of `ALLOWED_RETURN_URIS`;
- JSON request bodies are capped by `MAX_JSON_BODY_BYTES`;
- OAuth attempts and login tickets use short TTLs;
- Durable Object alarms physically delete expired OAuth attempts and login
  tickets even if no later request arrives;
- `/oauth/notion/start`, `/oauth/notion/complete`, and `/oauth/notion/refresh`
  have simple Durable Object-backed per-IP window counters;
- Notion token exchange failures return generic broker errors;
- the Worker code does not log secrets, authorization codes, tickets, access
  tokens, or refresh tokens.
- persisted Workers Logs are off in `wrangler.jsonc`: `observability.enabled`,
  `logs.enabled`, `invocation_logs`, and `persist` are all `false`. Aggregate
  Worker metrics remain available without that switch.

The abuse counters are intentionally modest, not a full account system. They
exist to blunt broken clients and obvious scripts while keeping normal login and
refresh flows boring.

Suggested Cloudflare WAF/rate limit later:

```text
Endpoint: /oauth/notion/refresh
Limit: stricter per IP after real traffic is understood
Action: throttle/challenge/block after abnormal traffic
```

Do not overbuild this before launch. The broker does not expose user data and
does not proxy sync traffic. Use Cloudflare WAF rules later if dashboard metrics
show real abuse beyond what the Worker-level counters handle.

## Step 13: Manual End-To-End Test With The App Contract

Before connecting the real Giraph app, test the broker contract manually.

Start OAuth:

```shell
curl -X POST https://auth.connectyourcharger.com/oauth/notion/start \
  -H 'content-type: application/json' \
  -d '{"platform":"electron","appReturnUri":"http://localhost:41987/callback"}'
```

Expected:

```json
{
  "authorizeUrl": "https://api.notion.com/v1/oauth/authorize?...",
  "attemptId": "...",
  "expiresAt": "..."
}
```

Abuse protection smoke tests:

```shell
curl -X POST https://auth.connectyourcharger.com/oauth/notion/start \
  -H 'content-type: application/json' \
  -d '{"appReturnUri":"https://evil.example/callback"}'
```

Expected:

```json
{
  "error": "invalid_return_uri"
}
```

```shell
curl -X POST https://auth.connectyourcharger.com/oauth/notion/start \
  -H 'content-type: application/json' \
  -d '{'
```

Expected:

```json
{
  "error": "invalid_json"
}
```

```shell
python3 - <<'PY' | curl -X POST https://auth.connectyourcharger.com/oauth/notion/start \
  -H 'content-type: application/json' \
  --data-binary @-
print('{"appReturnUri":"http://localhost:41987/callback","padding":"' + 'x' * 4096 + '"}')
PY
```

Expected:

```json
{
  "error": "request_too_large"
}
```

If you temporarily lower `OAUTH_START_LIMIT_PER_WINDOW` to `2` for testing and
redeploy, the third valid start request from the same IP during one abuse window
should return:

```json
{
  "error": "rate_limited"
}
```

Open `authorizeUrl` in a browser and approve Notion access.

Because Giraph is not connected yet, the final redirect to
`http://localhost:41987/callback?...` may fail in the browser unless a local app
or test server is listening. That is okay for this manual broker test. The
important parts are:

- Notion consent screen shows `auth.connectyourcharger.com`, not `localhost:41987`;
- the broker callback does not show a server error;
- the redirect URL contains `ticket` and `attempt_id`, not access tokens.

Once the app PRD is implemented, Giraph will receive that localhost callback and
redeem the ticket.

## Step 14: Connect Giraph App Later

After the broker is deployed and tested:

1. Implement the app-side PRD:

   ```text
   prd/active/OAUTH-BROKER-APP-INTEGRATION-PRD.md
   ```

2. Configure the app build:

   ```text
   GIRAPH_OAUTH_MODE=broker
   GIRAPH_OAUTH_BROKER_BASE_URL=https://auth.connectyourcharger.com
   GIRAPH_OAUTH_DESKTOP_RETURN_URI=http://localhost:41987/callback
   ```

3. Remove `NOTION_OAUTH_CLIENT_SECRET` from production app build requirements.
4. Confirm production bundles do not contain the Notion client secret.
5. Run a real desktop login.
6. Confirm Notion consent shows:

   ```text
   Giraph (auth.connectyourcharger.com)
   ```

7. Confirm Giraph saves tokens after ticket redemption.
8. Force token refresh and confirm `/oauth/notion/refresh` works.
9. Confirm normal sync still goes directly from Giraph to Notion, not through the
   broker.

## Step 15: Paid Upgrade Later

Migration from Free to Paid should not require code changes.

When ready:

1. Open Cloudflare dashboard.
2. Go to `Workers & Pages`.
3. Upgrade Workers plan.
4. Add billing information.
5. Keep budget alerts active.
6. Watch Worker metrics for the next few days.

Paid Workers currently have a small monthly minimum and usage-based overages.
Only upgrade after you have budget alerts and you understand normal request
volume.

## Launch Checklist

- [ ] Cloudflare account created.
- [ ] `connectyourcharger.com` DNS zone active in Cloudflare.
- [ ] `auth.connectyourcharger.com` bound to the Worker as a Custom Domain.
- [ ] Worker project created outside Giraph app repo.
- [ ] Durable Object binding configured.
- [ ] Notion redirect URI registered:
      `https://auth.connectyourcharger.com/oauth/notion/callback`.
- [ ] `NOTION_CLIENT_ID` secret set in Cloudflare.
- [ ] `NOTION_CLIENT_SECRET` secret set in Cloudflare.
- [ ] `/health` works on `https://auth.connectyourcharger.com`.
- [ ] `/oauth/notion/start` returns an authorize URL.
- [ ] Basic abuse protection smoke tests return the expected errors.
- [ ] Notion consent screen shows `auth.connectyourcharger.com`.
- [ ] Callback redirects to localhost with `ticket`, not tokens.
- [ ] Worker metrics visible in Cloudflare dashboard.
- [ ] Budget alerts configured before upgrading to any paid plan.
- [ ] App-side PRD implemented and connected.

## Do Not Build Yet

Avoid these until there is a real need:

- Postgres;
- Redis;
- Docker;
- Kubernetes;
- a VPS;
- a full Giraph user account system;
- proxying all Notion API calls;
- server-side storage of users' Notion refresh tokens.

This broker should stay deliberately small.
