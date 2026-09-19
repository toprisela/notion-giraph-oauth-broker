# Electron and iPad authentication

One production broker serves both separately sold apps. Notion OAuth grants workspace
access; it does not verify an App Store purchase or share purchase entitlements.
The Notion client secret stays in Cloudflare secrets, never either application.
Each installation keeps its own tokens. Both use the existing HTTPS start/callback/
complete/refresh endpoints; the native clients own browser/session and local storage.

## Supported wire contract

| Client                | Start/complete platform | Exact app return                                     | Ticket proof                                      |
| --------------------- | ----------------------- | ---------------------------------------------------- | ------------------------------------------------- |
| Published Electron    | `electron`              | `http://localhost:41987/callback`                    | ticket + attemptId                                |
| Older desktop clients | omitted, or `desktop`   | same localhost return                                | ticket + attemptId                                |
| iPad                  | `ipad`                  | `com.connectyourcharger.giraph.ipad:/oauth/callback` | ticket + attemptId + native state + S256 verifier |

This is an additive extension of the original protocol: endpoints and desktop response
fields stay compatible. No update of installed Electron clients is required. New breaking
protocols must use a separately versioned endpoint rather than changing these meanings.

1. Native app calls `/oauth/notion/start` with its platform and `appReturnUri`.
   iPad additionally sends `codeChallenge`, `codeChallengeMethod: "S256"`, and a
   43-character cryptographic `appState` generated and retained by Swift.
2. Broker returns `authorizeUrl`, `attemptId`, and ISO `expiresAt` with fractional seconds.
   Notion redirects to the broker's HTTPS callback, never directly to the private app scheme.
3. Broker exchanges the authorization code and returns to the allowlisted app URL with
   only `ticket`, `attempt_id`, and (for iPad) `app_state`. Cancellation returns
   `error`, `attempt_id`, and the same iPad `app_state`.
4. Native app validates its callback and redeems through `/oauth/notion/complete`.
   iPad validates `app_state` before redemption and must include its original
   `codeVerifier` and `appState`. Wrong platform/attempt/state/verifier does not
   consume a valid ticket. Conditional SQLite deletion allows only one redemption and
   checks expiry at consumption. Attempts/tickets are cleaned by Durable Object alarms.
5. Tokens are returned only as HTTPS JSON with `Cache-Control: no-store`. Owner identity
   retains Notion's nested `owner.user` shape; clients decode it before committing tokens.
6. Both apps refresh through `/oauth/notion/refresh` with `refreshToken`. No new platform
   field is required by this existing endpoint. Confirmed invalid grants return 401;
   transient/upstream protocol failures return 502 so clients retain their current session.

Incoming JSON and upstream token bodies are bounded. Token requests have a timeout and
reject redirects; malformed upstream success cannot create an authenticated ticket.
The token request uses `redirect: "manual"`, and callers reject non-2xx responses.
Cloudflare Workers rejects `redirect: "error"` when constructing the request, before
network I/O. Contract tests construct a real Workers `Request` before mocking the
upstream response, and cover redirect rejection for both login and refresh.
The retired `com.connectyourcharger.giraph:/oauth/callback` iPad return is not allowed.

## Development and staging

The default configuration remains the existing production Worker and production Durable
Object namespace. `--env staging` selects a separate Worker named
`giraph-oauth-broker-staging`, its own state namespace and
`https://auth-staging.connectyourcharger.com`. The local binding has no production
`script_name`; it must never point at the production namespace. Environments do not share
secrets or tokens. An iPad development build uses the staging broker URL already specified
by the app; release builds must select the production broker after acceptance.

One-time staging setup (operator action, not performed by local tests):

1. Create a separate Notion test integration/workspace. Register exactly
   `https://auth-staging.connectyourcharger.com/oauth/notion/callback` in that integration.
2. Set `NOTION_CLIENT_ID` and `NOTION_CLIENT_SECRET` using
   `npx wrangler secret put <NAME> --env staging`. Keep values out of Git and command args.
3. Run `npm run ci:local`, then explicitly deploy staging with `npm run deploy:staging`.
   Configure the custom domain on the authorized Cloudflare account if prompted.
4. Check `/health`, then use an Electron development build configured for staging and the
   iPad simulator to sign in, cancel, update access and refresh. Use only the test workspace.
   Sign into the same test workspace on both clients, then refresh each to verify
   coexistence with Notion. Verify callback ownership and native token storage; broker mocks
   cannot establish that system-browser behavior.

For local work use `npm run dev:staging` and ignored `.dev.vars.staging` containing only
local test credentials. Local mocks need no real credentials and make no Notion calls.
A real Notion OAuth round trip requires the registered, reachable HTTPS callback above.

## Production promotion

Run `npm run ci:local`; it checks generated types, typechecks, tests, and dry-runs both
production and staging bundles. After staging succeeds, explicitly run `npm run deploy`
with the existing production account/credentials. Keep the existing production Notion
integration, HTTPS redirect and localhost allowlist; add iPad without changing them.
Smoke-test the published Electron protocol and the iPad release candidate. Record the
Worker version and rollback version in the release record. Use Wrangler rollback to the
previous known-good deployment if needed; preserve the existing `OAuthState` class and
`v1` SQLite migration. A rollback to pre-iPad code preserves desktop service but does not
provide iPad PKCE authentication, so iPad must remain unreleased until acceptance passes.

Do not deploy iPad experiments to production merely to test them. These repository changes
prepare both environments; they do not deploy a Worker, provision secrets, change Notion
integration settings, or establish live end-to-end acceptance.
