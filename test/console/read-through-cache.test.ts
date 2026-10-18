/**
 * Several console endpoints parse the retained telemetry window to answer, on
 * the event loop that serves the gateway. Redis is configured everywhere and
 * this cache only pinged it, so the same window was re-parsed per instance, per
 * poll, per endpoint. These lock the two properties that matter: a hit skips
 * the computation, and a Redis that fails never fails the request.
 */
import { describe, expect, test } from "bun:test";
import {
  cachedRead,
  cachedReadWithEtag,
  conditionalResponse,
  matchesEtag,
  READ_THROUGH_DEFAULT_TTL_SECONDS,
  type ReadThroughCacheClient,
} from "../../src/console/shared/read-through-cache";

interface Recorded {
  readonly reads: string[];
  readonly writes: Array<{ key: string; value: string; ttl: number }>;
}

function fakeClient(
  stored: Map<string, string>,
  options: { failGet?: boolean; failSet?: boolean } = {},
): { client: ReadThroughCacheClient; recorded: Recorded } {
  const reads: string[] = [];
  const writes: Array<{ key: string; value: string; ttl: number }> = [];
  return {
    recorded: { reads, writes },
    client: {
      async get(key) {
        reads.push(key);
        if (options.failGet === true) throw new Error("redis down");
        return stored.get(key) ?? null;
      },
      async set(key, value, _mode, ttlSeconds) {
        writes.push({ key, value, ttl: ttlSeconds });
        if (options.failSet === true) throw new Error("redis down");
        stored.set(key, value);
      },
    },
  };
}

describe("read-through cache", () => {
  test("computes on a miss and stores it with the TTL", async () => {
    const stored = new Map<string, string>();
    const { client, recorded } = fakeClient(stored);
    let computed = 0;
    const value = await cachedRead(client, "k", async () => {
      computed += 1;
      return { requests: 7 };
    });
    expect(value).toEqual({ requests: 7 });
    expect(computed).toBe(1);
    // The validator key is written alongside the body: `cachedRead` shares the
    // write path with `cachedReadWithEtag`, so a caller that later switches to
    // validators finds one already there rather than a half-populated entry.
    expect(recorded.writes).toEqual([
      { key: "k", value: JSON.stringify({ requests: 7 }), ttl: READ_THROUGH_DEFAULT_TTL_SECONDS },
      {
        key: "k:etag",
        value: expect.stringMatching(/^"[0-9a-f]+"$/) as unknown as string,
        ttl: READ_THROUGH_DEFAULT_TTL_SECONDS,
      },
    ]);
  });

  test("serves a hit without computing", async () => {
    const stored = new Map([["k", JSON.stringify({ requests: 9 })]]);
    const { client } = fakeClient(stored);
    let computed = 0;
    const value = await cachedRead(client, "k", async () => {
      computed += 1;
      return { requests: 0 };
    });
    expect(value).toEqual({ requests: 9 });
    expect(computed).toBe(0);
  });

  test("computes when no cache is configured", async () => {
    let computed = 0;
    const value = await cachedRead(undefined, "k", async () => {
      computed += 1;
      return { ok: true };
    });
    expect(value).toEqual({ ok: true });
    expect(computed).toBe(1);
  });

  test("a failed read falls through to computing", async () => {
    const { client } = fakeClient(new Map(), { failGet: true });
    let computed = 0;
    const value = await cachedRead(client, "k", async () => {
      computed += 1;
      return { ok: true };
    });
    expect(value).toEqual({ ok: true });
    expect(computed).toBe(1);
  });

  test("a failed write still returns the computed answer", async () => {
    const { client } = fakeClient(new Map(), { failSet: true });
    const value = await cachedRead(client, "k", async () => ({ ok: true }));
    expect(value).toEqual({ ok: true });
  });
});

