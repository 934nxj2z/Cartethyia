import { describe, expect, test } from "bun:test";
import { clampedEffortOutputFloor } from "../../src/providers/provider-reasoning";

describe("clamped effort output floor", () => {
  test("an effort clamped upward earns a bigger budget", () => {
    expect(clampedEffortOutputFloor("low", "high", 64_000)).toBe(32_000);
  });

  test("an effort clamped downward earns one too", () => {
    // The caller sized `max_tokens` for the effort it asked for. A `max`
    // request clamped to `high` is still a `high` level reasoning out of that
    // same budget, so the mismatch costs tokens whichever way it points.
    expect(clampedEffortOutputFloor("max", "high", 64_000)).toBe(32_000);
    expect(clampedEffortOutputFloor("xhigh", "low", 64_000)).toBe(32_000);
  });

  test("an effort served exactly as asked earns nothing", () => {
    expect(clampedEffortOutputFloor("low", "low", 64_000)).toBeUndefined();
    expect(clampedEffortOutputFloor("high", "high", 64_000)).toBeUndefined();
    expect(clampedEffortOutputFloor("max", "max", 64_000)).toBeUndefined();
  });

  test("the floor is half the declared limit once that clears the minimum", () => {
    expect(clampedEffortOutputFloor("low", "high", 200_000)).toBe(100_000);
    expect(clampedEffortOutputFloor("low", "high", 1_000_000)).toBe(500_000);
    expect(clampedEffortOutputFloor("low", "high", 64_000)).toBe(32_000);
  });

  test("a small declared limit still yields a usable floor", () => {
    // Half of a tiny limit would still truncate; the floor is the useful
    // minimum instead.
    expect(clampedEffortOutputFloor("low", "high", 4_000)).toBe(16_384);
  });

  test("an unknown level or missing limit yields no floor", () => {
    expect(clampedEffortOutputFloor("low", "banana", 64_000)).toBeUndefined();
    expect(clampedEffortOutputFloor(undefined, "high", 64_000)).toBeUndefined();
    expect(clampedEffortOutputFloor("low", "high", undefined)).toBeUndefined();
    expect(clampedEffortOutputFloor("low", "high", 0)).toBeUndefined();
  });

  test("comparison is case and whitespace insensitive", () => {
    expect(clampedEffortOutputFloor(" LOW ", "High", 64_000)).toBe(32_000);
  });
});
