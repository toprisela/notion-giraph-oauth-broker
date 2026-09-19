import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { OAuthState } from "../src/index";

type BrokerEnv = Env;

interface StoredItemRow {
  [key: string]: SqlStorageValue;
  key: string;
  expires_at: number;
}

interface StoredValueRow {
  [key: string]: SqlStorageValue;
  value: string;
}

const IPAD_RETURN_URI = "com.connectyourcharger.giraph.ipad:/oauth/callback";
const APP_STATE = "s".repeat(43);

function base64Url(data: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(data)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

async function pkceChallenge(verifier: string): Promise<string> {
  return base64Url(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
}

function stubFor(name: string): DurableObjectStub<OAuthState> {
  return (env as unknown as BrokerEnv).OAUTH_STATE.getByName(name);
}

describe("OAuthState expiry cleanup", () => {
  it("schedules an alarm when an OAuth attempt is stored", async () => {
    const stub = stubFor("schedules-attempt-cleanup");
    const before = Date.now();

    const response = await stub.fetch(
      "https://broker.test/oauth/notion/start",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          appReturnUri: "http://localhost:41987/callback",
        }),
      },
    );

    expect(response.status).toBe(200);
    const { alarm, rows } = await runInDurableObject(
      stub,
      async (_instance, state) => ({
        alarm: await state.storage.getAlarm(),
        rows: state.storage.sql
          .exec<StoredItemRow>("SELECT key, expires_at FROM oauth_items")
          .toArray(),
      }),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.key.startsWith("state:")).toBe(true);
    expect(alarm).not.toBeNull();
    expect(alarm as number).toBeGreaterThanOrEqual(before + 599_000);
    expect(alarm as number).toBeLessThanOrEqual(before + 601_000);
  });

  it("deletes expired rows on alarm and reschedules for the next expiry", async () => {
    const stub = stubFor("alarm-removes-expired-rows");
    const now = Date.now();
    const futureExpiry = now + 60_000;

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO oauth_items (key, value, expires_at) VALUES (?, ?, ?)",
        "expired",
        "{}",
        now - 1,
      );
      state.storage.sql.exec(
        "INSERT INTO oauth_items (key, value, expires_at) VALUES (?, ?, ?)",
        "future",
        "{}",
        futureExpiry,
      );
      await state.storage.setAlarm(now + 1_000);
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const { alarm, rows } = await runInDurableObject(
      stub,
      async (_instance, state) => ({
        alarm: await state.storage.getAlarm(),
        rows: state.storage.sql
          .exec<StoredItemRow>(
            "SELECT key, expires_at FROM oauth_items ORDER BY key",
          )
          .toArray(),
      }),
    );

    expect(rows.map((row) => row.key)).toEqual(["future"]);
    expect(alarm).toBe(futureExpiry);
  });

  it("adopts a pre-existing ticket that does not yet have an alarm", async () => {
    const stub = stubFor("adopts-ticket-without-alarm");
    const ticket = "legacy-ticket";
    const expiresAt = Date.now() + 60_000;

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO oauth_items (key, value, expires_at) VALUES (?, ?, ?)",
        `ticket:${ticket}`,
        JSON.stringify({
          attemptId: "expected-attempt",
          tokenResponse: {},
          expiresAt,
        }),
        expiresAt,
      );
    });

    const response = await stub.fetch(
      "https://broker.test/oauth/notion/complete",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticket, attemptId: "wrong-attempt" }),
      },
    );

    expect(response.status).toBe(401);
    const alarm = await runInDurableObject(stub, async (_instance, state) =>
      state.storage.getAlarm(),
    );
    expect(alarm).toBe(expiresAt);
  });

  it("cancels the alarm after a ticket is redeemed and storage is empty", async () => {
    const stub = stubFor("redeem-cancels-empty-alarm");
    const ticket = "test-ticket";
    const attemptId = "test-attempt";
    const expiresAt = Date.now() + 60_000;

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO oauth_items (key, value, expires_at) VALUES (?, ?, ?)",
        `ticket:${ticket}`,
        JSON.stringify({
          attemptId,
          tokenResponse: { accessToken: "test" },
          expiresAt,
        }),
        expiresAt,
      );
      await state.storage.setAlarm(expiresAt);
    });

    const response = await stub.fetch(
      "https://broker.test/oauth/notion/complete",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticket, attemptId }),
      },
    );

    expect(response.status).toBe(200);
    const { alarm, rowCount } = await runInDurableObject(
      stub,
      async (_instance, state) => ({
        alarm: await state.storage.getAlarm(),
        rowCount: state.storage.sql
          .exec("SELECT key FROM oauth_items")
          .toArray().length,
      }),
    );

    expect(rowCount).toBe(0);
    expect(alarm).toBeNull();
  });

  it("removes an abandoned ticket when its alarm fires", async () => {
    const stub = stubFor("alarm-removes-abandoned-ticket");
    const ticket = "abandoned-ticket";
    const expiresAt = Date.now() - 1;

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO oauth_items (key, value, expires_at) VALUES (?, ?, ?)",
        `ticket:${ticket}`,
        JSON.stringify({
          attemptId: "abandoned-attempt",
          tokenResponse: {},
          expiresAt,
        }),
        expiresAt,
      );
      await state.storage.setAlarm(Date.now());
    });

    await runDurableObjectAlarm(stub);

    const { alarm, rowCount } = await runInDurableObject(
      stub,
      async (_instance, state) => ({
        alarm: await state.storage.getAlarm(),
        rowCount: state.storage.sql
          .exec("SELECT key FROM oauth_items")
          .toArray().length,
      }),
    );

    expect(rowCount).toBe(0);
    expect(alarm).toBeNull();
  });
});

