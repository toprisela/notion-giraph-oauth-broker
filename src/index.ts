import { DurableObject } from "cloudflare:workers";

type ClientPlatform = "desktop" | "ipad";

// Published Electron clients send "electron"; older clients omit the field.
// Keep these aliases at the wire boundary, storing a single desktop identity.
function clientPlatform(value: unknown): ClientPlatform | null {
  if (value === undefined || value === "electron" || value === "desktop")
    return "desktop";
  return value === "ipad" ? "ipad" : null;
}

type Json = Record<string, unknown>;

const NOTION_AUTHORIZE_URL = "https://api.notion.com/v1/oauth/authorize";
const NOTION_TOKEN_URL = "https://api.notion.com/v1/oauth/token";
const NOTION_VERSION = "2026-03-11";
const MAX_JSON_BODY_BYTES = 8 * 1024;

function json(body: Json, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function methodNotAllowed(): Response {
  return json({ error: "method_not_allowed" }, 405);
}

function randomId(bytes = 32): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return [...data].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function allowedReturnUris(env: Env): Set<string> {
  return new Set(
    env.ALLOWED_RETURN_URIS.split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function allowedIpadReturnUris(env: Env): Set<string> {
  return new Set(
    env.ALLOWED_IPAD_RETURN_URIS.split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function isAllowedReturnUri(
  env: Env,
  platform: ClientPlatform,
  uri: string,
): boolean {
  return (
    platform === "ipad" ? allowedIpadReturnUris(env) : allowedReturnUris(env)
  ).has(uri);
}

function isPkceChallenge(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function isPkceVerifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._~-]{43,128}$/.test(value);
}

function isAppState(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function base64Url(data: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(data)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

async function verifierMatchesChallenge(
  verifier: string,
  challenge: string,
): Promise<boolean> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  const actual = new TextEncoder().encode(base64Url(digest));
  const expected = new TextEncoder().encode(challenge);
  return crypto.subtle.timingSafeEqual(actual, expected);
}

async function appStateMatches(
  actual: string,
  expected: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(actual)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(actualHash, expectedHash);
}

function oauthStateObject(env: Env): DurableObjectStub<OAuthState> {
  return env.OAUTH_STATE.getByName("global-oauth-state");
}

async function parseJson(
  request: Request | Response,
  maxBytes = MAX_JSON_BODY_BYTES,
): Promise<Record<string, unknown>> {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  ) {
    return {};
  }

  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) return {};
  if (!request.body) return {};

  try {
    const reader = request.body.getReader();
    const decoder = new TextDecoder();
    let totalBytes = 0;
    let text = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        return {};
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();

    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function exchangeWithNotion(
  env: Env,
  body: Record<string, unknown>,
): Promise<Response> {
  const basic = btoa(`${env.NOTION_CLIENT_ID}:${env.NOTION_CLIENT_SECRET}`);

  try {
    return await fetch(NOTION_TOKEN_URL, {
      // Workers supports follow/manual, not the browser/Node "error" mode.
      // Never forward Basic credentials through a redirect; callers reject non-2xx.
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        "content-type": "application/json",
        "notion-version": NOTION_VERSION,
      },
      body: JSON.stringify(body),
    });
  } catch {
    return json({ error: "notion_unavailable" }, 502);
  }
}

function hasTokenPair(data: Json): boolean {
  return (
    typeof data.access_token === "string" &&
    data.access_token.trim().length > 0 &&
    typeof data.refresh_token === "string" &&
    data.refresh_token.trim().length > 0
  );
}

function normalizeTokenResponse(data: Record<string, unknown>): Json {
  const expiresInSec =
    typeof data.expires_in === "number"
      ? data.expires_in
      : typeof data.expiresInSec === "number"
        ? data.expiresInSec
        : null;
  const issuedAt = new Date();
  const accessTokenExpiresAt =
    expiresInSec === null
      ? null
      : new Date(issuedAt.getTime() + expiresInSec * 1000).toISOString();

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
  };
}

async function handleRefresh(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed();

  const body = await parseJson(request);
  const refreshToken = body.refreshToken;

  if (typeof refreshToken !== "string" || refreshToken.length === 0) {
    return json({ error: "missing_refresh_token" }, 400);
  }

  const notionResponse = await exchangeWithNotion(env, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  const data = await parseJson(notionResponse, 64 * 1024);
  if (!notionResponse.ok) {
    const invalid =
      (notionResponse.status === 400 || notionResponse.status === 401) &&
      data.error === "invalid_grant";
    return json(
      { error: invalid ? "invalid_refresh_token" : "notion_refresh_failed" },
      invalid ? 401 : 502,
    );
  }
  if (!hasTokenPair(data)) return json({ error: "notion_refresh_failed" }, 502);
  return json(normalizeTokenResponse(data));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true, service: "giraph-oauth-broker" });
    }

    if (url.pathname === "/oauth/notion/refresh") {
      return handleRefresh(request, env);
    }

    if (
      url.pathname === "/oauth/notion/start" ||
      url.pathname === "/oauth/notion/callback" ||
      url.pathname === "/oauth/notion/complete"
    ) {
      return oauthStateObject(env).fetch(request);
    }

    return json({ error: "not_found" }, 404);
  },
};

