/**
 * The validated egress chokepoint, tested without touching the network.
 *
 * `resolveFn` and `fetchFn` are both injectable, which is what makes these
 * assertions possible offline. They pin the parts that fail silently: an SSRF
 * check that only runs on the first hop would let a redirect walk a request
 * into private address space, and a non-http scheme reaching the dial is a
 * TypeError from deep inside node rather than a typed refusal.
 */
import { describe, expect, test } from "bun:test";
import { createValidatedFetch } from "../../src/network/outbound-fetch";

/**
 * Scope note for anyone refactoring this egress: injecting `fetchFn` bypasses
 * `pinnedFetch` entirely (`outbound-fetch.ts:347`), so header stripping and
 * `content-encoding` decoding — both applied inside `pinnedFetch` — do NOT run
 * on that path. Everything asserted below therefore sticks to behaviour that
 * happens *around* the dial: scheme and SSRF gating, redirect revalidation, and
 * body pass-through. The pinned-dial half needs a real socket and is not
 * covered here.
 */

/** Resolver that answers every hostname with one fixed address. */
function resolver(address: string): (hostname: string) => Promise<readonly string[]> {
  return async (hostname: string) => {
    void hostname;
    return [address];
  };
}

/** Records the URLs dialed and answers 200 with an empty body. */
function recordingFetcher(seen: string[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    seen.push(String(input instanceof Request ? input.url : input));
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("createValidatedFetch", () => {
  test("rejects a non-http scheme before any dial", async () => {
    const seen: string[] = [];
    const fetcher = createValidatedFetch({
      policy: {},
      resolveFn: resolver("93.184.216.34"),
      fetchFn: recordingFetcher(seen),
    });
    await expect(fetcher("file:///etc/passwd")).rejects.toThrow(/protocol/i);
    expect(seen).toEqual([]);
  });

  test("refuses a target whose resolved address is blocked", async () => {
    const seen: string[] = [];
    const fetcher = createValidatedFetch({
      // Default policy denies private/loopback space; `allowPrivate` opts in.
      policy: {},
      // A loopback answer is exactly the rebind an SSRF check exists to stop.
      resolveFn: resolver("127.0.0.1"),
      fetchFn: recordingFetcher(seen),
    });
    await expect(fetcher("https://example.test/")).rejects.toThrow();
    expect(seen).toEqual([]);
  });

  test("resolves and validates every redirect hop, not just the first", async () => {
    const seen: string[] = [];
    const resolved: string[] = [];
    let hop = 0;
    const fetcher = createValidatedFetch({
      policy: {},
      resolveFn: async (hostname: string) => {
        resolved.push(hostname);
        // First host is public; the redirect target resolves into loopback.
        return [hop++ === 0 ? "93.184.216.34" : "127.0.0.1"];
      },
      fetchFn: (async (input: RequestInfo | URL) => {
        seen.push(String(input instanceof Request ? input.url : input));
        return new Response("", {
          status: 302,
          headers: { location: "https://second.test/" },
        });
      }) as unknown as typeof fetch,
    });
    await expect(fetcher("https://first.test/")).rejects.toThrow();
    // The second hop must have been resolved — a check that ran once would
    // have dialed the private address instead of refusing it.
    expect(resolved).toContain("second.test");
  });

  test("dials a public target and returns the response", async () => {
    const seen: string[] = [];
    const fetcher = createValidatedFetch({
      policy: {},
      resolveFn: resolver("93.184.216.34"),
      fetchFn: recordingFetcher(seen),
    });
    const response = await fetcher("https://example.test/");
    expect(response.status).toBe(200);
    expect(seen).toEqual(["https://example.test/"]);
  });

  test("a GET carrying a body reaches the wire", async () => {
    // `fetch` itself refuses GET + body; this egress is the node:http path
    // that allows it, which Qoder's model list requires.
    let body: string | undefined;
    const fetcher = createValidatedFetch({
      policy: {},
      resolveFn: resolver("93.184.216.34"),
      fetchFn: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        body = init?.body === undefined || init.body === null ? undefined : String(init.body);
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    await fetcher("https://example.test/list", { method: "GET", body: "{}" });
    expect(body).toBe("{}");
  });

});
