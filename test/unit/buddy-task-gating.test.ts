/**
 * The six buddy growth tasks are registered by name, so an operator can switch
 * any one of them off with `CARTETHYIA_DISABLED_TASKS` without touching the
 * others.
 *
 * The gate itself lives in `ScheduledTaskRegistry` and is already pinned by
 * `scheduled-task-cutoff.test.ts`. What is *not* pinned anywhere is the contract
 * the names depend on: that every task dependencies.ts registers is addressed by
 * a name in `BUDDY_TASK_NAMES`, so a rename or a typo silently produces a task
 * nobody can switch off.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BUDDY_TASK_NAMES } from "../../src/workers/buddy-growth-tasks";
import { ScheduledTaskRegistry } from "../../src/workers/scheduler";

const REGISTERED = [
  "buddy-streak",
  "buddy-redeem",
  "buddy-lottery",
  "buddy-travel",
  "buddy-adopt",
  "buddy-trial",
];

describe("the buddy growth tasks are individually switchable", () => {
  test("every registered name is one the switch list knows", () => {
    // A task registered under a name outside this list cannot be switched off,
    // which is the whole point of one task per capability.
    for (const name of REGISTERED) {
      expect(BUDDY_TASK_NAMES as readonly string[]).toContain(name);
    }
  });

  test("dependencies.ts registers each one exactly once", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src", "boot", "dependencies.ts"),
      "utf8",
    );
    for (const name of REGISTERED) {
      const hits = source.split(`name: "${name}"`).length - 1;
      expect(hits).toBe(1);
    }
  });

  test("a disabled task never runs while its siblings do", async () => {
    const registry = new ScheduledTaskRegistry(["buddy-streak", "buddy-travel"]);
    const runs: Record<string, number> = {};
    for (const name of REGISTERED) {
      registry.register({
        name,
        intervalMs: 5,
        run: () => {
          runs[name] = (runs[name] ?? 0) + 1;
        },
      });
    }
    registry.start();
    await new Promise((done) => setTimeout(done, 60));
    await registry.stop();
    // The two switched off are absent entirely — no timer, no run.
    expect(runs["buddy-streak"]).toBeUndefined();
    expect(runs["buddy-travel"]).toBeUndefined();
    expect(runs["buddy-redeem"]).toBeGreaterThan(0);
    expect(runs["buddy-lottery"]).toBeGreaterThan(0);
    expect(runs["buddy-adopt"]).toBeGreaterThan(0);
    expect(runs["buddy-trial"]).toBeGreaterThan(0);
  });
});
