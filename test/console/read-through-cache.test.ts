/**
 * Several console endpoints parse the retained telemetry window to answer, on
 * the event loop that serves the gateway. Redis is configured everywhere and
 * this cache only pinged it, so the same window was re-parsed per instance, per
 * poll, per endpoint. These lock the two properties that matter: a hit skips
 * the computation, and a Redis that fails never fails the request.
 */
import { describe, expect, test } from "bun:test";
import { cachedRead, READ_THROUGH_DEFAULT_TTL_SECONDS, type ReadThroughCacheClient } from "../../src/console/shared/read-through-cache";

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
    expect(recorded.writes).toEqual([
      { key: "k", value: JSON.stringify({ requests: 7 }), ttl: READ_THROUGH_DEFAULT_TTL_SECONDS },
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
