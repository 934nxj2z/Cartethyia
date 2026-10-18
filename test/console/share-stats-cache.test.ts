/**
 * The share-stats Redis tier: one family, one computation per tick.
 *
 * The share page re-reads its rollup every 2 s per viewer, and the rollup parses
 * the whole retained telemetry window. Without a shared cache, N viewers of one
 * link cost N parses every 2 s. These lock the three properties that matter:
 * a second tick inside the TTL reuses the first computation, the numbers are
 * identical with and without the cache, and a Redis that fails never fails the
 * page.
 *
 * No database or Redis server is required: the port reads telemetry files, and
 * the cache is a Map-backed fake with the same `{ get, set }` shape as
 * `read-through-cache.test.ts`.
 */
import { appendFile, mkdir, rm } from "node:fs/promises";
import { afterAll, describe, expect, test } from "bun:test";
import { createShareStatsPort } from "../../src/console/share/share-stats";
import { TELEMETRY_EVENT_DIR } from "../../src/observability/event-log";

const FIXTURE_FILE = `${TELEMETRY_EVENT_DIR}/share-stats-cache-test.jsonl`;

interface Recorded {
  readonly reads: string[];
  readonly writes: Array<{ key: string; value: string; ttl: number }>;
}

function fakeClient(
  stored: Map<string, string>,
  options: { failGet?: boolean; failSet?: boolean } = {},
): { client: { get(key: string): Promise<string | null>; set(key: string, value: string, mode: "EX", ttl: number): Promise<unknown> }; recorded: Recorded } {
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

/** Appends one telemetry event for a share family to the fixture file. */
async function writeEvent(
  tenantId: string,
  apiKeyId: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await mkdir(TELEMETRY_EVENT_DIR, { recursive: true });
  const requestId = crypto.randomUUID();
  const line = JSON.stringify({
    id: requestId,
    requestId,
    tenantId,
    apiKeyId,
    sourceSurface: "chat",
    requestedModel: "claude-sonnet-4-6",
    stream: true,
    status: "completed",
    createdAt: new Date().toISOString(),
    inputTokens: 100,
    outputTokens: 50,
    ...overrides,
  });
  await appendFile(FIXTURE_FILE, `${line}\n`, "utf8");
}

const RECIPIENTS = { total: 2, active: 1 } as const;

afterAll(async () => {
  await rm(FIXTURE_FILE, { force: true });
});

describe("createShareStatsPort — the Redis tier", () => {
  test("a second tick inside the TTL reuses the first computation", async () => {
    const tenantId = crypto.randomUUID();
    const keyId = crypto.randomUUID();
    await writeEvent(tenantId, keyId);
    const stored = new Map<string, string>();
    const { client, recorded } = fakeClient(stored);
    const port = createShareStatsPort({ redis: client as never });

    const first = await port.getFamilyStats(tenantId, [keyId], RECIPIENTS);

    // A third event arrives after the first read. A recompute would include it;
    // a cache hit returns the value computed before it existed.
    await writeEvent(tenantId, keyId, { inputTokens: 999_999, outputTokens: 0 });

    const second = await port.getFamilyStats(tenantId, [keyId], RECIPIENTS);

    expect(second).toEqual(first);
    expect(first.totals.requests).toBe(1);
    expect(first.recipients).toEqual(RECIPIENTS);
    // One miss wrote one entry; the second call read it back rather than
    // computing again (compute is only reachable on a miss).
    expect(recorded.reads).toHaveLength(2);
    expect(recorded.writes).toHaveLength(1);
    expect(recorded.writes[0]?.ttl).toBe(2);
  });

  test("recipients are reattached per call, not frozen into the cached value", async () => {
    // `recipients` is Postgres-derived, not telemetry, so it is excluded from the
    // cached payload: a recipient-count change must not invalidate the expensive
    // part, and the caller's own value must come back untouched.
    const tenantId = crypto.randomUUID();
    const keyId = crypto.randomUUID();
    await writeEvent(tenantId, keyId);
    const stored = new Map<string, string>();
    const { client, recorded } = fakeClient(stored);
    const port = createShareStatsPort({ redis: client as never });

    const first = await port.getFamilyStats(tenantId, [keyId], { total: 1, active: 1 });
    const second = await port.getFamilyStats(tenantId, [keyId], { total: 9, active: 4 });

    expect(first.recipients).toEqual({ total: 1, active: 1 });
    expect(second.recipients).toEqual({ total: 9, active: 4 });
    // Still one computation: only the recipient count changed.
    expect(recorded.writes).toHaveLength(1);
    // The cached payload carries no `recipients` key at all.
    expect(recorded.writes[0]?.value).not.toContain("recipients");
  });

  test("numbers are identical with and without a cache", async () => {
    const tenantId = crypto.randomUUID();
    const keyId = crypto.randomUUID();
    await writeEvent(tenantId, keyId, { inputTokens: 120, outputTokens: 30 });
    await writeEvent(tenantId, keyId, { inputTokens: 5, outputTokens: 7, status: "failed", httpStatus: 502 });

    const cached = await createShareStatsPort({
      redis: fakeClient(new Map()).client as never,
    }).getFamilyStats(tenantId, [keyId], RECIPIENTS);
    const direct = await createShareStatsPort().getFamilyStats(tenantId, [keyId], RECIPIENTS);

    expect(cached).toEqual(direct);
    expect(direct.totals.requests).toBe(2);
    expect(direct.totals.errors).toBe(1);
  });

  test("a failed read falls through to computing", async () => {
    const tenantId = crypto.randomUUID();
    const keyId = crypto.randomUUID();
    await writeEvent(tenantId, keyId);
    const { client } = fakeClient(new Map(), { failGet: true });
    const port = createShareStatsPort({ redis: client as never });

    const stats = await port.getFamilyStats(tenantId, [keyId], RECIPIENTS);
    expect(stats.totals.requests).toBe(1);
  });

  test("a failed write still returns the computed answer", async () => {
    const tenantId = crypto.randomUUID();
    const keyId = crypto.randomUUID();
    await writeEvent(tenantId, keyId);
    const { client } = fakeClient(new Map(), { failSet: true });
    const port = createShareStatsPort({ redis: client as never });

    const stats = await port.getFamilyStats(tenantId, [keyId], RECIPIENTS);
    expect(stats.totals.requests).toBe(1);
  });

  test("an empty family short-circuits before any cache call", async () => {
    // A freshly created link with no issued keys has no traffic to read, so it
    // must not touch Redis at all.
    const { client, recorded } = fakeClient(new Map());
    const port = createShareStatsPort({ redis: client as never });
    const stats = await port.getFamilyStats(crypto.randomUUID(), [], RECIPIENTS);
    expect(stats.totals.requests).toBe(0);
    expect(recorded.reads).toHaveLength(0);
    expect(recorded.writes).toHaveLength(0);
  });

  test("the key separates families and model filters", async () => {
    // Both inputs change the payload, so both are in the key: two different key
    // sets and two different model filters must not share one entry.
    const tenantId = crypto.randomUUID();
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    await writeEvent(tenantId, a);
    const stored = new Map<string, string>();
    const { client, recorded } = fakeClient(stored);
    const port = createShareStatsPort({ redis: client as never });

    await port.getFamilyStats(tenantId, [a], RECIPIENTS);
    await port.getFamilyStats(tenantId, [b], RECIPIENTS);
    await port.getFamilyStats(tenantId, [a], RECIPIENTS, ["claude-sonnet-4-6"]);
    // Key order must not split one family across entries.
    await port.getFamilyStats(tenantId, [a, b], RECIPIENTS);
    await port.getFamilyStats(tenantId, [b, a], RECIPIENTS);

    const keys = new Set(recorded.reads);
    expect(keys.size).toBe(4);
    for (const key of keys) expect(key.startsWith(`share:v1:stats:${tenantId}:`)).toBe(true);
  });
});
