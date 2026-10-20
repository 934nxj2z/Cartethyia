/**
 * The deferred health-audit buffer.
 *
 * Two properties matter, and both fail silently:
 *
 * - enqueue must never touch the database, or the write stays on the request
 *   path and the deferral buys nothing;
 * - the queue must be bounded, or a failure wave that cannot be flushed grows
 *   it until the process dies. A health log is worth less than a stable process.
 */
import { describe, expect, test } from "bun:test";
import {
  HealthEventFlushBuffer,
  setHealthEventBuffer,
  healthEventBuffer,
  type HealthEventRow,
} from "../../src/persistence/health-event-flush";

function row(id: string): HealthEventRow {
  return {
    entityKind: "account",
    accountId: id,
    fromStatus: "active",
    toStatus: "cooldown",
    reason: "upstream 429",
    errorCategory: "rate_limit_transient",
    modelId: null,
    createdAt: new Date(),
  };
}

/** Collects what the buffer would write, without a database. */
function sink(): {
  db: unknown;
  written: HealthEventRow[][];
  failNext: () => void;
} {
  const written: HealthEventRow[][] = [];
  let fail = false;
  const db = {
    insert: () => ({
      values: async (rows: HealthEventRow[]): Promise<void> => {
        if (fail) throw new Error("db down");
        written.push(rows);
      },
    }),
  };
  return { db: db as unknown, written, failNext: () => (fail = true) };
}

describe("HealthEventFlushBuffer", () => {
  test("enqueue does not write", async () => {
    const s = sink();
    const buffer = new HealthEventFlushBuffer(s.db as never, 60_000);
    buffer.enqueue(row("a1"));
    buffer.enqueue(row("a2"));
    expect(s.written).toHaveLength(0);
    await buffer.stop();
  });

  test("a flush writes everything queued in one batch", async () => {
    const s = sink();
    const buffer = new HealthEventFlushBuffer(s.db as never, 60_000);
    buffer.enqueue(row("a1"));
    buffer.enqueue(row("a2"));
    await buffer.flush();
    expect(s.written).toHaveLength(1);
    expect(s.written[0]).toHaveLength(2);
    await buffer.stop();
  });

  test("a failed flush drops the batch instead of retrying forever", async () => {
    const s = sink();
    const buffer = new HealthEventFlushBuffer(s.db as never, 60_000);
    buffer.enqueue(row("a1"));
    s.failNext();
    // Must not throw and must not retry: an audit write can never fail a
    // request or re-enter the dispatch retry path.
    await expect(buffer.flush()).resolves.toBeUndefined();
    expect(s.written).toHaveLength(0);
    // The batch was drained before the failed insert, so it is gone rather
    // than retried — the second flush has nothing to write.
    await buffer.flush();
    expect(s.written).toHaveLength(0);
    await buffer.stop();
  });

  test("the queue is bounded and counts what it dropped", async () => {
    const s = sink();
    const buffer = new HealthEventFlushBuffer(s.db as never, 60_000);
    for (let i = 0; i < 2_050; i += 1) buffer.enqueue(row(`a${i}`));
    // 2000 cap, so 50 dropped.
    expect(buffer.droppedCount).toBe(50);
    await buffer.stop();
  });

  test("stop drains what remains", async () => {
    const s = sink();
    const buffer = new HealthEventFlushBuffer(s.db as never, 60_000);
    buffer.enqueue(row("a1"));
    await buffer.stop();
    expect(s.written).toHaveLength(1);
    expect(s.written[0]).toHaveLength(1);
  });
});

describe("the buffer is optional", () => {
  test("absent by default, so writes stay synchronous", () => {
    // Tests that assert a health row landed rely on the synchronous path.
    expect(healthEventBuffer()).toBeUndefined();
  });

  test("installed and removable", () => {
    const s = sink();
    const buffer = new HealthEventFlushBuffer(s.db as never, 60_000);
    setHealthEventBuffer(buffer);
    expect(healthEventBuffer()).toBe(buffer);
    setHealthEventBuffer(undefined);
    expect(healthEventBuffer()).toBeUndefined();
  });
});
