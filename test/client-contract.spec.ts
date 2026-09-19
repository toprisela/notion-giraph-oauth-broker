import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

const ipadReturn = "com.connectyourcharger.giraph.ipad:/oauth/callback";
const desktopReturn = "http://localhost:41987/callback";
const verifier = "a".repeat(64);
const appState = "s".repeat(43);
const tokenData = {
  access_token: "fixture-access",
  refresh_token: "fixture-refresh",
  bot_id: "bot",
  workspace_id: "workspace",
  workspace_name: "Workspace",
  expires_in: 3600,
  owner: {
    type: "user",
    user: { id: "user", name: "Tester", avatar_url: null },
  },
};
async function challenge() {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
function post(path: string, body: Record<string, unknown>) {
  return SELF.fetch(`https://broker.test/oauth/notion/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
async function start(platform?: string) {
  const response = await post("start", {
    ...(platform === undefined ? {} : { platform }),
    appReturnUri: platform === "ipad" ? ipadReturn : desktopReturn,
    ...(platform === "ipad"
      ? {
          codeChallenge: await challenge(),
          codeChallengeMethod: "S256",
          appState,
        }
      : {}),
  });
  expect(response.status).toBe(200);
  const result = await response.json<{
    authorizeUrl: string;
    attemptId: string;
    expiresAt: string;
  }>();
  expect(Date.parse(result.expiresAt)).toBeGreaterThan(Date.now());
  const authorize = new URL(result.authorizeUrl);
  expect(authorize.origin).toBe("https://api.notion.com");
  expect(authorize.searchParams.get("redirect_uri")).toBe(
    env.NOTION_REDIRECT_URI,
  );
  return { ...result, state: authorize.searchParams.get("state")! };
}
function mockNotion(data: unknown = tokenData, status = 200) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      expect(String(input)).toBe("https://api.notion.com/v1/oauth/token");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Basic ${btoa("test-client:test-secret")}`,
      );
      // Validate options in the real Workers runtime even though network I/O is mocked.
      const request = new Request(input, init);
      expect(request.redirect).toBe("manual");
      return Response.json(data, { status });
    });
}
afterEach(() => vi.restoreAllMocks());

