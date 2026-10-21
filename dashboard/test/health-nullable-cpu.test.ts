/**
 * One unavailable metric must not invalidate the whole health payload.
 *
 * `cpu_percent` is `null` on Windows: there is no `loadavg` there and Node
 * returns a zeroed tuple rather than failing. Validated as a plain number, a
 * null rejected the *entire* response, so every tile on the runtime panel —
 * uptime, RSS, runtime, platform, and CPU alike — read "Unavailable" because of
 * one number the platform cannot supply. That is what this pins.
 *
 * Asserted through the same function the shell's health query runs, so a shape
 * that would blank the panel is rejected here instead of at render time.
 */
import { describe, expect, test } from "bun:test";
import { assertSystemHealth } from "../src/data/assert";

const BASE_HEALTH: Record<string, unknown> = {
  version: "2.5.2",
  status: "healthy",
  uptime_seconds: 120,
  database_healthy: true,
  redis_healthy: true,
  redis_configured: false,
  database_in_process: true,
  memory_heap_bytes: 1024,
  memory_external_bytes: 2048,
  memory_bytes: 4096,
  memory_percent: 0.02,
  cpu_cores: 16,
  pid: 1234,
  platform: "win32",
  request_count: 3,
  error_count: 0,
  latency_avg_ms: 12,
  latency_p95_ms: 20,
  latency_p99_ms: 30,
  cache_hit_rate_percent: 0,
  avg_tokens_per_sec: 0,
};

describe("system health validation", () => {
  test("a null cpu_percent is accepted", () => {
    // Windows: the metric is genuinely unavailable, and the rest of the panel
    // must still render.
    const parsed = assertSystemHealth({ ...BASE_HEALTH, cpu_percent: null });
    expect(parsed.cpu_percent).toBeNull();
    expect(parsed.uptime_seconds).toBe(120);
    expect(parsed.memory_bytes).toBe(4096);
  });

  test("a real zero load is accepted and stays zero", () => {
    // An idle machine has nothing queued; that is a measurement, not an
    // absence, and must not be reported as unavailable.
    expect(assertSystemHealth({ ...BASE_HEALTH, cpu_percent: 0 }).cpu_percent).toBe(0);
  });

  test("a reported load is accepted", () => {
    expect(assertSystemHealth({ ...BASE_HEALTH, cpu_percent: 12.5 }).cpu_percent).toBe(12.5);
  });

  test("a non-numeric cpu_percent is still rejected", () => {
    // Nullable, not permissive: a string or NaN fails the same way any other
    // bad field does.
    for (const bad of ["12", Number.NaN, undefined]) {
      expect(() => assertSystemHealth({ ...BASE_HEALTH, cpu_percent: bad })).toThrow();
    }
  });

  test("a missing memory figure still rejects the payload", () => {
    // The regression the other way: making one field nullable must not loosen
    // the rest.
    const { memory_bytes, ...withoutMemory } = BASE_HEALTH;
    expect(() => assertSystemHealth({ ...withoutMemory, cpu_percent: null })).toThrow();
  });
});
