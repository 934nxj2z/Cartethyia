/**
 * A Cline `api_key` account must not be probed for quota.
 *
 * The collector marked api-key credentials and routed them to
 * `probeApiKeyConnectivity`, which asks `GET /api/v1/models` with the key as a
 * bearer token. Cline answers that with `Unauthorized: Please make sure you're
 * using the latest version of Cline and re-authenticate your Cline account.` —
 * the same wording it returns for a dead credential and for an implausible
 * client identity. The probe read it as "API key is invalid or revoked.", so
 * the sweep reported a working account as needing re-authentication, on every
 * pass.
 *
 * There is no quota to read for these accounts: an api_key carries no OAuth
 * envelope and Cline exposes no billing surface for it. The honest answer is
 * "not available", with no upstream call at all.
 */
import { describe, expect, test } from "bun:test";
import {
  CLINE_API_KEY_PREFIX,
  fetchClineQuota,
  markClineApiKeyCredential,
} from "../../src/providers/integrations/cline/cline-quota";

/** A fetcher that fails the test if it is ever reached. */
function forbiddenFetcher(): { readonly fetcher: typeof fetch; readonly calls: () => number } {
  let calls = 0;
  const fetcher = (async (): Promise<Response> => {
    calls += 1;
    throw new Error("Cline api-key quota must not reach the network.");
  }) as unknown as typeof fetch;
  return { fetcher, calls: () => calls };
}

describe("fetchClineQuota for an api_key account", () => {
  test("reports quota unavailable without any upstream call", async () => {
    const { fetcher, calls } = forbiddenFetcher();
    const credential = markClineApiKeyCredential("ck_test_key");

    // Resolves rather than rejecting: a throwing fetcher would surface as an
    // account error if the probe were still wired up.
    const result = await fetchClineQuota(credential, fetcher);

    expect(calls()).toBe(0);
    expect(result.error).toBe("Quota endpoint is not available for this provider.");
    expect(result.windows).toEqual([]);
    expect(result.plan).toBeNull();
    expect(result.source).toBe("cline");
  });

  test("marks a raw key once and recognizes the marker", () => {
    expect(markClineApiKeyCredential("ck_abc")).toBe(`${CLINE_API_KEY_PREFIX}ck_abc`);
    const once = markClineApiKeyCredential("ck_abc");
    expect(markClineApiKeyCredential(once)).toBe(once);
  });

  test("an OAuth credential still reaches the quota surface", async () => {
    // The api-key branch must not swallow the OAuth path: an unmarked
    // credential still resolves its token and calls upstream.
    let called = 0;
    const fetcher = (async (url: unknown): Promise<Response> => {
      called += 1;
      const path = String(url);
      if (path.endsWith("/users/me")) return jsonResponse({ id: "u-1" });
      if (path.endsWith("/plan")) return jsonResponse({ plan: { displayName: "Cline Pro" } });
      return jsonResponse({ limits: [] });
    }) as unknown as typeof fetch;

    const result = await fetchClineQuota(
      JSON.stringify({ accessToken: "workos:tok_1" }),
      fetcher,
    );
    expect(called).toBeGreaterThan(0);
    expect(result.source).toBe("cline");
    expect(result.plan).toBe("Cline Pro");
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