describe("actual desktop and iPad wire contracts", () => {
  it.each(["electron", "desktop", undefined, "ipad"])(
    "completes login and refresh for %s",
    async (platform) => {
      const upstream = mockNotion();
      const attempt = await start(platform);
      const callback = await SELF.fetch(
        `https://broker.test/oauth/notion/callback?state=${attempt.state}&code=fixture-code`,
        { redirect: "manual" },
      );
      expect(callback.status).toBe(302);
      const target = new URL(callback.headers.get("location")!);
      expect(target.toString().split("?")[0]).toBe(
        platform === "ipad" ? ipadReturn : desktopReturn,
      );
      expect([...target.searchParams.keys()].sort()).toEqual([
        ...(platform === "ipad" ? ["app_state"] : []),
        "attempt_id",
        "ticket",
      ]);
      expect(target.searchParams.get("attempt_id")).toBe(attempt.attemptId);
      if (platform === "ipad") {
        expect(target.searchParams.get("app_state")).toBe(appState);
      }
      expect(target.toString()).not.toContain("fixture-access");
      const complete = {
        platform,
        ticket: target.searchParams.get("ticket"),
        attemptId: attempt.attemptId,
        ...(platform === "ipad" ? { codeVerifier: verifier } : {}),
        ...(platform === "ipad" ? { appState } : {}),
      };
      // Wrong-platform attempts must leave the legitimate ticket usable.
      expect(
        (
          await post("complete", {
            ...complete,
            platform: platform === "ipad" ? "electron" : "ipad",
          })
        ).status,
      ).toBe(401);
      const redeemed = await post("complete", complete);
      expect(redeemed.status).toBe(200);
      expect(redeemed.headers.get("cache-control")).toBe("no-store");
      expect(await redeemed.json()).toMatchObject({
        accessToken: "fixture-access",
        refreshToken: "fixture-refresh",
        owner: tokenData.owner,
      });
      expect((await post("complete", complete)).status).toBe(401);
      expect(
        (
          await SELF.fetch(
            `https://broker.test/oauth/notion/callback?state=${attempt.state}&code=fixture-code`,
          )
        ).status,
      ).toBe(400);
      expect(upstream).toHaveBeenCalledTimes(1);
      const refresh = await post("refresh", {
        refreshToken: "fixture-refresh",
      });
      expect(refresh.status).toBe(200);
      expect(await refresh.json()).toMatchObject({
        accessToken: "fixture-access",
        refreshToken: "fixture-refresh",
      });
      expect(JSON.parse(String(upstream.mock.calls[1]?.[1]?.body))).toEqual({
        grant_type: "refresh_token",
        refresh_token: "fixture-refresh",
      });
    },
  );

  it.each(["electron", "ipad"])(
    "returns cancellation without redeemable data for %s",
    async (platform) => {
      const upstream = mockNotion();
      const attempt = await start(platform);
      const url = `https://broker.test/oauth/notion/callback?state=${attempt.state}&error=access_denied`;
      const response = await SELF.fetch(url, { redirect: "manual" });
      expect(response.status).toBe(302);
      const target = new URL(response.headers.get("location")!);
      expect([...target.searchParams.keys()].sort()).toEqual([
        ...(platform === "ipad" ? ["app_state"] : []),
        "attempt_id",
        "error",
      ]);
      expect(target.searchParams.get("attempt_id")).toBe(attempt.attemptId);
      if (platform === "ipad") {
        expect(target.searchParams.get("app_state")).toBe(appState);
      }
      expect(target.searchParams.get("error")).toBe("access_denied");
      expect((await SELF.fetch(url)).status).toBe(400);
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it("rejects unknown platforms, retired callback and cross-platform return URIs", async () => {
    for (const platform of ["android", "Electron", null, 42]) {
      expect(
        (await post("start", { platform, appReturnUri: desktopReturn })).status,
      ).toBe(400);
    }
    for (const [platform, appReturnUri] of [
      ["ipad", desktopReturn],
      ["electron", ipadReturn],
      ["ipad", "com.connectyourcharger.giraph:/oauth/callback"],
    ]) {
      expect(
        (
          await post("start", {
            platform,
            appReturnUri,
            codeChallenge: await challenge(),
            codeChallengeMethod: "S256",
          })
        ).status,
      ).toBe(400);
    }
  });

  it.each([
    [401, "invalid_client", 502],
    [401, "invalid_grant", 401],
    [400, "invalid_grant", 401],
    [400, "invalid_request", 502],
    [429, "rate_limited", 502],
    [500, "internal_error", 502],
  ] as const)(
    "maps refresh upstream %s/%s to %s",
    async (status, error, expected) => {
      mockNotion({ error }, status);
      const response = await post("refresh", {
        refreshToken: "fixture-refresh",
      });
      expect(response.status).toBe(expected);
      expect(await response.json()).toEqual({
        error:
          expected === 401 ? "invalid_refresh_token" : "notion_refresh_failed",
      });
    },
  );

  it("does not publish malformed successful token responses", async () => {
    mockNotion({ error: "unexpected" });
    const attempt = await start("ipad");
    const response = await SELF.fetch(
      `https://broker.test/oauth/notion/callback?state=${attempt.state}&code=fixture-code`,
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    expect(
      (await post("refresh", { refreshToken: "fixture-refresh" })).status,
    ).toBe(502);
  });

  it("maps upstream transport failures to recoverable errors", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("transport unavailable"),
    );
    expect(
      (await post("refresh", { refreshToken: "fixture-refresh" })).status,
    ).toBe(502);
  });
});

describe("upstream redirect protection", () => {
  it.each([301, 302, 303, 307, 308])(
    "rejects a %s token response without following it",
    async (status) => {
      const upstream = mockNotion({}, status);
      const attempt = await start("electron");
      const callback = await SELF.fetch(
        `https://broker.test/oauth/notion/callback?state=${attempt.state}&code=fixture-code`,
        { redirect: "manual" },
      );
      expect(callback.status).toBe(400);
      expect(await callback.text()).toContain("Token exchange failed");
      expect(callback.headers.get("location")).toBeNull();
      const refresh = await post("refresh", {
        refreshToken: "fixture-refresh",
      });
      expect(refresh.status).toBe(502);
      expect(upstream).toHaveBeenCalledTimes(2);
    },
  );
});
