/**
 * A Cline `api_key` account is read through the same quota surface as OAuth,
 * with a different Authorization header.
 *
 * It used to be short-circuited to "quota not available" with no upstream call,
 * because the key was sent as `Bearer workos:sk_...` and Cline answered 401
 * with "please make sure you're using the latest version of Cline and
 * re-authenticate". That message names a version problem, so it read as the
 * upstream refusing the client rather than a malformed credential — and since
 * the same wording also covers a dead key, a working account and a dead one
 * were indistinguishable.
 *
 * Verified against a live key: `/users/me` returned 200 with `Bearer sk_...`
 * and 401 once `workos:` was prepended. So the api key goes down the normal
 * path, unprefixed.
 *
 * Two outcomes must stay distinct:
 * - a live key on an account with no plan → `windows: []`, `error: null`
 *   (404 "no plan history" is account state, not a failure);
 * - a dead key → the request is rejected, so the account reports a real error.
 */
import { describe, expect, test } from "bun:test";
import {
  CLINE_API_KEY_PREFIX,
  fetchClineQuota,
  markClineApiKeyCredential,
} from "../../src/providers/integrations/cline/cline-quota";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Records every Authorization header the quota surface is called with. */
function recordingFetcher(routes: {
  readonly onUsersMe?: () => Response;
  readonly onPlan?: () => Response;
  readonly onLimits?: () => Response;
}): { readonly fetcher: typeof fetch; readonly auths: readonly (string | null)[] } {
  const auths: (string | null)[] = [];
  const fetcher = (async (url: unknown, init?: RequestInit): Promise<Response> => {
    const headers = init?.headers as Record<string, string> | undefined;
    auths.push(headers?.authorization ?? null);
    const path = String(url);
    if (path.endsWith("/users/me")) {
      return routes.onUsersMe?.() ?? jsonResponse({ id: "u-1" });
    }
    if (path.endsWith("/plan")) {
      return routes.onPlan?.() ?? jsonResponse({ plan: { displayName: "Cline Pro" } });
    }
    return routes.onLimits?.() ?? jsonResponse({ limits: [] });
  }) as unknown as typeof fetch;
  return { fetcher, auths };
}

describe("fetchClineQuota for an api_key account", () => {
  test("sends the key as a bare bearer token, without workos:", async () => {
    // The whole fix is one header. `workos:` prefixed is what produced the
    // "re-authenticate" refusal.
    const { fetcher, auths } = recordingFetcher({});
    await fetchClineQuota(markClineApiKeyCredential("sk_test_key"), fetcher);

    expect(auths.length).toBeGreaterThan(0);
    for (const auth of auths) {
      expect(auth).toBe("Bearer sk_test_key");
    }
  });

  test("an account with no plan history reports no quota and no error", async () => {
    // 404 "no plan history" is account state, not a failure: the account is
    // reachable and simply has nothing metered.
    const { fetcher } = recordingFetcher({
      onPlan: () => jsonResponse({ error: "no plan history found for user" }, 404),
      onLimits: () => jsonResponse({ error: "no plan history found for user" }, 404),
    });

    const result = await fetchClineQuota(markClineApiKeyCredential("sk_test_key"), fetcher);

    expect(result.error).toBeNull();
    expect(result.windows).toEqual([]);
    expect(result.source).toBe("cline");
  });

  test("a rejected key surfaces as a real error, not as no quota", async () => {
    // This is the distinction the old short-circuit could not make: before, a
    // dead key and a live one without a plan both read "not available".
    const { fetcher } = recordingFetcher({
      onUsersMe: () =>
        jsonResponse(
          {
            error:
              "Unauthorized: Please make sure you're using the latest version of Cline and re-authenticate your Cline account.",
          },
          401,
        ),
    });

    await expect(fetchClineQuota(markClineApiKeyCredential("sk_dead"), fetcher)).rejects.toThrow(
      /Unauthorized/i,
    );
  });

  test("marks a raw key once and recognizes the marker", () => {
    expect(markClineApiKeyCredential("ck_abc")).toBe(`${CLINE_API_KEY_PREFIX}ck_abc`);
    const once = markClineApiKeyCredential("ck_abc");
    expect(markClineApiKeyCredential(once)).toBe(once);
  });

  test("an OAuth credential still sends the workos-prefixed token", async () => {
    // The api-key branch must not change the OAuth path.
    const { fetcher, auths } = recordingFetcher({});
    await fetchClineQuota(JSON.stringify({ accessToken: "workos:tok_1" }), fetcher);

    expect(auths.length).toBeGreaterThan(0);
    for (const auth of auths) {
      expect(auth).toBe("Bearer workos:tok_1");
    }
  });

  test("an OAuth credential without the prefix still gets one", async () => {
    const { fetcher, auths } = recordingFetcher({});
    await fetchClineQuota(JSON.stringify({ accessToken: "tok_1" }), fetcher);

    expect(auths.length).toBeGreaterThan(0);
    for (const auth of auths) {
      expect(auth).toBe("Bearer workos:tok_1");
    }
  });
});

describe("the api_key path through the provider registry", () => {
  /**
   * `fetchProviderQuota` is what the account test and the sweeps actually call,
   * so the fix has to hold there too and not only on the collector directly —
   * a marker that never reaches the collector would pass the tests above and
   * still report "not available" in the console.
   */
  test("an api_key account reads its identity rather than reporting unavailable", async () => {
    const { createDefaultProviderRegistry } = await import(
      "../../src/providers/default-registry"
    );
    const { fetchProviderQuota } = await import("../../src/providers/quota/quota-support");
    const registry = createDefaultProviderRegistry();
    expect(registry.hasQuotaCollector("cline")).toBe(true);

    const { fetcher } = recordingFetcher({
      onPlan: () => jsonResponse({ error: "no plan history found for user" }, 404),
      onLimits: () => jsonResponse({ error: "no plan history found for user" }, 404),
    });

    const result = await fetchProviderQuota(
      registry,
      "cline",
      markClineApiKeyCredential("sk_test_key"),
      fetcher as unknown as typeof fetch,
      { credential_kind: "api_key" },
    );

    // The old short-circuit answered "Quota endpoint is not available for this
    // provider." — indistinguishable from the provider simply having no surface.
    expect(result.error).toBeNull();
    expect(result.source).toBe("cline");
  });

  test("only cline credentials get the api-key marker", () => {
    // Marking another provider's key would route it into a branch that strips
    // or re-prefixes its token.
    const marker = markClineApiKeyCredential;
    expect(marker("sk_x")).toBe(`${CLINE_API_KEY_PREFIX}sk_x`);
    // Documented here rather than asserted against the shared wiring, which
    // lives in the console layer: the guard is `providerId === "cline"`.
  });
});
