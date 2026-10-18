import { expect, test } from "bun:test";
import { summarizeUsagePerformance } from "../../src/console/observability/store";

test("usage performance reports routing average and P50/P95/P99 latency", () => {
  const events = Array.from({ length: 100 }, (_, index) => ({
    latencyMs: index + 1,
    resolveMs: index === 1 ? 100 : index === 2 ? 300 : null,
  }));

  expect(summarizeUsagePerformance(events)).toEqual({
    avgResolveMs: 200,
    avgDurationMs: 50.5,
    latencyP50Ms: 50,
    latencyP95Ms: 95,
    latencyP99Ms: 99,
    // Every row carries a latency; only two carry a resolve measurement.
    latencySampleCount: 100,
    resolveSampleCount: 2,
  });
});

test("usage performance returns zero metrics when the period has no events", () => {
  expect(summarizeUsagePerformance([])).toEqual({
    avgResolveMs: 0,
    avgDurationMs: 0,
    latencyP50Ms: 0,
    latencyP95Ms: 0,
    latencyP99Ms: 0,
    latencySampleCount: 0,
    resolveSampleCount: 0,
  });
});

test("the sample count is what separates a meaningful P99 from a guess", () => {
  // Three rows make P99 the slowest request, not a percentile. The count is
  // the only thing in the payload that says so.
  const events = [
    { latencyMs: 10, resolveMs: null },
    { latencyMs: 20, resolveMs: null },
    { latencyMs: 900, resolveMs: null },
  ];
  const summary = summarizeUsagePerformance(events);
  expect(summary.latencyP99Ms).toBe(900);
  expect(summary.latencySampleCount).toBe(3);
  expect(summary.resolveSampleCount).toBe(0);
});
