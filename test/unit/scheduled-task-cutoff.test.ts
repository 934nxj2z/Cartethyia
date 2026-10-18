/**
 * `CARTETHYIA_DISABLED_TASKS` — switching a periodic maintenance task off.
 *
 * The audit found the heaviest steady-state costs in this process are the
 * scheduled sweeps (quota refresh does real upstream traffic every minute; the
 * OAuth sweep scans 2000 rows a minute; client-version polling fetches ~30
 * external URLs). None had a disable flag, so the only way to stop one was to
 * edit code.
 *
 * The gate lives in the registry rather than at each call site so one config
 * row covers every task instead of twelve flags.
 */
import { afterEach, describe, expect, test, vi } from "bun:test";
import { ScheduledTaskRegistry } from "../../src/workers/scheduler";

afterEach(() => {
  vi.useRealTimers();
});

/** A task that records each tick, so a disabled one is provably silent. */
function countingTask(name: string, onRun: () => void): {
  readonly name: string;
  readonly intervalMs: number;
  run(): void;
} {
  return { name, intervalMs: 10, run: () => onRun() };
}

describe("ScheduledTaskRegistry disabled tasks", () => {
  test("a disabled task never runs", () => {
    vi.useFakeTimers();
    let ran = 0;
    const registry = new ScheduledTaskRegistry(["noisy-sweep"]);
    registry.register(countingTask("noisy-sweep", () => (ran += 1)));
    registry.start();
    vi.advanceTimersByTime(200);
    expect(ran).toBe(0);
    registry.stop();
  });

  test("a disabled task cannot be forced with runNow", async () => {
    let ran = 0;
    const registry = new ScheduledTaskRegistry(["noisy-sweep"]);
    registry.register(countingTask("noisy-sweep", () => (ran += 1)));
    // Manual triggers must respect the same switch: an operator who cut a
    // sweep because it was expensive should not be able to reintroduce the
    // cost by clicking a button.
    await registry.runNow("noisy-sweep");
    expect(ran).toBe(0);
  });

  test("other tasks keep running", () => {
    vi.useFakeTimers();
    let quiet = 0;
    let loud = 0;
    const registry = new ScheduledTaskRegistry(["quiet-sweep"]);
    registry.register(countingTask("quiet-sweep", () => (quiet += 1)));
    registry.register(countingTask("loud-sweep", () => (loud += 1)));
    registry.start();
    vi.advanceTimersByTime(200);
    expect(quiet).toBe(0);
    expect(loud).toBeGreaterThan(0);
    registry.stop();
  });

  test("an unknown name disables nothing", () => {
    vi.useFakeTimers();
    let ran = 0;
    const registry = new ScheduledTaskRegistry(["typo-sweep"]);
    registry.register(countingTask("real-sweep", () => (ran += 1)));
    registry.start();
    vi.advanceTimersByTime(200);
    expect(ran).toBeGreaterThan(0);
    registry.stop();
  });
});
