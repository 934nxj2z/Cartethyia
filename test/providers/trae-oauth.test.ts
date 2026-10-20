import { describe, expect, test } from "bun:test";
import { TraeOAuthClient, traeCnOAuthClient, traeOAuthClient } from "../../src/providers/integrations/trae/trae-oauth";
import { TRAE_EXCHANGE_TOKEN_PATH, TRAE_REALMS } from "../../src/providers/integrations/trae/trae-realm";

/** A fetch stub that records requests and answers with a queued response. */
function stubFetch(
  handler: (url: string, body: Record<string, unknown>) => { status?: number; payload?: unknown },
): { fetchFn: typeof fetch; calls: { url: string; body: Record<string, unknown> }[] } {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url, body });
    const { status = 200, payload } = handler(url, body);
    return new Response(JSON.stringify(payload ?? {}), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const OK_PAYLOAD = {
  Result: {
    Token: "at-new",
    RefreshToken: "rt-new",
    TokenExpireAt: 1_800_000_000_000,
    RefreshExpireAt: 1_900_000_000_000,
    UserJwt: "jwt-new",
  },
};

describe("Trae refresh", () => {
  test("posts to the realm's own account host", async () => {
    const { fetchFn, calls } = stubFetch(() => ({ payload: OK_PAYLOAD }));
    const client = new TraeOAuthClient(fetchFn, "cn");
    await client.refreshWithUser("rt-old", "user-1");
    expect(calls[0]?.url).toBe(`${TRAE_REALMS.cn.account}${TRAE_EXCHANGE_TOKEN_PATH}`);
  });

  test("intl uses a different host than CN", async () => {
    const { fetchFn, calls } = stubFetch(() => ({ payload: OK_PAYLOAD }));
    const client = new TraeOAuthClient(fetchFn, "intl");
    await client.refreshWithUser("rt-old", "user-1");
    expect(calls[0]?.url).toContain(TRAE_REALMS.intl.account);
    expect(calls[0]?.url).not.toContain(TRAE_REALMS.cn.account);
  });

  test("sends the client id, secret, and user id", async () => {
    const { fetchFn, calls } = stubFetch(() => ({ payload: OK_PAYLOAD }));
    await new TraeOAuthClient(fetchFn, "cn").refreshWithUser("rt-old", "user-1");
    expect(calls[0]?.body).toMatchObject({
      ClientID: "ono9krqynydwx5",
      ClientSecret: "-",
      RefreshToken: "rt-old",
      UserID: "user-1",
    });
  });

  test("returns the rotated refresh token", async () => {
    // Upstream invalidates the refresh token it was sent, so a refresh that
    // kept the old one would leave the account unrecoverable next expiry.
    const { fetchFn } = stubFetch(() => ({ payload: OK_PAYLOAD }));
    const result = await new TraeOAuthClient(fetchFn, "cn").refreshWithUser("rt-old", "user-1");
    expect(result.access).toBe("at-new");
    expect(result.refresh).toBe("rt-new");
  });

  test("reads expiry from TokenExpireAt milliseconds", async () => {
    const { fetchFn } = stubFetch(() => ({ payload: OK_PAYLOAD }));
    const result = await new TraeOAuthClient(fetchFn, "cn").refreshWithUser("rt-old", "user-1");
    expect(result.expiresAt.getTime()).toBe(1_800_000_000_000);
  });

  test("carries the user jwt forward as auth state", async () => {
    const { fetchFn } = stubFetch(() => ({ payload: OK_PAYLOAD }));
    const result = await new TraeOAuthClient(fetchFn, "cn").refreshWithUser("rt-old", "user-1");
    expect(result.auth_state).toEqual({ userJwt: "jwt-new" });
  });

  test("accepts a flat payload when Result is absent", async () => {
    const { fetchFn } = stubFetch(() => ({
      payload: { Token: "at-flat", RefreshToken: "rt-flat", TokenExpireAt: 1_800_000_000_000 },
    }));
    const result = await new TraeOAuthClient(fetchFn, "cn").refreshWithUser("rt-old", "u");
    expect(result.access).toBe("at-flat");
  });

  test("an upstream rejection surfaces its own reason", async () => {
    const { fetchFn } = stubFetch(() => ({
      payload: { Code: "invalid_grant", Message: "refresh token expired" },
    }));
    const attempt = new TraeOAuthClient(fetchFn, "cn").refreshWithUser("rt-old", "u");
    expect(attempt).rejects.toThrow(/invalid_grant.*refresh token expired/);
  });

  test("a business rejection is not replayed on the fallback host", async () => {
    // Each attempt rotates the refresh token, so retrying a rejection on
    // another host burns the rotation for nothing.
    const { fetchFn, calls } = stubFetch(() => ({
      payload: { Code: "invalid_grant", Message: "expired" },
    }));
    expect(new TraeOAuthClient(fetchFn, "intl").refreshWithUser("rt-old", "u")).rejects.toThrow();
    expect(calls.length).toBe(1);
  });

  test("an HTTP error is reported with its status", async () => {
    const { fetchFn } = stubFetch(() => ({ status: 401, payload: {} }));
    expect(new TraeOAuthClient(fetchFn, "cn").refreshWithUser("rt-old", "u")).rejects.toThrow(/HTTP 401/);
  });

  test("the OAuthTokenRefresher entry point takes the account id from context", async () => {
    const { fetchFn, calls } = stubFetch(() => ({ payload: OK_PAYLOAD }));
    const client = new TraeOAuthClient(fetchFn, "cn");
    const result = await client.refresh("rt-old", undefined, { account_id: "ctx-user" });
    expect(calls[0]?.body["UserID"]).toBe("ctx-user");
    expect(result.access).toBe("at-new");
  });

  test("no access token in the response is a failure, not an empty credential", async () => {
    const { fetchFn } = stubFetch(() => ({ payload: { Result: { RefreshToken: "only-refresh" } } }));
    expect(new TraeOAuthClient(fetchFn, "cn").refreshWithUser("rt-old", "u")).rejects.toThrow(/rejected/);
  });
});

describe("Trae OAuth clients", () => {
  test("the exported singletons are bound to different realms", () => {
    // A CN refresh posted to the intl host is refused, so the two cannot be
    // the same instance.
    expect(traeOAuthClient).not.toBe(traeCnOAuthClient);
  });

  test("Trae has no authorize flow in this client", () => {
    // Credentials arrive as a desktop export; there is no device-code or PKCE
    // endpoint to implement.
    expect(traeOAuthClient.supportsDeviceCode).toBe(false);
    expect(traeOAuthClient.supportsBrowserCode).toBe(false);
  });
});
