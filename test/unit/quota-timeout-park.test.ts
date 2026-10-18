/**
 * A quota fetch that timed out must not push an account toward the park.
 *
 * `recordAccountCheck` counted every failed check into `consecutiveFailures`
 * and parked the row for six hours at `QUOTA_FAILURE_PARK_THRESHOLD` (3). A
 * timeout is evidence about *our* egress, not about the credential — the
 * upstream may never have seen the request — so three slow passes parked a
 * perfectly healthy account. The buddy family hit it hardest: its quota and
 * check-in legs share one pass and rotate egress per account, so one slow pool
 * produced three timeouts in a row.
 *
 * These drive `recordAccountCheck` with a statement-capturing double, so the
 * proof is exactly which values reach `.set()`.
 */
import { describe, expect, test } from "bun:test";
import { recordAccountCheck } from "../../src/console/quota/refresh";
import type { CartethyiaDatabase } from "../../src/persistence/db-handle";

interface Captured {
  readonly updates: Record<string, unknown>[];
}

/**
 * A drizzle-shaped double whose `consecutiveFailures` counter is real, so the
 * threshold the production code reads behaves the way the row would.
 */
function dbDouble(startingFailures = 0): { db: CartethyiaDatabase; captured: Captured } {
  const updates: Record<string, unknown>[] = [];
  let counter = startingFailures;
  const client = {
    update: () => ({
      set: (payload: Record<string, unknown>) => {
        updates.push(payload);
        // Drizzle's `.where(...)` is both awaitable and chainable. A plain
        // object carrying `returning` works for the failure path, and awaiting
        // a non-promise value is a no-op — so the success path is satisfied too.
        return {
          where: () => ({
            returning: async () => {
              if (payload.consecutiveFailures !== undefined) {
                counter += 1;
                return [{ consecutiveFailures: counter }];
              }
              return [];
            },
          }),
        };
      },
    }),
  };
  return {
    db: { ...client } as unknown as CartethyiaDatabase,
    captured: { updates },
  };
}

const TIMEOUT = "The operation timed out.";

/** Whether any captured statement parked the account. */
function parked(captured: Captured): boolean {
  return captured.updates.some((update) => update.status === "cooldown");
}

/** Whether any captured statement advanced the failure streak. */
function counted(captured: Captured): boolean {
  return captured.updates.some((update) => update.consecutiveFailures !== undefined);
}

describe("recordAccountCheck — a timeout is not evidence about the account", () => {
  test("three consecutive timeouts never park the account", async () => {
    // The regression: a clean account was parked for six hours after three
    // slow quota passes, with nothing wrong with its credential.
    const { db, captured } = dbDouble(0);
    for (let i = 0; i < 3; i += 1) {
      await recordAccountCheck(db, "acc-1", {
        ok: false,
        error: TIMEOUT,
        category: "quota_fetch_failed",
      });
    }
    expect(parked(captured)).toBe(false);
    expect(counted(captured)).toBe(false);
  });

  test("a timeout on the brink of the threshold does not park either", async () => {
    // Two real refusals, then one timeout: the timeout must not be the third
    // strike that takes a struggling-but-valid account out of rotation.
    const { db, captured } = dbDouble(2);
    await recordAccountCheck(db, "acc-1", {
      ok: false,
      error: TIMEOUT,
      category: "quota_fetch_failed",
    });
    expect(parked(captured)).toBe(false);
  });

  test("a real refusal still counts and still parks at the threshold", async () => {
    // The behavior that must survive: a quota surface that genuinely refuses
    // three times is an account problem and is taken out of rotation.
    const { db, captured } = dbDouble(2);
    await recordAccountCheck(db, "acc-1", {
      ok: false,
      error: "insufficient_quota: quota exhausted",
      category: "quota_fetch_failed",
    });
    expect(counted(captured)).toBe(true);
    expect(parked(captured)).toBe(true);
  });

  test("a timeout is still reported on the row", async () => {
    // Not counted, but not swallowed: the operator must still see why the last
    // refresh failed.
    const { db, captured } = dbDouble(0);
    await recordAccountCheck(db, "acc-1", {
      ok: false,
      error: TIMEOUT,
      category: "quota_fetch_failed",
    });
    const written = captured.updates[0]!;
    expect(written.lastError).toBe(TIMEOUT);
    expect(written.lastErrorCategory).toBe("quota_fetch_failed");
  });

  test("a success still clears the streak", async () => {
    const { db, captured } = dbDouble(5);
    await recordAccountCheck(db, "acc-1", { ok: true });
    expect(captured.updates[0]!.consecutiveFailures).toBe(0);
  });
});
