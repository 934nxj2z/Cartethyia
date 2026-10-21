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

  test("CN and intl clients are distinct instances", () => {
    // A CN login exchange runs on the CN host; the same client bound to intl
    // would post it somewhere that refuses it.
    expect(traeOAuthClient).not.toBe(traeCnOAuthClient);
    expect(traeCnOAuthClient.supportsBrowserCode).toBe(true);
  });
});

describe("Trae credential import", () => {
  // Trae has no device-code or browser authorize flow — the donor's
  // `start_login` answers `unsupported` and directs the operator to a Desktop
  // import or a pasted refresh token. A Trae PAT *is* a refresh token.
  test("a bare token is exchanged rather than stored as an access token", async () => {
    const { fetchFn, calls } = stubFetch(() => ({ payload: OK_PAYLOAD }));
    const result = await new TraeOAuthClient(fetchFn, "cn").importCredential({
      credential: "pat-or-refresh",
      fields: {},
    });
    expect(calls[0]?.body["RefreshToken"]).toBe("pat-or-refresh");
    expect(result.access).toBe("at-new");
    expect(result.refresh).toBe("rt-new");
  });

  test("importing proves the credential is live before it is stored", async () => {
    const { fetchFn } = stubFetch(() => ({ payload: { Code: "invalid_grant", Message: "expired" } }));
    expect(
      new TraeOAuthClient(fetchFn, "cn").importCredential({ credential: "dead-pat", fields: {} }),
    ).rejects.toThrow(/invalid_grant/);
  });

  test("a full export with expiry is stored without spending the rotation", async () => {
    const { fetchFn, calls } = stubFetch(() => ({ payload: OK_PAYLOAD }));
    const result = await new TraeOAuthClient(fetchFn, "cn").importCredential({
      credential: JSON.stringify({
        accessToken: "at-existing",
        refreshToken: "rt-existing",
        expiredAt: 1_800_000_000_000,
        email: "ops@example.com",
      }),
      fields: {},
    });
    // The stored access token is still valid, so exchanging it would rotate
    // the refresh token for nothing.
    expect(calls.length).toBe(0);
    expect(result.access).toBe("at-existing");
    expect(result.refresh).toBe("rt-existing");
    expect(result.accountLabel).toBe("ops@example.com");
    expect(result.expiresAt.getTime()).toBe(1_800_000_000_000);
  });

  test("an export with no refresh token is marked static", async () => {
    const { fetchFn } = stubFetch(() => ({ payload: OK_PAYLOAD }));
    const result = await new TraeOAuthClient(fetchFn, "cn").importCredential({
      credential: JSON.stringify({ accessToken: "at-only", expiredAt: 1_800_000_000_000 }),
      fields: {},
    });
    expect(result.auth_state?.["staticToken"]).toBe(true);
  });

  test("an empty paste is refused with a usable message", async () => {
    const { fetchFn } = stubFetch(() => ({ payload: OK_PAYLOAD }));
    expect(
      new TraeOAuthClient(fetchFn, "cn").importCredential({ credential: "   ", fields: {} }),
    ).rejects.toThrow(/Paste a Trae account export/);
  });

  test("a malformed JSON paste is refused", async () => {
    const { fetchFn } = stubFetch(() => ({ payload: OK_PAYLOAD }));
    expect(
      new TraeOAuthClient(fetchFn, "cn").importCredential({ credential: "{not json", fields: {} }),
    ).rejects.toThrow(/Paste a Trae account export/);
  });
});

