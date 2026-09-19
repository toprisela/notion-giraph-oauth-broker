# Deploying the OAuth broker

One production broker serves both Electron and iPad. Staging is a separate copy for
trying changes without affecting customers. Both are defined in `wrangler.jsonc`.
At the time this guide was added, only production was deployed; staging still needs
the one-time setup below.

| Environment | URL | Deploy command |
| --- | --- | --- |
| Staging | `https://auth-staging.connectyourcharger.com` | `npm run deploy:staging` |
| Production | `https://auth.connectyourcharger.com` | `npm run deploy` |

Run broker commands from the `notion-giraph-oauth-broker` repository root, using Node
22.22.1 and npm 10.9.4.

## 1. Set up staging once

1. Install dependencies and sign into the Cloudflare account that owns the existing
   broker and `connectyourcharger.com`:

   ```sh
   npm ci --include=dev --include=optional
   npx wrangler login
   npx wrangler whoami
   ```

2. Create a separate **public Notion OAuth integration** for staging and use a test
   workspace. Register this exact redirect URL:

   ```text
   https://auth-staging.connectyourcharger.com/oauth/notion/callback
   ```

3. Store that integration's credentials in staging. Enter each value at the prompt;
   never put it in Git or in either app:

   ```sh
   npx wrangler secret put NOTION_CLIENT_ID --env staging
   npx wrangler secret put NOTION_CLIENT_SECRET --env staging
   ```

   If Wrangler asks to create `giraph-oauth-broker-staging`, accept. Staging has its
   own secrets and OAuth state; it does not inherit production credentials.

4. Deploy staging using the next section. The configured custom-domain route connects
   `auth-staging.connectyourcharger.com` to the staging Worker.

## 2. Deploy a new staging version

```sh
npm run ci:local
npm run deploy:staging
curl --fail https://auth-staging.connectyourcharger.com/health
```

Stop if any command fails. CI tests the broker and dry-runs both deployment targets;
it does not publish either one. After deployment, test the apps as described below.
A successful health check alone does not verify Notion authentication.

If CI reports `Cannot find native binding` or a missing `@rolldown/binding-*`
module, check that `node --version` is `v22.22.1`, then reinstall the locked
packages with their native optional dependencies and retry:

```sh
npm ci --include=dev --include=optional
npm run ci:local
```

Keep `package-lock.json`; no WASM dependency needs to be added manually.

## 3. Use staging during app development

### Electron

The app repository includes public `.env.staging` settings and an `.envrc` loader.
If needed, install direnv with `brew install direnv` and add
`eval "$(direnv hook zsh)"` to `~/.zshrc`, then open a new terminal.

From the **`notion-giraph` app repository**:

```sh
direnv allow
npm run dev
```

Direnv loads staging when you enter this repository and restores your previous
environment when you leave. Quit any running development instance first. Disconnect
any existing Notion session, then sign into staging using the test workspace.
The env files contain public URLs only; never add Notion secrets to them.

Electron release builds reject staging URLs, including ones inherited from direnv.
To build production from this shell, explicitly override the URL:

```sh
GIRAPH_OAUTH_BROKER_BASE_URL=https://auth.connectyourcharger.com npm run build
```

Use the same prefix for `npm run release:mas:local` when following the app's signing
procedure. The app's `npm run ci:local` selects production for its build checks.
Installed production apps ignore runtime OAuth overrides. Broker deployment still
uses this broker repository's explicit Wrangler environment, not the app's env file.

### iPad simulator

The current native iPad app already selects `GiraphIdentity.stagingBrokerOrigin`
(`https://auth-staging.connectyourcharger.com`) in `GiraphNativePlugin.swift`.
No broker URL change is needed for current development builds.

From the **`notion-giraph` app repository**:

```sh
npm run build:ipad:web
npm run ipad:sync
npm run ipad:open
```

In Xcode, select the App scheme and an iPad simulator, then Run. Use the normal app
flow without automated-test fixtures. Disconnect any old session and sign in to the
staging integration. A browser-only `npm run dev:ipad` session does not exercise native
OAuth callbacks or Keychain storage.

### What to verify before production

- Sign in on both apps to the same test workspace and sync real Notion data.
- Cancel a new sign-in and confirm the app recovers; cancelling an access update
  must preserve the existing session.
- Update database access, disconnect, reconnect, and restart each app.
- Exercise token refresh on both apps and confirm each remains usable.

Use deployed staging for real OAuth round trips. `npm run dev:staging` runs a local
Worker; it does not make Notion's registered HTTPS callback point at your laptop.

## 4. Deploy a new production version

After staging acceptance, deploy the same tested code from the **broker repository**:

```sh
npm run ci:local
npm run deploy
curl --fail https://auth.connectyourcharger.com/health
```

This updates the existing production Worker. Keep its existing Notion integration,
credentials, and callback URL. Do not copy staging credentials into production.
Verify Electron sign-in after deploying, plus iPad when its production build is ready.

Production app builds must use `https://auth.connectyourcharger.com`. Electron's
release build must use that value for `GIRAPH_OAUTH_BROKER_BASE_URL`; packaged apps
ignore runtime overrides. The current iPad native composition still selects staging:
its production environment selection must be implemented before releasing iPad.
Deploying the broker does not switch an app's environment or publish either app.

For the OAuth protocol and security details, see [AUTHENTICATION.md](AUTHENTICATION.md).
