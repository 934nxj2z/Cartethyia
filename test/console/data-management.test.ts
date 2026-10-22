/**
 * Disk housekeeping: measurement and reclaim.
 *
 * What is worth pinning is the safety boundary, because a reclaim that deletes
 * the wrong category is silent data loss. Hourly files are the only copy of
 * their requests until compaction folds them up, so the console refuses to
 * delete them; summaries past the retention window sit outside every query's
 * scan bound, so those are fair game.
 *
 * The telemetry directory is injected. The payload directory is not: reclaim
 * delegates to `prunePayloadFrames`, which resolves that path itself, so the
 * test overrides it through the same env var production uses rather than
 * pretending the two can be pointed apart.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TELEMETRY_DIR = await mkdtemp(join(tmpdir(), "carte-dm-events-"));
const PAYLOAD_DIR = await mkdtemp(join(tmpdir(), "carte-dm-payload-"));
process.env.CARTETHYIA_TELEMETRY_PAYLOAD_DIR = PAYLOAD_DIR;

const { createDataManagementOperations } = await import(
  "../../src/console/data-management/operations"
);
const { ReclaimNotAllowedError, PurgeNotWiredError } = await import(
  "../../src/console/data-management/contracts"
);
const { writePayloadFrame } = await import("../../src/observability/payload-store");

const OPS = createDataManagementOperations({
  telemetryDir: TELEMETRY_DIR,
  retentionDays: 30,
  payloadRetentionMs: 15 * 60_000,
  allowHourlyReclaim: false,
});

/** A UTC day offset from today, as `YYYY-MM-DD`. */
function dayOffset(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60_000).toISOString().slice(0, 10);
}

async function clear(): Promise<void> {
  for (const name of await readdir(TELEMETRY_DIR).catch(() => [])) {
    await rm(join(TELEMETRY_DIR, name), { force: true });
  }
  for (const name of await readdir(PAYLOAD_DIR).catch(() => [])) {
    await rm(join(PAYLOAD_DIR, name), { force: true });
  }
}

beforeEach(async () => {
  await mkdir(TELEMETRY_DIR, { recursive: true });
  await mkdir(PAYLOAD_DIR, { recursive: true });
  await clear();
});

afterEach(clear);

describe("disk usage", () => {
  test("counts each category separately, not as one total", async () => {
    await writeFile(join(TELEMETRY_DIR, `${dayOffset(1)}.events.jsonl`), "x".repeat(100));
    await writeFile(join(TELEMETRY_DIR, `${dayOffset(2)}.index.json`), "y".repeat(50));
    await writeFile(join(PAYLOAD_DIR, "frame.jsonb"), "z".repeat(25));

    const usage = await OPS.usage();
    const byId = Object.fromEntries(usage.buckets.map((b) => [b.id, b]));

    expect(byId.telemetry_hourly?.bytes).toBe(100);
    expect(byId.telemetry_hourly?.files).toBe(1);
    expect(byId.telemetry_compacted?.bytes).toBe(50);
    expect(byId.payload_frames?.bytes).toBe(25);
    expect(usage.totalBytes).toBe(175);
  });

  test("a summary past retention is reported reclaimable, a newer one is not", async () => {
    await writeFile(join(TELEMETRY_DIR, `${dayOffset(90)}.index.json`), "y".repeat(64));
    await writeFile(join(TELEMETRY_DIR, `${dayOffset(2)}.index.json`), "y".repeat(32));

    const usage = await OPS.usage();
    const compacted = usage.buckets.find((b) => b.id === "telemetry_compacted");
    // Only the 90-day-old file: the 2-day-old one still answers queries.
    expect(compacted?.reclaimableBytes).toBe(64);
    expect(compacted?.reclaimableFiles).toBe(1);
  });

  test("an empty install reports zeroes rather than failing", async () => {
    const usage = await OPS.usage();
    expect(usage.totalBytes).toBe(0);
    expect(usage.buckets.every((b) => b.files === 0)).toBe(true);
  });
});