describe("OAuthState platform-bound PKCE", () => {
  it("keeps the legacy desktop start protocol compatible", async () => {
    const response = await stubFor("legacy-desktop-start").fetch(
      "https://broker.test/oauth/notion/start",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          appReturnUri: "http://localhost:41987/callback",
        }),
      },
    );

    expect(response.status).toBe(200);
  });

  it("requires an exact allowlisted iPad return URI and S256 challenge", async () => {
    const stub = stubFor("ipad-start-validation");
    const verifier = "a".repeat(64);
    const challenge = await pkceChallenge(verifier);

    const cases = [
      { platform: "ipad", appReturnUri: IPAD_RETURN_URI },
      {
        platform: "ipad",
        appReturnUri: `${IPAD_RETURN_URI}/unexpected`,
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
        appState: APP_STATE,
      },
      {
        platform: "ipad",
        appReturnUri: IPAD_RETURN_URI,
        codeChallenge: challenge,
        codeChallengeMethod: "plain",
        appState: APP_STATE,
      },
    ];

    for (const body of cases) {
      const response = await stub.fetch(
        "https://broker.test/oauth/notion/start",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      expect(response.status).toBe(400);
    }

    const accepted = await stub.fetch(
      "https://broker.test/oauth/notion/start",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          platform: "ipad",
          appReturnUri: IPAD_RETURN_URI,
          codeChallenge: challenge,
          codeChallengeMethod: "S256",
          appState: APP_STATE,
        }),
      },
    );

    expect(accepted.status).toBe(200);
    const stored = await runInDurableObject(stub, async (_instance, state) =>
      state.storage.sql
        .exec<StoredValueRow>("SELECT value FROM oauth_items")
        .toArray(),
    );
    expect(stored).toHaveLength(1);
    expect(JSON.parse(stored[0]!.value)).toMatchObject({
      platform: "ipad",
      appReturnUri: IPAD_RETURN_URI,
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      appState: APP_STATE,
    });
  });

  it("does not consume an iPad ticket for a wrong platform or verifier", async () => {
    const stub = stubFor("ipad-wrong-binding");
    const verifier = "b".repeat(64);
    const challenge = await pkceChallenge(verifier);
    const ticket = "platform-bound-ticket";
    const attemptId = "platform-bound-attempt";
    const expiresAt = Date.now() + 60_000;

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO oauth_items (key, value, expires_at) VALUES (?, ?, ?)",
        `ticket:${ticket}`,
        JSON.stringify({
          attemptId,
          platform: "ipad",
          codeChallenge: challenge,
          codeChallengeMethod: "S256",
          appState: APP_STATE,
          tokenResponse: { accessToken: "test" },
          expiresAt,
        }),
        expiresAt,
      );
    });

    for (const body of [
      {
        ticket,
        attemptId,
        platform: "desktop",
        codeVerifier: verifier,
        appState: APP_STATE,
      },
      {
        ticket,
        attemptId,
        platform: "ipad",
        codeVerifier: "c".repeat(64),
        appState: APP_STATE,
      },
      {
        ticket,
        attemptId,
        platform: "ipad",
        codeVerifier: verifier,
        appState: "x".repeat(43),
      },
    ]) {
      const response = await stub.fetch(
        "https://broker.test/oauth/notion/complete",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      expect(response.status).toBe(401);
    }

    const remaining = await runInDurableObject(stub, async (_instance, state) =>
      state.storage.sql
        .exec("SELECT key FROM oauth_items WHERE key = ?", `ticket:${ticket}`)
        .toArray(),
    );
    expect(remaining).toHaveLength(1);
  });

  it("redeems an iPad ticket exactly once under concurrent requests", async () => {
    const stub = stubFor("ipad-atomic-redemption");
    const verifier = "d".repeat(64);
    const challenge = await pkceChallenge(verifier);
    const ticket = "one-time-ticket";
    const attemptId = "one-time-attempt";
    const expiresAt = Date.now() + 60_000;

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO oauth_items (key, value, expires_at) VALUES (?, ?, ?)",
        `ticket:${ticket}`,
        JSON.stringify({
          attemptId,
          platform: "ipad",
          codeChallenge: challenge,
          codeChallengeMethod: "S256",
          appState: APP_STATE,
          tokenResponse: { accessToken: "test" },
          expiresAt,
        }),
        expiresAt,
      );
    });

    const request = () =>
      stub.fetch("https://broker.test/oauth/notion/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ticket,
          attemptId,
          platform: "ipad",
          codeVerifier: verifier,
          appState: APP_STATE,
        }),
      });

    const responses = await Promise.all([request(), request()]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 401,
    ]);
    expect((await request()).status).toBe(401);
  });
});