/** A fetch stub that answers the three Trae OAuth endpoints from a local table. */
function oauthStub(handler: (path: string) => { status?: number; payload?: unknown }) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ path: url.pathname, body });
    const { status = 200, payload } = handler(url.pathname);
    return new Response(JSON.stringify(payload ?? {}), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const GUIDANCE = (path: string) =>
  path.includes("GetLoginGuidance") ? { payload: { Result: { LoginHost: "www.trae.ai" } } } : { status: 404 };
const EXCHANGE = (path: string) =>
  path.includes("ExchangeToken")
    ? { payload: { Result: { Token: "at-fresh", RefreshToken: "rt-rotated", TokenExpireAt: 1_893_456_000_000 } } }
    : { status: 404 };

describe("Trae browser authorization", () => {
  test("Trae has a browser login and no device flow", () => {
    // The donor's start_login answers `unsupported` for device authorization,
    // but GetLoginGuidance + /authorization is a real browser flow. Declaring
    // only the browser half is what stops the console offering a dead device
    // login.
    expect(traeOAuthClient.supportsBrowserCode).toBe(true);
    expect(traeOAuthClient.supportsDeviceCode).toBe(false);
  });

  test("prepareAuthorize resolves the login host", async () => {
    // The host is an upstream discovery, not a constant: pinning the one seen
    // today breaks the day upstream moves it.
    const { fetchFn, calls } = oauthStub(GUIDANCE);
    const client = new TraeOAuthClient(fetchFn, "intl");
    const prepared = await client.prepareAuthorize({
      state: "trace-1",
      codeChallenge: "x",
      redirectUri: "http://127.0.0.1:1455/callback",
    });
    expect(prepared.parameters?.["loginHost"]).toBe("www.trae.ai");
    expect(calls[0]?.path).toContain("GetLoginGuidance");
  });

  test("the authorize URL carries a UUID trace id and the callback", async () => {
    const { fetchFn } = oauthStub(GUIDANCE);
    const client = new TraeOAuthClient(fetchFn, "intl");
    const prepared = await client.prepareAuthorize({
      state: "trace-abc",
      codeChallenge: "x",
      redirectUri: "http://127.0.0.1:1455/callback",
    });
    const url = new URL(client.buildAuthorizeUrl(prepared));
    expect(url.pathname).toBe("/authorization");
    // Upstream validates this field as a UUID; the console's flow state is
    // base64url and is refused, so the trace id is minted separately.
    expect(url.searchParams.get("login_trace_id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(url.searchParams.get("auth_callback_url")).toBe("http://127.0.0.1:1455/callback");
    expect(url.searchParams.get("client_id")).toBe("ono9krqynydwx5");
  });

  test("the callback path is the one the login page accepts", async () => {
    // Verified against the live page: it renders the login form only when
    // `auth_callback_url` ends in `/authorize`. `/callback` — the gateway
    // default — is answered with "Login Failed" before the operator can sign
    // in, which is what made every Trae login fail at the first click.
    const { fetchFn } = oauthStub(GUIDANCE);
    const client = new TraeOAuthClient(fetchFn, "intl");
    expect(new URL(client.browserRedirectUri).pathname).toBe("/authorize");
  });

  test("the authorize URL carries the parameters a real client sends", async () => {
    // Every one of these was missing or wrong when the login page rejected the
    // flow: PKCE is required to get a refresh token back, and the device fields
    // are the fingerprint the login is correlated with.
    const { fetchFn } = oauthStub(GUIDANCE);
    const client = new TraeOAuthClient(fetchFn, "intl");
    const prepared = await client.prepareAuthorize({
      state: "trace-abc",
      codeChallenge: "challenge-1",
      redirectUri: "http://127.0.0.1:1455/callback",
    });
    const url = new URL(client.buildAuthorizeUrl(prepared));
    const param = (key: string) => url.searchParams.get(key);
    // PKCE is deliberately absent: it selects the page's `AuthCode` flow, and
    // that code is not redeemable into a token pair.
    expect(param("code_challenge")).toBeNull();
    expect(param("code_challenge_method")).toBeNull();
    expect(param("channel_name")).toBe("common");
    expect(param("plugin_version")).toBe("2.3.93439");
    expect(param("x_device_type")).toBe("windows");
    expect(param("machine_id")).toMatch(/^[0-9a-f]{64}$/);
    expect(param("device_id")).toMatch(/^\d{19}$/);
    expect(param("device_id")).toBe(param("x_device_id"));
    expect(param("machine_id")).toBe(param("x_machine_id"));
  });

  test("building the URL before resolving the host fails loudly", () => {
    // Silently building against an empty host would send the operator to a
    // page that cannot sign them in.
    const { fetchFn } = oauthStub(GUIDANCE);
    const client = new TraeOAuthClient(fetchFn, "intl");
    expect(() =>
      client.buildAuthorizeUrl({ state: "s", redirectUri: "http://127.0.0.1:1455/callback" }),
    ).toThrow(/not resolved/);
  });

  test("exchangeCode redeems the pasted callback for a token pair", async () => {
    // Trae's callback carries the refresh token directly, not a code.
    const { fetchFn, calls } = oauthStub((path) =>
      path.includes("ExchangeToken")
        ? EXCHANGE(path)
        : path.includes("GetUserInfo")
          ? { payload: { Result: { NonPlainTextEmail: "ops@example.com", UserID: "u-99" } } }
          : { status: 404 },
    );
    const client = new TraeOAuthClient(fetchFn, "intl");
    const result = await client.exchangeCode(
      "http://127.0.0.1:1455/callback?isRedirect=true&refreshToken=rt-from-callback&loginHost=www.trae.ai",
      "",
      "http://127.0.0.1:1455/callback",
    );
    expect(result.access).toBe("at-fresh");
    // The exchange rotates the refresh token, so the new one must be stored.
    expect(result.refresh).toBe("rt-rotated");
    expect(result.accountLabel).toBe("ops@example.com");
    expect(result.auth_state).toEqual({ userId: "u-99" });
    const exchange = calls.find((c) => c.path.includes("ExchangeToken"));
    expect(exchange?.body["RefreshToken"]).toBe("rt-from-callback");
  });

  test("a bare query string is accepted as well as a full URL", async () => {
    const { fetchFn, calls } = oauthStub(EXCHANGE);
    const client = new TraeOAuthClient(fetchFn, "intl");
    await client.exchangeCode("?refreshToken=rt-bare", "", "http://127.0.0.1:1455/callback");
    const exchange = calls.find((c) => c.path.includes("ExchangeToken"));
    expect(exchange?.body["RefreshToken"]).toBe("rt-bare");
  });

  test("the PKCE callback is redeemed against the verifier", async () => {
    // The live page redirects with `authCodeInfo` — a PKCE code, not a refresh
    // token. It is redeemed at the *public* exchange endpoint, which is the
    // only one that accepts `AuthCode`; the authenticated one answers
    // "Invalid param".
    const callback =
      "?isRedirect=true&scope=trae&authCodeInfo=%7B%22AuthCode%22%3A%22ac-1%22%7D" +
      "&loginTraceID=trace-1&host=https%3A%2F%2Fapi-sg-central.trae.ai&userRegion=sg";
    const { fetchFn, calls } = oauthStub((path) =>
      path.includes("public/oauth/ExchangeToken")
        ? { payload: { Result: { Token: "at-1", RefreshToken: "rt-1", TokenExpireAt: 1_800_000_000_000 } } }
        : path.includes("GetUserInfo")
          ? { payload: { Result: { NonPlainTextEmail: "ops@example.com", UserID: "u-1" } } }
          : { status: 404, payload: {} },
    );
    const client = new TraeOAuthClient(fetchFn, "intl");
    const result = await client.exchangeCode(callback, "verifier-1", "http://127.0.0.1:59653/authorize");
    expect(result.access).toBe("at-1");
    expect(result.refresh).toBe("rt-1");
    const exchange = calls.find((c) => c.path.includes("public/oauth/ExchangeToken"));
    expect(exchange?.body["AuthCode"]).toBe("ac-1");
    expect(exchange?.body["CodeVerifier"]).toBe("verifier-1");
  });

  test("a callback with no refresh token is a clear error", async () => {
    const { fetchFn } = oauthStub(EXCHANGE);
    const client = new TraeOAuthClient(fetchFn, "intl");
    expect(client.exchangeCode("?isRedirect=true", "", "http://127.0.0.1:1455/callback")).rejects.toThrow(
      /neither a refreshToken nor an AuthCode/,
    );
  });

  test("an upstream error in the callback is reported", async () => {
    const { fetchFn } = oauthStub(EXCHANGE);
    const client = new TraeOAuthClient(fetchFn, "intl");
    expect(
      client.exchangeCode("?error=access_denied&error_description=user+cancelled", "", "http://x/callback"),
    ).rejects.toThrow(/access_denied.*user cancelled/);
  });

  test("a missing identity still completes the login", async () => {
    // The account is usable without an email; only the token pair is required.
    const { fetchFn } = oauthStub((path) => (path.includes("ExchangeToken") ? EXCHANGE(path) : { status: 404 }));
    const client = new TraeOAuthClient(fetchFn, "intl");
    const result = await client.exchangeCode("?refreshToken=rt", "", "http://x/callback");
    expect(result.access).toBe("at-fresh");
    expect(result.accountLabel).toBeUndefined();
  });
});