describe("read-through cache validators", () => {
  test("a matching If-None-Match answers 304 with no body", async () => {
    // The whole point of the validator: an unchanged window costs ~200 bytes
    // instead of the payload.
    const { client } = fakeClient(new Map());
    const first = await cachedReadWithEtag(client, "k", async () => ({ rows: [1, 2, 3] }));
    const response = conditionalResponse(first.etag, first, first.value);
    expect(response.status).toBe(304);
    expect((await response.arrayBuffer()).byteLength).toBe(0);
    expect(response.headers.get("etag")).toBe(first.etag);
    // `no-store` would forbid the revalidation this exists to enable.
    expect(response.headers.get("cache-control")).toBe("no-cache");
  });

  test("a mismatched validator returns the body with the etag attached", async () => {
    const { client } = fakeClient(new Map());
    const result = await cachedReadWithEtag(client, "k", async () => ({ rows: [1] }));
    const response = conditionalResponse('"deadbeef"', result, result.value);
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe(result.etag);
    expect(await response.json()).toEqual({ rows: [1] });
  });

  test("a different body produces a different etag", async () => {
    // Guards against a constant hash, which would answer 304 forever and leave
    // the dashboard frozen on whatever it first rendered.
    const one = await cachedReadWithEtag(undefined, "k", async () => ({ n: 1 }));
    const two = await cachedReadWithEtag(undefined, "k", async () => ({ n: 2 }));
    expect(one.etag).not.toBe(two.etag);
  });

  test("the same body produces the same etag", async () => {
    const one = await cachedReadWithEtag(undefined, "k", async () => ({ n: 1 }));
    const two = await cachedReadWithEtag(undefined, "k", async () => ({ n: 1 }));
    expect(one.etag).toBe(two.etag);
  });

  test("a cache hit reuses the stored validator instead of re-hashing", async () => {
    const stored = new Map<string, string>();
    const { client, recorded } = fakeClient(stored);
    const first = await cachedReadWithEtag(client, "k", async () => ({ n: 1 }));
    // The validator is written once, with the body.
    expect(recorded.writes.map((write) => write.key)).toEqual(["k", "k:etag"]);
    // A hit has no `:etag` read of its own beyond the pair, and never computes.
    const second = await cachedReadWithEtag(client, "k", async () => ({ n: 99 }));
    expect(second.etag).toBe(first.etag);
    expect(second.value).toEqual({ n: 1 });
  });

  test("a body hit with a missing validator is re-hashed, not dropped", async () => {
    // Partial eviction, or a row written before validators existed: the pair
    // must not disagree, and the body is still worth serving.
    const stored = new Map([["k", JSON.stringify({ n: 1 })]]);
    const { client } = fakeClient(stored);
    const result = await cachedReadWithEtag(client, "k", async () => ({ n: 99 }));
    expect(result.value).toEqual({ n: 1 });
    expect(result.etag).toMatch(/^"[0-9a-f]+"$/);
  });

  test("no cache client still yields a usable validator", async () => {
    const result = await cachedReadWithEtag(undefined, "k", async () => ({ n: 1 }));
    expect(conditionalResponse(result.etag, result, result.value).status).toBe(304);
  });

  test("a failed read falls through to computing, with a validator", async () => {
    const { client } = fakeClient(new Map(), { failGet: true });
    let computed = 0;
    const result = await cachedReadWithEtag(client, "k", async () => {
      computed += 1;
      return { ok: true };
    });
    expect(computed).toBe(1);
    expect(result.value).toEqual({ ok: true });
    expect(result.etag).toMatch(/^"/);
  });

  test("cachedRead still returns the bare value", async () => {
    const { client } = fakeClient(new Map());
    expect(await cachedRead(client, "k", async () => ({ n: 1 }))).toEqual({ n: 1 });
  });
});

describe("matchesEtag", () => {
  test("absent header never matches", () => {
    expect(matchesEtag(null, '"abc"')).toBe(false);
  });
  test("a list of validators matches on any member", () => {
    expect(matchesEtag('"x", "abc", "y"', '"abc"')).toBe(true);
    expect(matchesEtag('"x", "y"', '"abc"')).toBe(false);
  });
  test("the wildcard form matches anything", () => {
    expect(matchesEtag("*", '"abc"')).toBe(true);
  });
  test("a weak validator names the same representation", () => {
    expect(matchesEtag('W/"abc"', '"abc"')).toBe(true);
  });
});
