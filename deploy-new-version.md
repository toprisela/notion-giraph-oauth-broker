# Deploying a new broker version

Run all commands from the `notion-giraph-oauth-broker` repository root.

## Deploy changes to staging

```sh
npm ci --include=dev --include=optional
npm run ci:local
npm run deploy:staging
curl --fail https://auth-staging.connectyourcharger.com/health
```

Stop if a command fails. After deployment, complete a real Notion sign-in using the
staging integration and test workspace.

## Deploy changes to production

Deploy only after the same changes have been verified on staging:

```sh
npm run ci:local
npm run deploy
curl --fail https://auth.connectyourcharger.com/health
```

After deployment, verify a real Notion sign-in in the production app.

## Replace the Notion client ID and client secret

If you created a new Notion integration, open
[Notion integrations](https://www.notion.so/my-integrations), select it, and add the
appropriate URL under **Distribution → OAuth Domain & URIs → Redirect URIs**:

- Staging: `https://auth-staging.connectyourcharger.com/oauth/notion/callback`
- Production: `https://auth.connectyourcharger.com/oauth/notion/callback`

If you are rotating credentials for the existing integration, its redirect URL is
already configured and does not need to be changed.

Set both secrets for the environment being changed. Enter each value only when
Wrangler prompts for it.

Staging:

```sh
npx wrangler secret put NOTION_CLIENT_ID --env staging
npx wrangler secret put NOTION_CLIENT_SECRET --env staging
```

Production:

```sh
npx wrangler secret put NOTION_CLIENT_ID --env=""
npx wrangler secret put NOTION_CLIENT_SECRET --env=""
```

You do not need to run `npm run deploy` afterward. Each `wrangler secret put`
command creates and deploys a new Worker version. Run both commands one after the
other, then test a real sign-in.

Existing sessions may need to reconnect when credentials belong to a different
integration. Never store these values in Git, application environment files, or
command arguments.
