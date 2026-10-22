/**
 * Source windows: when a file is folded, and when it is not.
 *
 * The safety rule is the one that matters. A window's file is appended to until
 * the window closes, so folding — and then deleting — the open one would drop
 * every event written afterwards. The sweep runs every `windowMinutes`, so on
 * each pass exactly the window that just closed is eligible.
 *
 * Compacted files are never folded or deleted by a fold: they hold the totals
 * the usage page reads, and only the retention window removes them.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { compactTelemetryFiles, compactedFileName } from "../../src/observability/event-compaction";
import { TELEMETRY_EVENT_DIR, windowFileName } from "../../src/observability/event-log";
import { queryCompactedRows } from "../../src/observability/event-log";

const WINDOW = 15;
const AT = new Date("2026-10-22T05:40:00.000Z");

async function reset(): Promise<void> {
  for (const name of await readdir(TELEMETRY_EVENT_DIR).catch(() => [])) {
    await rm(join(TELEMETRY_EVENT_DIR, name), { force: true });
  }
  await mkdir(TELEMETRY_EVENT_DIR, { recursive: true });
}

beforeEach(reset);
afterEach(reset);

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: "r-1",
    tenantId: "tenant-1",
    apiKeyId: "key-1",
    createdAt: AT.toISOString(),
    status: "success",
    model: "m",
    providerId: "p",
    inputTokens: 100,
    outputTokens: 10,
    ...overrides,
  };
}

async function writeWindow(file: string, events: readonly Record<string, unknown>[]): Promise<void> {
  await writeFile(
    join(TELEMETRY_EVENT_DIR, file),
    `${events.map((e) => JSON.stringify(e)).join("\n")}\n`,
    "utf8",
  );
}

describe("window naming", () => {
  test("a window name is the bucket start, floored to the window", () => {
    // 05:40 in a 15-minute window belongs to the 05:30 bucket.
    expect(windowFileName(AT, WINDOW)).toBe("2026-10-22T05-30.jsonl");
  });

  test("both ends of a window land in the same file", () => {
    const start = windowFileName(new Date("2026-10-22T05:30:00Z"), WINDOW);
    const end = windowFileName(new Date("2026-10-22T05:44:59Z"), WINDOW);
    expect(start).toBe(end);
  });

  test("the next window gets its own file", () => {
    const a = windowFileName(new Date("2026-10-22T05:44:59Z"), WINDOW);
    const b = windowFileName(new Date("2026-10-22T05:45:00Z"), WINDOW);
    expect(a).not.toBe(b);
  });
});

describe("folding", () => {
  test("the open window is left alone", async () => {
    // The load-bearing case: this file is still being appended to. Folding and
    // deleting it would lose every event written after the fold.
    const open = windowFileName(AT, WINDOW);
    await writeWindow(open, [event({ inputTokens: 100 })]);

    const result = await compactTelemetryFiles({ windowMinutes: WINDOW, now: AT });
    expect(result.filesCompacted).toBe(0);
    expect(await readdir(TELEMETRY_EVENT_DIR)).toContain(open);
  });

  test("a closed window is folded and its file removed", async () => {
    const closed = windowFileName(new Date("2026-10-22T05:20:00Z"), WINDOW);
    await writeWindow(closed, [event({ inputTokens: 100 })]);

    const result = await compactTelemetryFiles({ windowMinutes: WINDOW, now: AT });
    expect(result.filesCompacted).toBe(1);
    expect(await readdir(TELEMETRY_EVENT_DIR)).not.toContain(closed);

    const rows = await queryCompactedRows({ tenantId: "tenant-1" });
    expect(rows.reduce((sum, row) => sum + row.inputTokens, 0)).toBe(100);
  });

  test("several closed windows land in one day summary", async () => {
    // One file per day, however many windows fed it.
    const day = "2026-10-22";
    await writeWindow("2026-10-22T05-00.jsonl", [event({ inputTokens: 10 })]);
    await writeWindow("2026-10-22T05-15.jsonl", [event({ inputTokens: 20 })]);
    await writeWindow("2026-10-22T05-30.jsonl", [event({ inputTokens: 30 })]);

    // now is inside 05:30, so only the two earlier windows close.
    await compactTelemetryFiles({ windowMinutes: WINDOW, now: new Date("2026-10-22T05:35:00Z") });
    const files = await readdir(TELEMETRY_EVENT_DIR);
    expect(files).toContain(`${day}.compacted.jsonl`);
    expect(files).toContain("2026-10-22T05-30.jsonl");

    const rows = await queryCompactedRows({ tenantId: "tenant-1" });
    expect(rows.reduce((sum, row) => sum + row.inputTokens, 0)).toBe(30);
  });

  test("a later pass adds the next window without double-counting", async () => {
    await writeWindow("2026-10-22T05-00.jsonl", [event({ inputTokens: 10 })]);
    await compactTelemetryFiles({ windowMinutes: WINDOW, now: new Date("2026-10-22T05:20:00Z") });

    await writeWindow("2026-10-22T05-15.jsonl", [event({ inputTokens: 25 })]);
    await compactTelemetryFiles({ windowMinutes: WINDOW, now: new Date("2026-10-22T05:35:00Z") });

    const rows = await queryCompactedRows({ tenantId: "tenant-1" });
    // 10 + 25, not 10 + 10 + 25: the existing summary is merged, not re-folded.
    expect(rows.reduce((sum, row) => sum + row.inputTokens, 0)).toBe(35);
  });

  test("compacted files survive a fold", async () => {
    // They are the totals the usage page reads; only retention removes them.
    await writeWindow("2026-10-22T05-00.jsonl", [event({ inputTokens: 10 })]);
    await compactTelemetryFiles({ windowMinutes: WINDOW, now: new Date("2026-10-22T05:20:00Z") });
    expect(await readdir(TELEMETRY_EVENT_DIR)).toContain(compactedFileName("2026-10-22"));

    await compactTelemetryFiles({ windowMinutes: WINDOW, now: new Date("2026-10-22T05:50:00Z") });
    expect(await readdir(TELEMETRY_EVENT_DIR)).toContain(compactedFileName("2026-10-22"));
  });
});

describe("a file that cannot be read in full", () => {
  test("is kept rather than deleted with its events", async () => {
    // Folding now runs every window, so a torn file would be removed within
    // minutes of being written and every event in it lost. A line that does not
    // parse means the file stays for a later pass.
    const file = "2026-10-22T05-00.jsonl";
    const good = JSON.stringify(event({ inputTokens: 100 }));
    await writeFile(join(TELEMETRY_EVENT_DIR, file), `${good}\n{broken\n`, "utf8");

    const result = await compactTelemetryFiles({
      windowMinutes: WINDOW,
      now: new Date("2026-10-22T05:20:00Z"),
    });
    // Not counted as folded, so the pass cannot report success over data it
    // silently dropped.
    expect(result.filesCompacted).toBe(0);
    expect(await readdir(TELEMETRY_EVENT_DIR)).toContain(file);
  });

  test("a fully readable file is still folded and removed", async () => {
    // The counterpart: the guard must not turn into "never delete anything".
    const file = "2026-10-22T05-00.jsonl";
    await writeWindow(file, [event({ inputTokens: 100 }), event({ inputTokens: 200 })]);

    const result = await compactTelemetryFiles({
      windowMinutes: WINDOW,
      now: new Date("2026-10-22T05:20:00Z"),
    });
    expect(result.filesCompacted).toBe(1);
    expect(await readdir(TELEMETRY_EVENT_DIR)).not.toContain(file);
    const rows = await queryCompactedRows({ tenantId: "tenant-1" });
    expect(rows.reduce((sum, row) => sum + row.inputTokens, 0)).toBe(300);
  });
});
