import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function readWranglerConfig() {
  const raw = await readFile(
    new URL("../wrangler.jsonc", import.meta.url),
    "utf8",
  );
  // This committed config intentionally uses JSONC trailing commas. Wrangler's
  // own dry-run remains the authoritative full syntax validation.
  return JSON.parse(raw.replace(/,\s*([}\]])/g, "$1"));
}

test("persistent Cloudflare observability logs are disabled", async () => {
  const config = await readWranglerConfig();

  assert.equal(config.observability?.enabled, false);
  assert.equal(config.observability?.logs?.enabled, false);
  assert.equal(config.observability?.logs?.invocation_logs, false);
  assert.equal(config.observability?.logs?.persist, false);
});

test("iPad OAuth return is an exact platform-specific allowlist entry", async () => {
  const config = await readWranglerConfig();

  assert.equal(
    config.vars?.ALLOWED_IPAD_RETURN_URIS,
    "com.connectyourcharger.giraph.ipad:/oauth/callback",
  );
  assert.deepEqual(config.secrets?.required, [
    "NOTION_CLIENT_ID",
    "NOTION_CLIENT_SECRET",
  ]);
});

test("staging uses a separate Worker, callback and local Durable Object binding", async () => {
  const config = await readWranglerConfig();
  const staging = config.env.staging;
  assert.notEqual(staging.name, config.name);
  assert.equal(
    staging.routes[0].pattern,
    "auth-staging.connectyourcharger.com",
  );
  assert.equal(
    staging.vars.NOTION_REDIRECT_URI,
    "https://auth-staging.connectyourcharger.com/oauth/notion/callback",
  );
  assert.equal(
    staging.vars.ALLOWED_RETURN_URIS,
    config.vars.ALLOWED_RETURN_URIS,
  );
  assert.equal(
    staging.vars.ALLOWED_IPAD_RETURN_URIS,
    config.vars.ALLOWED_IPAD_RETURN_URIS,
  );
  assert.deepEqual(staging.durable_objects.bindings, [
    { name: "OAUTH_STATE", class_name: "OAuthState" },
  ]);
  assert.deepEqual(staging.secrets.required, config.secrets.required);
});
