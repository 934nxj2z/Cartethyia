/**
 * `mapWithConcurrency` keeps a fixed number of requests in flight.
 *
 * A bulk "Test all" that fires every account at once is a burst the provider's
 * own quota endpoint rate-limits — which failed accounts that pass individually,
 * and read as broken accounts rather than as the operator's own fan-out.
 */
import { describe, expect, test } from "bun:test";
import { mapWithConcurrency } from "../src/lib/concurrency";

describe("mapWithConcurrency", () => {
  test("returns every result in input order", async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await mapWithConcurrency(items, 2, async (n) => n * 10);
    expect(results.map((r) => (r.status === "fulfilled" ? r.value : "rejected"))).toEqual([
      10, 20, 30, 40, 50,
    ]);
  });

  test("never exceeds the limit in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 12 }, (_, i) => i);
    await mapWithConcurrency(items, 3, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  test("a rejected item does not abort the rest", async () => {
    const results = await mapWithConcurrency([1, 2, 3], 1, async (n) => {
      if (n === 2) throw new Error("boom");
      return n;
    });
    expect(results[0]).toEqual({ status: "fulfilled", value: 1 });
    expect(results[1]?.status).toBe("rejected");
    expect(results[2]).toEqual({ status: "fulfilled", value: 3 });
  });

  test("an empty list resolves without running a worker", async () => {
    let ran = 0;
    const results = await mapWithConcurrency([], 4, async () => {
      ran += 1;
    });
    expect(results).toEqual([]);
    expect(ran).toBe(0);
  });

  test("a limit above the item count still runs every item once", async () => {
    const seen: number[] = [];
    await mapWithConcurrency([1, 2], 10, async (n) => {
      seen.push(n);
    });
    expect(seen.sort()).toEqual([1, 2]);
  });
});
