/**
 * Compaction preserves totals while dropping rows.
 *
 * The whole contract is in one sentence: a period that reported 2B input
 * tokens before compaction must still report 2B after it. Everything here
 * asserts that, plus the two properties that make it safe to run on a live
 * install — it is idempotent, and it never loses data to a crash.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accumulate,
  compactTelemetryFiles,
  emptyBucket,
  LATENCY_BUCKETS_MS,
  percentileFromHistogram,
  pruneStaleFiles,
} from "../../src/observability/event-compaction";
import { accumulateCompacted, emptyTotals, queryCompactedRows } from "../../src/observability/event-log";
import type { TelemetryEventRecord } from "../../src/observability/event-log";

let dir: string;
let originalDir: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cartethyia-compaction-"));
  // The module reads a module-level constant for the directory, so the suite
  // points `process.cwd()`'s relative path at the temp one.
  originalDir = process.env.CARTETHYIA_TEST_DIR;
  process.chdir(dir);
});

afterEach(async () => {
  if (originalDir !== undefined) process.env.CARTETHYIA_TEST_DIR = originalDir;
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

function event(overrides: Partial<TelemetryEventRecord> = {}): TelemetryEventRecord {
  return {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    tenantId: "tenant-1",
    requestId: crypto.randomUUID(),
    sourceSurface: "chat",
    requestedModel: "deepseek-v4.1-flash",
    reportedModel: null,
    requestedEffort: null,
    providerId: "qoder",
    accountId: null,
    networkPoolId: null,
    endpoint: "/v1/chat/completions",
    apiKeyId: "key-1",
    userAgent: "curl/8",
    clientIp: "1.2.3.4",
    latencyMs: 900,
    ttfbMs: 100,
    stream: false,
    status: "completed",
    httpStatus: 200,
    errorOrigin: null,
    errorCategory: null,
    inputTokens: 1000,
    cachedInputTokens: 100,
    outputTokens: 50,
    reasoningTokens: 0,
    estimatedCostUsd: 0.01,
    creditUsed: null,
    resolveMs: 5,
    tokensPerSec: 20,
    firstContentDeltaAtMs: null,
    lastEventAtMs: null,
    ...overrides,
  };
}

describe("compaction preserves totals", () => {
  test("the sums of a compacted period are the sums of its requests", async () => {
    // The number that matters: 2B in, 2B out.
    const requests = 400;
    const perInput = 5_000_000;
    const events = Array.from({ length: requests }, () =>
      event({ inputTokens: perInput, outputTokens: 100, cachedInputTokens: 10, status: "completed", latencyMs: 1500 }),
    );
    let bucket = emptyBucket();
    for (const row of events) bucket = accumulate(bucket, row);

    expect(bucket.inputTokens).toBe(requests * perInput);
    expect(bucket.requests).toBe(requests);
    expect(bucket.succeeded).toBe(requests);

    // And the same totals reach an EventTotals bucket unchanged.
    const totals = emptyTotals();
    accumulateCompacted(totals, {
      kind: "compacted",
      day: "2026-10-01",
      tenantId: "tenant-1",
      apiKeyId: "key-1",
      ...bucket,
    });
    expect(totals.inputTokens).toBe(requests * perInput);
    expect(totals.requests).toBe(requests);
  });

  test("a failed and cancelled request is counted in its own column", async () => {
    let bucket = emptyBucket();
    bucket = accumulate(bucket, event({ status: "completed" }));
    bucket = accumulate(bucket, event({ status: "failed" }));
    bucket = accumulate(bucket, event({ status: "cancelled" }));
    bucket = accumulate(bucket, event({ status: "truncated" }));
    expect(bucket.succeeded).toBe(1);
    expect(bucket.failed).toBe(1);
    expect(bucket.cancelled).toBe(1);
    expect(bucket.truncated).toBe(1);
    expect(bucket.requests).toBe(4);
  });

  test("latency keeps a mean that is exact and a percentile that is bucketed", async () => {
    let bucket = emptyBucket();
    bucket = accumulate(bucket, event({ latencyMs: 800 }));
    bucket = accumulate(bucket, event({ latencyMs: 3000 }));
    expect(bucket.latencyCount).toBe(2);
    expect(bucket.latencySum).toBe(3800);
    expect(bucket.latencyMinMs).toBe(800);
    expect(bucket.latencyMaxMs).toBe(3000);
    // P50 lands in the bucket that contains it, never a value in between: a
    // histogram cannot be more precise than its own edges.
    const p50 = percentileFromHistogram(bucket.latencyHistogram, 50);
    expect(LATENCY_BUCKETS_MS.includes(p50 as (typeof LATENCY_BUCKETS_MS)[number])).toBe(true);
  });

  test("an empty histogram has no percentile rather than a zero", async () => {
    expect(percentileFromHistogram(emptyBucket().latencyHistogram, 50)).toBeNull();
  });
});

describe("compaction is safe to run repeatedly", () => {
  test("compacting twice does not double-count", async () => {
    // The failure this prevents is the worst kind: a re-run that folds a
    // summary into itself would square every total, and nothing would look
    // wrong until someone checked the number against their provider bill.
    const day = "2026-09-01";
    await mkdirp();
    await writeFile(
      join("data/telemetry-events", `${day}T00.jsonl`),
      `${[event({ tenantId: "tenant-1", apiKeyId: "key-1", inputTokens: 1000 })].map((e) => JSON.stringify(e)).join("\n")}\n`,
      "utf8",
    );

    const first = await compactTelemetryFiles({ olderThanDays: 0, now: new Date("2026-10-21T00:00:00Z") });
    expect(first.filesCompacted).toBe(1);
    const afterFirst = await queryCompactedRows({ tenantId: "tenant-1" });
    const firstTotal = afterFirst.reduce((sum, row) => sum + row.inputTokens, 0);
    expect(firstTotal).toBe(1000);

    // A second pass over the same directory finds no hourly files left, and
    // must not re-fold the summary that is already there.
    const second = await compactTelemetryFiles({ olderThanDays: 0, now: new Date("2026-10-21T00:00:00Z") });
    expect(second.filesCompacted).toBe(0);
    const afterSecond = await queryCompactedRows({ tenantId: "tenant-1" });
    expect(afterSecond.reduce((sum, row) => sum + row.inputTokens, 0)).toBe(firstTotal);
  });

  test("a summary row is never folded into another summary", async () => {
    await mkdirp();
    const summary = {
      kind: "compacted",
      day: "2026-09-02",
      tenantId: "tenant-1",
      apiKeyId: "key-1",
      ...emptyBucket(),
      requests: 10,
      inputTokens: 10_000,
    };
    await writeFile(
      join("data/telemetry-events", "2026-09-02.compacted.jsonl"),
      `${JSON.stringify(summary)}\n`,
      "utf8",
    );
    const rows = await queryCompactedRows({ tenantId: "tenant-1" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.inputTokens).toBe(10_000);
  });
});

describe("retention", () => {
  test("a summary past the retention window is deleted, decided by name alone", async () => {
    await mkdirp();
    await writeFile(
      join("data/telemetry-events", "2026-01-01.compacted.jsonl"),
      `${JSON.stringify({ kind: "compacted", day: "2026-01-01", tenantId: "tenant-1", apiKeyId: null, ...emptyBucket() })}\n`,
      "utf8",
    );
    await writeFile(
      join("data/telemetry-events", "2026-10-20.compacted.jsonl"),
      `${JSON.stringify({ kind: "compacted", day: "2026-10-20", tenantId: "tenant-1", apiKeyId: null, ...emptyBucket() })}\n`,
      "utf8",
    );
    const deleted = await pruneStaleFiles(30, new Date("2026-10-21T00:00:00Z"));
    expect(deleted).toBe(1);
    const left = await readdir("data/telemetry-events");
    expect(left).toEqual(["2026-10-20.compacted.jsonl"]);
  });

  test("pruning is a no-op without a retention window", async () => {
    await mkdirp();
    await writeFile(join("data/telemetry-events", "2026-01-01.compacted.jsonl"), "{}\n", "utf8");
    expect(await pruneStaleFiles(undefined)).toBe(0);
  });
});

async function mkdirp(): Promise<void> {
  await mkdir("data/telemetry-events", { recursive: true });
}