interface OAuthAttempt {
  attemptId: string;
  appReturnUri: string;
  platform: ClientPlatform;
  codeChallenge?: string;
  codeChallengeMethod?: "S256";
  appState?: string;
  expiresAt: number;
}

interface LoginTicket {
  attemptId: string;
  platform?: ClientPlatform;
  codeChallenge?: string;
  codeChallengeMethod?: "S256";
  appState?: string;
  tokenResponse: Json;
  expiresAt: number;
}

interface StoredRow {
  [key: string]: SqlStorageValue;
  value: string;
  expires_at: number;
}

interface StoredItem<T> {
  parsed: T;
  raw: string;
}

interface NextExpiryRow {
  [key: string]: SqlStorageValue;
  next_expiry: number | null;
}

export class OAuthState extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS oauth_items (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        )
      `);
      this.deleteExpired();
      await this.scheduleNextCleanup();
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/oauth/notion/start") {
      return this.handleStart(request);
    }

    if (url.pathname === "/oauth/notion/callback") {
      return this.handleCallback(request);
    }

    if (url.pathname === "/oauth/notion/complete") {
      return this.handleComplete(request);
    }

    return json({ error: "not_found" }, 404);
  }

  async alarm(): Promise<void> {
    this.deleteExpired();
    await this.scheduleNextCleanup();
  }

  private deleteExpired(): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM oauth_items WHERE expires_at <= ?",
      Date.now(),
    );
  }

  private async putItem(
    key: string,
    value: unknown,
    expiresAt: number,
  ): Promise<void> {
    this.deleteExpired();
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
    );
    await this.scheduleNextCleanup();
  }

  private peekItem<T>(key: string): StoredItem<T> | null {
    this.deleteExpired();
    const row = this.ctx.storage.sql
      .exec<StoredRow>(
        "SELECT value, expires_at FROM oauth_items WHERE key = ?",
        key,
      )
      .toArray()[0];

    if (!row || row.expires_at <= Date.now()) return null;
    return { parsed: JSON.parse(row.value) as T, raw: row.value };
  }

  private async consumeItem(
    key: string,
    expectedRaw: string,
  ): Promise<boolean> {
    const cursor = this.ctx.storage.sql.exec(
      "DELETE FROM oauth_items WHERE key = ? AND value = ? AND expires_at > ?",
      key,
      expectedRaw,
      Date.now(),
    );
    await this.scheduleNextCleanup();
    return cursor.rowsWritten === 1;
  }

  private async scheduleNextCleanup(): Promise<void> {
    const row = this.ctx.storage.sql
      .exec<NextExpiryRow>(
        "SELECT MIN(expires_at) AS next_expiry FROM oauth_items",
      )
      .toArray()[0];
    const nextExpiry = row?.next_expiry;

    if (typeof nextExpiry !== "number") {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    await this.ctx.storage.setAlarm(Math.max(nextExpiry, Date.now() + 1));
  }

  private async handleStart(request: Request): Promise<Response> {
    if (request.method !== "POST") return methodNotAllowed();

    const body = await parseJson(request);
    const appReturnUri = body.appReturnUri;
    const platform = clientPlatform(body.platform);
    if (!platform) return json({ error: "invalid_platform" }, 400);
    const codeChallenge = body.codeChallenge;
    const codeChallengeMethod = body.codeChallengeMethod;
    const appState = body.appState;

    if (
      typeof appReturnUri !== "string" ||
      !isAllowedReturnUri(this.env, platform, appReturnUri)
    ) {
      return json({ error: "invalid_return_uri" }, 400);
    }

    if (
      platform === "ipad" &&
      (!isPkceChallenge(codeChallenge) ||
        codeChallengeMethod !== "S256" ||
        !isAppState(appState))
    ) {
      return json({ error: "invalid_pkce_challenge" }, 400);
    }

    const state = randomId();
    const attemptId = randomId(16);
    const ttlMs = Number(this.env.OAUTH_ATTEMPT_TTL_SEC || "600") * 1000;
    const expiresAt = Date.now() + ttlMs;

    const attempt: OAuthAttempt = {
      attemptId,
      appReturnUri,
      platform,
      ...(platform === "ipad"
        ? {
            codeChallenge: codeChallenge as string,
            codeChallengeMethod: "S256" as const,
            appState: appState as string,
          }
        : {}),
      expiresAt,
    };

    await this.putItem(`state:${state}`, attempt, expiresAt);

    const authorize = new URL(NOTION_AUTHORIZE_URL);
    authorize.searchParams.set("client_id", this.env.NOTION_CLIENT_ID);
    authorize.searchParams.set("redirect_uri", this.env.NOTION_REDIRECT_URI);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("owner", "user");
    authorize.searchParams.set("state", state);

    return json({
      authorizeUrl: authorize.toString(),
      attemptId,
      expiresAt: new Date(expiresAt).toISOString(),
    });
  }

  private async handleCallback(request: Request): Promise<Response> {
    if (request.method !== "GET") return methodNotAllowed();

    const url = new URL(request.url);
    const state = url.searchParams.get("state");
    if (!state) return this.renderFailure("Missing OAuth state.");

    const stateKey = `state:${state}`;
    const storedAttempt = this.peekItem<OAuthAttempt>(stateKey);
    if (!storedAttempt) {
      return this.renderFailure(
        "OAuth attempt expired. Return to Giraph and try again.",
      );
    }
    const attempt = storedAttempt.parsed;

    const error = url.searchParams.get("error");
    if (error) {
      if (!(await this.consumeItem(stateKey, storedAttempt.raw))) {
        return this.renderFailure(
          "OAuth attempt was already completed. Return to Giraph and try again.",
        );
      }
      const target = new URL(attempt.appReturnUri);
      target.searchParams.set(
        "error",
        error === "access_denied" ? "access_denied" : "oauth_error",
      );
      target.searchParams.set("attempt_id", attempt.attemptId);
      if (attempt.platform === "ipad" && attempt.appState) {
        target.searchParams.set("app_state", attempt.appState);
      }
      return Response.redirect(target.toString(), 302);
    }

    const code = url.searchParams.get("code");
    if (!code) return this.renderFailure("Missing authorization code.");

    if (!(await this.consumeItem(stateKey, storedAttempt.raw))) {
      return this.renderFailure(
        "OAuth attempt was already completed. Return to Giraph and try again.",
      );
    }

    const notionResponse = await exchangeWithNotion(this.env, {
      grant_type: "authorization_code",
      code,
      redirect_uri: this.env.NOTION_REDIRECT_URI,
    });

    const notionData = await parseJson(notionResponse, 64 * 1024);
    if (!notionResponse.ok) {
      return this.renderFailure(
        "Token exchange failed. Return to Giraph and try again.",
      );
    }

    if (!hasTokenPair(notionData)) {
      return this.renderFailure(
        "Invalid token exchange response. Return to Giraph and try again.",
      );
    }
    const ticket = randomId();
    const ticketTtlMs = Number(this.env.LOGIN_TICKET_TTL_SEC || "300") * 1000;
    const ticketExpiresAt = Date.now() + ticketTtlMs;

    const loginTicket: LoginTicket = {
      attemptId: attempt.attemptId,
      platform: attempt.platform,
      ...(attempt.platform === "ipad"
        ? {
            codeChallenge: attempt.codeChallenge,
            codeChallengeMethod: attempt.codeChallengeMethod,
            appState: attempt.appState,
          }
        : {}),
      tokenResponse: normalizeTokenResponse(notionData),
      expiresAt: ticketExpiresAt,
    };

    await this.putItem(`ticket:${ticket}`, loginTicket, ticketExpiresAt);

    const target = new URL(attempt.appReturnUri);
    target.searchParams.set("ticket", ticket);
    target.searchParams.set("attempt_id", attempt.attemptId);
    if (attempt.platform === "ipad" && attempt.appState) {
      target.searchParams.set("app_state", attempt.appState);
    }
    return Response.redirect(target.toString(), 302);
  }

  private async handleComplete(request: Request): Promise<Response> {
    if (request.method !== "POST") return methodNotAllowed();

    const body = await parseJson(request);
    const ticket = body.ticket;
    const attemptId = body.attemptId;
    const platform = clientPlatform(body.platform);
    const codeVerifier = body.codeVerifier;
    const appState = body.appState;

    if (typeof ticket !== "string" || typeof attemptId !== "string") {
      return json({ error: "missing_ticket" }, 400);
    }

    const ticketKey = `ticket:${ticket}`;
    const storedItem = this.peekItem<LoginTicket>(ticketKey);
    await this.scheduleNextCleanup();
    if (!storedItem || storedItem.parsed.attemptId !== attemptId) {
      return json({ error: "invalid_or_expired_ticket" }, 401);
    }
    const stored = storedItem.parsed;

    if (stored.platform === "ipad") {
      if (
        platform !== "ipad" ||
        stored.codeChallengeMethod !== "S256" ||
        !isPkceChallenge(stored.codeChallenge) ||
        !isPkceVerifier(codeVerifier) ||
        !isAppState(appState) ||
        !isAppState(stored.appState) ||
        !(await appStateMatches(appState, stored.appState)) ||
        !(await verifierMatchesChallenge(codeVerifier, stored.codeChallenge))
      ) {
        return json({ error: "invalid_or_expired_ticket" }, 401);
      }
    } else if (
      clientPlatform(stored.platform) !== "desktop" ||
      platform !== "desktop"
    ) {
      return json({ error: "invalid_or_expired_ticket" }, 401);
    }

    if (!(await this.consumeItem(ticketKey, storedItem.raw))) {
      return json({ error: "invalid_or_expired_ticket" }, 401);
    }
    return json(stored.tokenResponse);
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
      </html>`;

    return new Response(html, {
      status: 400,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
      },
    });
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
