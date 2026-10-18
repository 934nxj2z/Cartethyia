/**
 * The usage summary carries the sample count behind each latency figure.
 *
 * The latency row on the Usage page shows a resolve average and P50/P95/P99.
 * Without a count, a percentile over twenty requests and one over twenty
 * thousand look identical on screen, and the reader cannot tell whether the
 * figure is a percentile or just the slowest request that happened to arrive.
 *
 * These pin the two counts through the same assertion the page's query runs,
 * so a response missing them is rejected at the boundary rather than rendered
 * as zero.
 */
import { describe, expect, test } from "bun:test";
import { assertUsageSummary } from "../src/data/assert";

const BASE_TOTALS: Record<string, unknown> = {
  requests: 100,
  inputTokens: 1,
  cachedTokens: 0,
  outputTokens: 1,
  errors: 0,
  cancelled: 0,
  truncated: 0,
  avgResolveMs: 1,
  avgDurationMs: 1,
  latencyP50Ms: 1,
  latencyP95Ms: 1,
  latencyP99Ms: 1,
  latencySampleCount: 100,
  resolveSampleCount: 98,
  estimatedCostUsd: 0,
  cacheHitRate: 0,
  partial: false,
  statusCounts: [{ status: 200, count: 100 }],
};

function summaryWith(totals: Record<string, unknown>): unknown {
  return { period: "24h", totals: { ...BASE_TOTALS, ...totals } };
}

/** A summary with one field genuinely absent, rather than defaulted. */
function summaryWithout(field: string): unknown {
  const totals: Record<string, unknown> = { ...BASE_TOTALS };
  delete totals[field];
  return { period: "24h", totals };
}

describe("assertUsageSummary sample counts", () => {
  test("accepts a response carrying both counts", () => {
    const parsed = assertUsageSummary(summaryWith({}));
    expect(parsed.totals.latencySampleCount).toBe(100);
    expect(parsed.totals.resolveSampleCount).toBe(98);
  });

  test("zero counts are valid — an empty period, not a broken response", () => {
    const parsed = assertUsageSummary(summaryWith({ latencySampleCount: 0, resolveSampleCount: 0 }));
    expect(parsed.totals.latencySampleCount).toBe(0);
  });

  test("rejects a response missing the latency count", () => {
    // The regression: an older backend omits it, and "0 requests" would be
    // rendered as confidently as "20,000 requests".
    expect(() => assertUsageSummary(summaryWithout("latencySampleCount"))).toThrow();
  });

  test("rejects a response missing the resolve count", () => {
    expect(() => assertUsageSummary(summaryWithout("resolveSampleCount"))).toThrow();
  });

  test("rejects a non-numeric count", () => {
    expect(() => assertUsageSummary(summaryWith({ latencySampleCount: "100" }))).toThrow();
  });
});
