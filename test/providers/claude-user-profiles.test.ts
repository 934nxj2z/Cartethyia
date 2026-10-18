/**
 * Claude User Profiles REST client.
 *
 * Complements `claude-user-profile.test.ts`, which covers the
 * `anthropic-user-profile-id` header on dispatch. This file covers the REST
 * reads: URL construction, the donor's beta/version headers, page and profile
 * shapes, and the fail-closed contract (throw, never a silent empty result).
 *
 * No network: every case injects a stub fetcher, so nothing leaves the process.
 */
import { describe, expect, test } from "bun:test";

import {
  CLAUDE_USER_PROFILES_BETA,
  getClaudeUserProfile,
  listClaudeUserProfiles,
  parseClaudeUserProfile,
  parseClaudeUserProfilePage,
} from "../../src/providers/integrations/claude/claude-user-profiles";
import type { FetchLike } from "../../src/providers/quota/quota-contracts";

/** Verbatim donor fixture (`packages/ai/test/anthropic-user-profiles.test.ts:10-27`). */
const PROFILE = {
  type: "user_profile",
  id: "uprof_123",
  created_at: "2026-09-04T00:00:00Z",
  updated_at: "2026-09-04T00:00:00Z",
  metadata: { tier: "pro" },
  trust_grants: { inference: { status: "active" } },
  external_user_details: {
    account_status: "active",
    country: "US",
    email_hash: null,
    entity_type: "individual",
    name_hash: null,
    onboarded_at: null,
    reference_id: "customer-123",
  },
};

interface SeenRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
}

/**
 * Stub fetcher that records the request and answers with `body`. Caches in the
 * client are keyed by credential hash, so each case passes a distinct
 * credential to stay independent of the others.
 */
function stubFetch(
  body: unknown,
  status = 200,
): { fetcher: FetchLike; seen: SeenRequest[] } {
  const seen: SeenRequest[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      url: typeof input === "string" ? input : input.toString(),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as FetchLike;
  return { fetcher, seen };
}

function headerValue(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) return headers[key];
  }
  return undefined;
}