describe("reclaim", () => {
  test("removing past-retention summaries leaves newer ones alone", async () => {
    await writeFile(join(TELEMETRY_DIR, `${dayOffset(90)}.index.json`), "y".repeat(10));
    await writeFile(join(TELEMETRY_DIR, `${dayOffset(1)}.index.json`), "y".repeat(20));

    const result = await OPS.reclaim("telemetry_retention");
    expect(result.deletedFiles).toBe(1);
    expect(result.reclaimedBytes).toBe(10);
    expect(result.action).toBe("telemetry_retention");
    expect(await readdir(TELEMETRY_DIR)).toHaveLength(1);
  });

  test("hourly files are refused", async () => {
    // The safety boundary: these are the only copy of their requests until
    // compaction folds them up, so losing one loses real history.
    await writeFile(join(TELEMETRY_DIR, `${dayOffset(1)}.events.jsonl`), "x".repeat(10));
    await expect(OPS.reclaim("telemetry_hourly")).rejects.toBeInstanceOf(
      ReclaimNotAllowedError,
    );
    expect(await readdir(TELEMETRY_DIR)).toHaveLength(1);
  });

  test("a reclaim never touches a category it was not asked about", async () => {
    await writeFile(join(TELEMETRY_DIR, `${dayOffset(1)}.events.jsonl`), "x".repeat(10));
    await OPS.reclaim("telemetry_retention");
    // An hourly file survives a retention reclaim even when nothing is pruned.
    expect(await readdir(TELEMETRY_DIR)).toHaveLength(1);
  });

  test("a file whose frames have all expired is dropped", async () => {
    // Written through the real frame writer: expiry lives inside the file, not
    // in its mtime, so a hand-made file would not exercise the rule this
    // reclaim depends on.
    await writePayloadFrame({ body: "expired" }, new Date(Date.now() - 1_000));
    const before = await readdir(PAYLOAD_DIR);
    expect(before.length).toBeGreaterThan(0);

    const result = await OPS.reclaim("payload_frames");
    expect(result.action).toBe("payload_frames");
    expect(result.deletedFiles).toBeGreaterThanOrEqual(1);
    expect(result.reclaimedBytes).toBeGreaterThan(0);
    expect(await readdir(PAYLOAD_DIR)).toHaveLength(0);
  });

  test("a file still holding a live frame is kept", async () => {
    // The load-bearing safety rule: frames are appended to one file, so the
    // file goes whole or not at all. Dropping it because an earlier frame in
    // it expired would take a payload whose row is still current.
    await writePayloadFrame({ body: "expired" }, new Date(Date.now() - 1_000));
    await writePayloadFrame({ body: "live" }, new Date(Date.now() + 60 * 60_000));

    const result = await OPS.reclaim("payload_frames");
    expect(result.deletedFiles).toBe(0);
    expect(await readdir(PAYLOAD_DIR)).toHaveLength(1);
  });
});

describe("the health & error log purge", () => {
  test("usage reports the row count, and purging clears the whole trail", async () => {
    const rows: string[] = [];
    const store = {
      count: async () => rows.length,
      purgeAll: async () => {
        const deleted = rows.length;
        rows.length = 0;
        return deleted;
      },
    };
    rows.push("one", "two", "three");
    const ops = createDataManagementOperations({
      telemetryDir: TELEMETRY_DIR,
      retentionDays: 30,
      payloadRetentionMs: 15 * 60_000,
      allowHourlyReclaim: false,
      healthEvents: store,
    });
    const usage = await ops.usage();
    expect(usage.healthEventCount).toBe(3);
    expect(await ops.purge("health_events")).toBe(3);
    const after = await ops.usage();
    expect(after.healthEventCount).toBe(0);
  });

  test("a composition without the health-event store refuses the purge", async () => {
    // The same reduced install that hides the control must not delete rows
    // through the raw route — the budget of the button is the budget of the
    // endpoint.
    await expect(OPS.purge("health_events")).rejects.toBeInstanceOf(PurgeNotWiredError);
  });

  test("usage omits the count rather than reporting zero when unwired", async () => {
    const usage = await OPS.usage();
    expect(usage.healthEventCount).toBeUndefined();
  });
});
