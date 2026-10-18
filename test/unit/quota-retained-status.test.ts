/**
 * A retained quota reading is a real answer, not a failure.
 *
 * `setCachedQuota` keeps the last successful reading and records a later failed
 * attempt as `refreshError`, so one transient timeout does not throw away a
 * quota the provider actually reported. `toQuotaView` read `refreshError` as
 * *the* error, which collapsed that distinction: an account whose quota is
 * genuinely 0 — a perfectly valid free-plan answer — flipped to "quota
 * unreachable" the moment any later fetch timed out, and stayed there while the
 * sweep retried. The operator saw a provider as unreachable when the last real
 * answer said "0 credits".
 *
 * These drive the two real modules in sequence (cache write, then view
 * projection), so the proof is the status the dashboard renders.
 */
import { describe, expect, test } from "bun:test";
import { getCachedQuotaEntry, setCachedQuota } from "../../src/console/quota/cache";
import { toQuotaView } from "../../src/console/quota/quota-view";
import type { ProviderQuotaResult } from "../../src/providers/quota/quota-contracts";

/** One quota result as the cache stores it. */
type QuotaFixture = ProviderQuotaResult;

/** A successful reading whose answer is "0 credits" — valid for a free plan. */
const READING: QuotaFixture = {
  source: "cb",
  plan: "Free Plan Subscription",
  windows: [
    {
      kind: "credits",
      label: "Total credits",
      accounting: "independent",
      limit: 0,
      remaining: 0,
      used: 0,
      usedPercent: 100,
      remainingPercent: 0,
      resetsAt: null,
    },
  ],
  error: null,
};

/** A transient failure: our egress timed out, the provider said nothing. */
const TIMED_OUT: QuotaFixture = {
  source: "cb",
  plan: null,
  windows: [],
  error: "The operation timed out.",
};

/**
 * Writes the given results in order, advancing the clock by `plusMs` each time,
 * and returns the view the dashboard would render.
 */
async function renderAfter(
  steps: readonly { readonly body: typeof READING; readonly plusMs: number }[],
): Promise<ReturnType<typeof toQuotaView>> {
  const accountId = `acc-${Math.random().toString(16).slice(2)}`;
  let clock = Date.now();
  for (const step of steps) {
    clock += step.plusMs;
    await setCachedQuota("global", accountId, step.body, undefined, new Date(clock));
  }
  const entry = await getCachedQuotaEntry("global", accountId, undefined);
  if (!entry) throw new Error("expected a cached entry");
  return toQuotaView(entry.quota, { lastSuccessAt: null }, {
    fetchedAt: entry.fetchedAt,
    lastAttemptAt: entry.lastAttemptAt,
    refreshError: entry.refreshError,
  });
}

describe("toQuotaView — a transient failure does not erase a real reading", () => {
  test("a 0-credit reading stays ready after a later timeout", async () => {
    // The regression: this is the card that flipped to "quota unreachable".
    const view = await renderAfter([
      { body: READING, plusMs: 0 },
      { body: TIMED_OUT, plusMs: 5 * 60_000 },
    ]);
    expect(view.status).toBe("ready");
    expect(view.error).toBeNull();
    // The reading itself is the one the provider gave, not an empty window list.
    expect(view.windows).toHaveLength(1);
  });

  test("the failed attempt is still surfaced, in its own field", async () => {
    // Not swallowed: the operator must still see that the last attempt failed.
    const view = await renderAfter([
      { body: READING, plusMs: 0 },
      { body: TIMED_OUT, plusMs: 5 * 60_000 },
    ]);
    expect(view.refreshError).toBe("The operation timed out.");
  });

  test("a failure with no usable reading is still an error", async () => {
    // The case that must stay an error: nothing was ever read successfully.
    const view = await renderAfter([{ body: TIMED_OUT, plusMs: 0 }]);
    expect(view.status).toBe("error");
    expect(view.error).toBe("The operation timed out.");
  });

  test("a reading older than the retention window is finally replaced", async () => {
    // Past MAX_STALE_QUOTA_AGE_MS (30 min) the stale answer is no longer good
    // enough to show, so the failure legitimately becomes the state.
    const view = await renderAfter([
      { body: READING, plusMs: 0 },
      { body: TIMED_OUT, plusMs: 45 * 60_000 },
    ]);
    expect(view.status).toBe("error");
  });

  test("a success alone is ready", async () => {
    const view = await renderAfter([{ body: READING, plusMs: 0 }]);
    expect(view.status).toBe("ready");
    expect(view.refreshError).toBeNull();
  });
});