describe("claude user profiles REST client", () => {
  test("lists profiles with the donor's query string and headers", async () => {
    const { fetcher, seen } = stubFetch({ data: [PROFILE], next_page: null });
    const page = await listClaudeUserProfiles(
      "cred-list-1",
      { limit: 3, order: "asc", order_by: "name" },
      { fetcher },
    );

    expect(seen.length).toBe(1);
    const request = seen[0];
    expect(request).toBeDefined();
    // Donor: `GET /v1/user_profiles?limit=&order=&order_by=&page=`
    // (anthropic-user-profiles.ts:148-159).
    expect(request?.url).toBe(
      "https://api.anthropic.com/v1/user_profiles?limit=3&order=asc&order_by=name",
    );
    expect(request?.method).toBe("GET");
    // Donor: anthropic-version + the user-profiles beta (:130-131).
    expect(headerValue(request?.headers ?? {}, "anthropic-version")).toBe(
      "2023-06-01",
    );
    expect(headerValue(request?.headers ?? {}, "anthropic-beta")).toBe(
      CLAUDE_USER_PROFILES_BETA,
    );
    expect(headerValue(request?.headers ?? {}, "authorization")).toBe(
      "Bearer cred-list-1",
    );

    expect(page.data.length).toBe(1);
    expect(page.next_page).toBeNull();
    expect(page.data[0]?.id).toBe("uprof_123");
  });

  test("omits the query string entirely when no params are given", async () => {
    const { fetcher, seen } = stubFetch({ data: [], next_page: null });
    await listClaudeUserProfiles("cred-list-2", {}, { fetcher });
    // The donor emits the bare path when the query is empty (`:157`).
    expect(seen[0]?.url).toBe("https://api.anthropic.com/v1/user_profiles");
  });

  test("passes a page cursor through as `page`", async () => {
    const { fetcher, seen } = stubFetch({ data: [], next_page: null });
    await listClaudeUserProfiles(
      "cred-list-3",
      { page: "next cursor" },
      { fetcher },
    );
    expect(seen[0]?.url).toBe(
      "https://api.anthropic.com/v1/user_profiles?page=next+cursor",
    );
  });

  test("gets one profile by id", async () => {
    const { fetcher, seen } = stubFetch(PROFILE);
    const profile = await getClaudeUserProfile(
      "cred-get-1",
      "uprof_123",
      { fetcher },
    );
    // Donor: `GET /v1/user_profiles/{id}` (`:174-176`).
    expect(seen[0]?.url).toBe(
      "https://api.anthropic.com/v1/user_profiles/uprof_123",
    );
    expect(profile.id).toBe("uprof_123");
    expect(profile.type).toBe("user_profile");
    expect(profile.metadata).toEqual({ tier: "pro" });
    expect(profile.trust_grants).toEqual({ inference: { status: "active" } });
    expect(profile.external_user_details?.country).toBe("US");
    expect(profile.external_user_details?.entity_type).toBe("individual");
    expect(profile.created_at).toBe("2026-09-04T00:00:00Z");
  });

  test("percent-encodes a profile id so it cannot escape the path", async () => {
    const { fetcher, seen } = stubFetch(PROFILE);
    // A caller-supplied id reaches the path; the donor encodes it (`:175`), so
    // a `/` cannot open a second path segment.
    await getClaudeUserProfile("cred-get-2", "a/b?c=1", { fetcher });
    expect(seen[0]?.url).toBe(
      "https://api.anthropic.com/v1/user_profiles/a%2Fb%3Fc%3D1",
    );
  });

  test("rejects an empty profile id without making a request", async () => {
    const { fetcher, seen } = stubFetch(PROFILE);
    await expect(
      getClaudeUserProfile("cred-get-3", "   ", { fetcher }),
    ).rejects.toThrow(/missing profile id/);
    expect(seen.length).toBe(0);
  });

  test("fails closed on a non-2xx response", async () => {
    const { fetcher } = stubFetch(
      { type: "error", error: { type: "not_found_error", message: "Unknown user profile" } },
      404,
    );
    // A lookup failure must surface as an error, never as an empty profile.
    await expect(
      getClaudeUserProfile("cred-get-4", "uprof_missing", { fetcher }),
    ).rejects.toThrow(/Claude user profiles request failed/);
  });

  test("fails closed on a malformed success body", async () => {
    const { fetcher } = stubFetch({ unexpected: true });
    await expect(
      getClaudeUserProfile("cred-get-5", "uprof_123", { fetcher }),
    ).rejects.toThrow(/malformed response/);
  });

  test("fails closed when a list body has no data array", async () => {
    const { fetcher } = stubFetch({ next_page: null });
    await expect(
      listClaudeUserProfiles("cred-list-4", {}, { fetcher }),
    ).rejects.toThrow(/malformed response/);
  });

  test("does not redact or leak the token in a failure message", async () => {
    const { fetcher } = stubFetch({ error: "denied" }, 403);
    const caught = await getClaudeUserProfile(
      "cred-get-6",
      "uprof_123",
      { fetcher },
    ).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain("cred-get-6");
  });

  test("serves a repeat read from the credential-scoped cache", async () => {
    const { fetcher, seen } = stubFetch(PROFILE);
    const first = await getClaudeUserProfile("cred-cache-1", "uprof_123", {
      fetcher,
    });
    const second = await getClaudeUserProfile("cred-cache-1", "uprof_123", {
      fetcher,
    });
    expect(second).toEqual(first);
    expect(seen.length).toBe(1);
  });

  test("does not share cache entries across credentials", async () => {
    const { fetcher, seen } = stubFetch(PROFILE);
    await getClaudeUserProfile("cred-cache-a", "uprof_123", { fetcher });
    await getClaudeUserProfile("cred-cache-b", "uprof_123", { fetcher });
    expect(seen.length).toBe(2);
  });

  test("honors an injected base url", async () => {
    const { fetcher, seen } = stubFetch({ data: [], next_page: null });
    await listClaudeUserProfiles(
      "cred-base-1",
      {},
      { fetcher, base_url: "https://gateway.internal/" },
    );
    expect(seen[0]?.url).toBe("https://gateway.internal/v1/user_profiles");
  });

  test("reads the access token out of a JSON credential envelope", async () => {
    const { fetcher, seen } = stubFetch(PROFILE);
    await getClaudeUserProfile(
      JSON.stringify({ accessToken: "sk-ant-oauth-1" }),
      "uprof_123",
      { fetcher },
    );
    expect(headerValue(seen[0]?.headers ?? {}, "authorization")).toBe(
      "Bearer sk-ant-oauth-1",
    );
  });
});

describe("claude user profile parsers", () => {
  test("tolerates unknown and missing optional fields", () => {
    const profile = parseClaudeUserProfile({
      id: "uprof_456",
      unknown_future_field: 1,
      trust_grants: { inference: { status: "whatever" } },
      access_type: "not-a-value",
    });
    expect(profile).not.toBeNull();
    expect(profile?.id).toBe("uprof_456");
    expect(profile?.type).toBe("user_profile");
    expect(profile?.metadata).toEqual({});
    // Unrecognized enum values are dropped rather than passed through.
    expect(profile?.trust_grants).toEqual({});
    expect(profile?.access_type).toBeUndefined();
    expect(profile?.external_user_details).toBeUndefined();
  });

  test("returns null when the body cannot be addressed", () => {
    expect(parseClaudeUserProfile(null)).toBeNull();
    expect(parseClaudeUserProfile("nope")).toBeNull();
    expect(parseClaudeUserProfile({ type: "user_profile" })).toBeNull();
  });

  test("drops unparseable rows from a page but keeps the cursor", () => {
    const page = parseClaudeUserProfilePage({
      data: [PROFILE, { no_id: true }, null],
      next_page: "next cursor",
    });
    expect(page?.data.length).toBe(1);
    expect(page?.next_page).toBe("next cursor");
  });

  test("returns null for a page body that is not an object", () => {
    expect(parseClaudeUserProfilePage([])).toBeNull();
  });
});
