/**
 * The day index: what gets counted, and what does not.
 *
 * Two properties matter. A fold is idempotent — running it twice must not
 * double a total, because folding is the only thing keeping the index in step
 * with an append-only file. And an unterminated line is not yet an event, so a
 * writer still appending must not have its partial row counted.
 *
 * Both are the reason the index tracks a byte offset rather than inferring
 * which file is open from its name, which is what let the old scheme delete a
 * file mid-write and lose its requests.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, appendFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The directory is resolved when `event-log` is first imported, so the override
// has to be set before anything pulls it in. Without this the tests write into
// — and then wipe — the real telemetry directory of whatever machine runs them.
const sandbox = await mkdtemp(join(tmpdir(), "carte-telemetry-test-"));
process.env.CARTETHYIA_DATA_DIR = sandbox;

const {
  dayEventFileName,
  dayIndexFileName,
  foldDayIndex,
  listEventDays,
  queryIndexedBuckets,
  readDayIndex,
  utcDay,
} = await import("../../src/observability/event-day-index");
const { TELEMETRY_EVENT_DIR } = await import("../../src/observability/event-log");

const DAY = "2026-10-22";

async function reset(): Promise<void> {
  for (const name of await readdir(TELEMETRY_EVENT_DIR).catch(() => [])) {
    await rm(join(TELEMETRY_EVENT_DIR, name), { force: true });
  }
  await mkdir(TELEMETRY_EVENT_DIR, { recursive: true });
}

beforeEach(reset);
afterEach(async () => {
  await reset();
  await rm(sandbox, { recursive: true, force: true }).catch(() => undefined);
});

let sequence = 0;

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  sequence += 1;
  return {
    id: `id-${sequence}`,
    requestId: `r-${sequence}`,
    tenantId: "tenant-1",
    apiKeyId: "key-1",
    createdAt: "2026-10-22T05:40:00.000Z",
    status: "completed",
    requestedModel: "m",
    providerId: "p",
    sourceSurface: "chat",
    clientIp: "127.0.0.1",
    inputTokens: 100,
    outputTokens: 10,
    cachedInputTokens: 0,
    latencyMs: 50,
    estimatedCostUsd: 0.01,
    ...overrides,
  };
}

async function append(body: string): Promise<void> {
  await appendFile(join(TELEMETRY_EVENT_DIR, dayEventFileName(DAY)), body, "utf8");
}

async function totals(): Promise<{ requests: number; input: number }> {
  const buckets = await queryIndexedBuckets({ tenantId: "tenant-1" });
  return {
    requests: buckets.reduce((sum, bucket) => sum + bucket.requests, 0),
    input: buckets.reduce((sum, bucket) => sum + bucket.inputTokens, 0),
  };
}

describe("day file naming", () => {
  test("a moment maps to its UTC day", () => {
    expect(utcDay(new Date("2026-10-22T23:59:59.000Z"))).toBe("2026-10-22");
    expect(utcDay(new Date("2026-10-23T00:00:00.000Z"))).toBe("2026-10-23");
  });

  test("the event and index files are named from the day", () => {
    expect(dayEventFileName(DAY)).toBe("2026-10-22.events.jsonl");
    expect(dayIndexFileName(DAY)).toBe("2026-10-22.index.json");
  });
});

describe("folding", () => {
  test("the day's events are counted", async () => {
    await append(`${JSON.stringify(event())}\n${JSON.stringify(event({ inputTokens: 250 }))}\n`);
    expect(await foldDayIndex(DAY)).toEqual({ folded: 2 });
    expect(await totals()).toEqual({ requests: 2, input: 350 });
  });

  test("folding twice does not double-count", async () => {
    // The load-bearing case: the index and the file are reconciled by byte
    // offset, so a second pass must find nothing left to fold.
    await append(`${JSON.stringify(event())}\n`);
    await foldDayIndex(DAY);
    expect(await foldDayIndex(DAY)).toEqual({ folded: 0 });
    expect(await totals()).toEqual({ requests: 1, input: 100 });
  });

  test("events appended after a fold are picked up", async () => {
    await append(`${JSON.stringify(event())}\n`);
    await foldDayIndex(DAY);
    await append(`${JSON.stringify(event({ inputTokens: 7 }))}\n`);
    expect(await foldDayIndex(DAY)).toEqual({ folded: 1 });
    expect(await totals()).toEqual({ requests: 2, input: 107 });
  });

  test("a partially written line is left for the next pass", async () => {
    // A writer may still be appending; a line without its newline is not an
    // event yet, and counting it would count a request that does not exist.
    await append(`${JSON.stringify(event())}\n${JSON.stringify(event({ inputTokens: 999 })).slice(0, 40)}`);
    expect(await foldDayIndex(DAY)).toEqual({ folded: 1 });
    expect(await totals()).toEqual({ requests: 1, input: 100 });
  });

  test("the event file is never deleted by a fold", async () => {
    // Folding replaces the old scheme's fold-and-delete. The file is the record
    // and outlives any number of folds.
    await append(`${JSON.stringify(event())}\n`);
    await foldDayIndex(DAY);
    await foldDayIndex(DAY);
    expect(await readdir(TELEMETRY_EVENT_DIR)).toContain(dayEventFileName(DAY));
  });

  test("a day with no events folds nothing", async () => {
    expect(await foldDayIndex(DAY)).toEqual({ folded: 0 });
  });
});

describe("the index on disk", () => {
  test("an unreadable index is rebuilt rather than fatal", async () => {
    await append(`${JSON.stringify(event())}\n`);
    await writeFile(join(TELEMETRY_EVENT_DIR, dayIndexFileName(DAY)), "{ not json", "utf8");
    expect(await foldDayIndex(DAY)).toEqual({ folded: 1 });
    expect(await totals()).toEqual({ requests: 1, input: 100 });
  });

  test("the watermark covers only whole lines", async () => {
    const line = JSON.stringify(event());
    await append(`${line}\n`);
    await foldDayIndex(DAY);
    const index = await readDayIndex(DAY);
    expect(index.watermarkBytes).toBe(Buffer.byteLength(line, "utf8") + 1);
    const size = (await readFile(join(TELEMETRY_EVENT_DIR, dayEventFileName(DAY)), "utf8")).length;
    expect(index.watermarkBytes).toBeLessThanOrEqual(size);
  });

  test("breakdown dimensions carry tokens, not just counts", async () => {
    await append(`${JSON.stringify(event({ requestedModel: "grok/grok-4.6" }))}\n`);
    await foldDayIndex(DAY);
    const [bucket] = await queryIndexedBuckets({ tenantId: "tenant-1" });
    expect(bucket?.dimModel["grok/grok-4.6"]).toMatchObject({ requests: 1, inputTokens: 100 });
    expect(bucket?.dimProvider["p"]).toMatchObject({ requests: 1 });
  });

  test("costs sum as numbers even when stored as strings", async () => {
    await append(
      `${JSON.stringify(event({ estimatedCostUsd: "0.000966" }))}\n` +
        `${JSON.stringify(event({ estimatedCostUsd: "0.001032" }))}\n`,
    );
    await foldDayIndex(DAY);
    const [bucket] = await queryIndexedBuckets({ tenantId: "tenant-1" });
    expect(bucket?.estimatedCostUsd).toBeCloseTo(0.001998, 8);
  });

  test("hours are recorded for the chart", async () => {
    await append(`${JSON.stringify(event({ createdAt: "2026-10-22T17:00:00.000Z" }))}\n`);
    await foldDayIndex(DAY);
    const [bucket] = await queryIndexedBuckets({ tenantId: "tenant-1" });
    expect(bucket?.hours[17]?.requests).toBe(1);
    expect(bucket?.hours[3]?.requests).toBe(0);
  });
});

describe("discovery", () => {
  test("the days present are listed", async () => {
    await append(`${JSON.stringify(event())}\n`);
    expect(await listEventDays()).toContain(DAY);
  });

  test("a read can fold first, so a fresh append is not invisible", async () => {
    await append(`${JSON.stringify(event())}\n`);
    const buckets = await queryIndexedBuckets({ tenantId: "tenant-1", foldFirst: true });
    expect(buckets.reduce((sum, bucket) => sum + bucket.requests, 0)).toBe(1);
  });
});
