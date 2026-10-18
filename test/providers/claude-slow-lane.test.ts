/**
 * Header-parse unit for the Claude slow lane (design doc §7 item 1) plus the
 * §3 lane registry: table over all eight statuses + unrecognized,
 * seconds→ms conversion, utilization clamp, past-dated resets dropped,
 * `undefined` when no slow/unified headers.
 *
 * No network, no environment mutation.
 */
import { describe, expect, test } from "bun:test";
import {
  ClaudeSlowLanes,
  classifyClaudeSlowStatus,
  parseClaudeSlowHeaders,
  type ClaudeSlowSignal,
  type ClaudeSlowStatus,
} from "../../src/providers/integrations/claude/claude-slow-lane";

/** Fixed clock so "past-dated" is deterministic. */
const NOW_MS = 1_700_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);
const FUTURE_SEC = NOW_SEC + 3_600;

function headers(entries: Record<string, string>): Record<string, string | undefined> {
  return entries;
}

// ─── A. Status table ───────────────────────────────────────────────────────

describe("A. status parsing", () => {
  const cases: Array<{ raw: string; expected: ClaudeSlowStatus }> = [
    { raw: "active", expected: "active" },
    { raw: "not_needed", expected: "not_needed" },
    { raw: "slot_busy", expected: "slot_busy" },
    { raw: "weekly_limit", expected: "weekly_limit" },
    { raw: "budget_exhausted", expected: "budget_exhausted" },
    { raw: "ineligible", expected: "ineligible" },
    { raw: "off", expected: "off" },
    { raw: "unrecognized", expected: "unrecognized" },
  ];

  test("all eight statuses map through verbatim", () => {
    for (const { raw, expected } of cases) {
      const signal = parseClaudeSlowHeaders(
        headers({ "anthropic-ratelimit-unified-slow-status": raw }),
        { nowMs: NOW_MS },
      );
      expect(signal?.status).toBe(expected);
    }
  });

  test("an unknown status string collapses to `unrecognized`", () => {
    const signal = parseClaudeSlowHeaders(
      headers({ "anthropic-ratelimit-unified-slow-status": "wat_is_this" }),
      { nowMs: NOW_MS },
    );
    expect(signal?.status).toBe("unrecognized");
  });

  test("status casing is normalized", () => {
    const signal = parseClaudeSlowHeaders(
      headers({ "anthropic-ratelimit-unified-slow-status": "Slot_Busy" }),
      { nowMs: NOW_MS },
    );
    expect(signal?.status).toBe("slot_busy");
  });
});

// ─── B. Offer, claim, overage, grace ───────────────────────────────────────

describe("B. offer / claim / overage / grace", () => {
  test("treatment and control offers parse; junk does not", () => {
    expect(
      parseClaudeSlowHeaders(
        headers({ "anthropic-ratelimit-unified-slow-offer": "treatment" }),
        { nowMs: NOW_MS },
      )?.offer,
    ).toBe("treatment");
    expect(
      parseClaudeSlowHeaders(
        headers({ "anthropic-ratelimit-unified-slow-offer": "control" }),
        { nowMs: NOW_MS },
      )?.offer,
    ).toBe("control");
    expect(
      parseClaudeSlowHeaders(
        headers({ "anthropic-ratelimit-unified-slow-offer": "maybe" }),
        { nowMs: NOW_MS },
      )?.offer,
    ).toBeUndefined();
  });

  test("representative-claim header sets unifiedLimitClaim", () => {
    const signal = parseClaudeSlowHeaders(
      headers({ "anthropic-ratelimit-unified-representative-claim": "true" }),
      { nowMs: NOW_MS },
    );
    expect(signal?.unifiedLimitClaim).toBe(true);
    expect(signal?.overageInUse).toBe(false);
  });

  test("a named overage-status also claims the unified wall", () => {
    const signal = parseClaudeSlowHeaders(
      headers({ "anthropic-ratelimit-unified-overage-status": "claimed" }),
      { nowMs: NOW_MS },
    );
    expect(signal?.unifiedLimitClaim).toBe(true);
    expect(signal?.overageAllowed).toBe(false);
  });

  test("overage-status `allowed` reports overageAllowed true", () => {
    const signal = parseClaudeSlowHeaders(
      headers({ "anthropic-ratelimit-unified-overage-status": "allowed" }),
      { nowMs: NOW_MS },
    );
    expect(signal?.overageAllowed).toBe(true);
  });

  test("overage-in-use sets overageInUse", () => {
    const signal = parseClaudeSlowHeaders(
      headers({
        "anthropic-ratelimit-unified-overage-in-use": "1",
        "anthropic-ratelimit-unified-slow-status": "active",
      }),
      { nowMs: NOW_MS },
    );
    expect(signal?.overageInUse).toBe(true);
  });

  test("grace utilization pairs are clamped and defaulted", () => {
    const signal = parseClaudeSlowHeaders(
      headers({ "anthropic-ratelimit-unified-grace-5h-utilization": "2.5" }),
      { nowMs: NOW_MS },
    );
    expect(signal?.graceUtilization).toEqual({ fiveHour: 1, sevenDay: 0 });
  });
});

// ─── C. Timing: seconds → ms, clamps, defaults ─────────────────────────────

describe("C. timing conversion and clamps", () => {
  test("retry-after seconds become ms", () => {
    const signal = parseClaudeSlowHeaders(
      headers({ "anthropic-ratelimit-unified-slow-retry-after": "30" }),
      { nowMs: NOW_MS },
    );
    expect(signal?.retryAfterMs).toBe(30_000);
  });

  test("retry-after clamps low to 5s and high to 600s", () => {
    const low = parseClaudeSlowHeaders(
      headers({ "anthropic-ratelimit-unified-slow-retry-after": "1" }),
      { nowMs: NOW_MS },
    );
    const high = parseClaudeSlowHeaders(
      headers({ "anthropic-ratelimit-unified-slow-retry-after": "9999" }),
      { nowMs: NOW_MS },
    );
    expect(low?.retryAfterMs).toBe(5_000);
    expect(high?.retryAfterMs).toBe(600_000);
  });

  test("max-wait seconds become ms and clamp to 60s..6h", () => {
    expect(
      parseClaudeSlowHeaders(
        headers({ "anthropic-ratelimit-unified-slow-max-wait": "900" }),
        { nowMs: NOW_MS },
      )?.maxWaitMs,
    ).toBe(900_000);
    expect(
      parseClaudeSlowHeaders(
        headers({ "anthropic-ratelimit-unified-slow-max-wait": "5" }),
        { nowMs: NOW_MS },
      )?.maxWaitMs,
    ).toBe(60_000);
    expect(
      parseClaudeSlowHeaders(
        headers({ "anthropic-ratelimit-unified-slow-max-wait": "99999" }),
        { nowMs: NOW_MS },
      )?.maxWaitMs,
    ).toBe(6 * 60 * 60 * 1000);
  });

  test("a non-numeric timing header yields no field rather than NaN", () => {
    const signal = parseClaudeSlowHeaders(
      headers({
        "anthropic-ratelimit-unified-slow-retry-after": "soon",
        "anthropic-ratelimit-unified-slow-max-wait": "later",
      }),
      { nowMs: NOW_MS },
    );
    expect(signal?.retryAfterMs).toBeUndefined();
    expect(signal?.maxWaitMs).toBeUndefined();
  });
});

// ─── D. Utilization clamp ──────────────────────────────────────────────────

describe("D. utilization clamp", () => {
  test("clamps into 0..1 in both directions", () => {
    const high = parseClaudeSlowHeaders(
      headers({ "anthropic-ratelimit-unified-slow-budget-utilization": "1.8" }),
      { nowMs: NOW_MS },
    );
    const low = parseClaudeSlowHeaders(
      headers({ "anthropic-ratelimit-unified-slow-budget-utilization": "-0.4" }),
      { nowMs: NOW_MS },
    );
    expect(high?.budgetUtilization).toBe(1);
    expect(low?.budgetUtilization).toBe(0);
  });

  test("a mid-range value passes through", () => {
    const signal = parseClaudeSlowHeaders(
      headers({ "anthropic-ratelimit-unified-slow-budget-utilization": "0.42" }),
      { nowMs: NOW_MS },
    );
    expect(signal?.budgetUtilization).toBeCloseTo(0.42, 10);
  });
});

// ─── E. Resets ─────────────────────────────────────────────────────────────

describe("E. resets", () => {
  test("future-dated resets are kept across all four windows", () => {
    const signal = parseClaudeSlowHeaders(
      headers({
        "anthropic-ratelimit-unified-slow-budget-reset": String(FUTURE_SEC),
        "anthropic-ratelimit-unified-reset": String(FUTURE_SEC + 1),
        "anthropic-ratelimit-unified-5h-reset": String(FUTURE_SEC + 2),
        "anthropic-ratelimit-unified-7d-reset": String(FUTURE_SEC + 3),
      }),
      { nowMs: NOW_MS },
    );
    expect(signal?.budgetResetAtSec).toBe(FUTURE_SEC);
    expect(signal?.unifiedResetAtSec).toBe(FUTURE_SEC + 1);
    expect(signal?.fiveHourResetAtSec).toBe(FUTURE_SEC + 2);
    expect(signal?.weeklyResetAtSec).toBe(FUTURE_SEC + 3);
  });

  test("past-dated resets are dropped", () => {
    const signal = parseClaudeSlowHeaders(
      headers({
        "anthropic-ratelimit-unified-slow-status": "active",
        "anthropic-ratelimit-unified-reset": String(NOW_SEC - 10),
        "anthropic-ratelimit-unified-5h-reset": String(NOW_SEC - 1),
        "anthropic-ratelimit-unified-7d-reset": "0",
        "anthropic-ratelimit-unified-slow-budget-reset": String(NOW_SEC),
      }),
      { nowMs: NOW_MS },
    );
    expect(signal?.unifiedResetAtSec).toBeUndefined();
    expect(signal?.fiveHourResetAtSec).toBeUndefined();
    expect(signal?.weeklyResetAtSec).toBeUndefined();
    expect(signal?.budgetResetAtSec).toBeUndefined();
  });
});

// ─── F. Absence ────────────────────────────────────────────────────────────

describe("F. no headers", () => {
  test("returns undefined when no slow/unified header is present", () => {
    expect(parseClaudeSlowHeaders({}, { nowMs: NOW_MS })).toBeUndefined();
    expect(
      parseClaudeSlowHeaders(
        headers({ "content-type": "application/json", "request-id": "req_1" }),
        { nowMs: NOW_MS },
      ),
    ).toBeUndefined();
  });

  test("returns undefined when the only headers present are past-dated resets", () => {
    expect(
      parseClaudeSlowHeaders(
        headers({ "anthropic-ratelimit-unified-reset": String(NOW_SEC - 5) }),
        { nowMs: NOW_MS },
      ),
    ).toBeUndefined();
  });

  test("a real Headers instance works as the source", () => {
    const h = new Headers({ "anthropic-ratelimit-unified-slow-status": "active" });
    expect(parseClaudeSlowHeaders(h, { nowMs: NOW_MS })?.status).toBe("active");
  });

  test("boolean flags default to false on a bare signal", () => {
    const signal = parseClaudeSlowHeaders(
      headers({ "anthropic-ratelimit-unified-slow-status": "active" }),
      { nowMs: NOW_MS },
    );
    expect(signal?.unifiedLimitClaim).toBe(false);
    expect(signal?.overageInUse).toBe(false);
  });
});

// ─── G. Lane registry (§3) ─────────────────────────────────────────────────

function activeSignal(overrides: Partial<ClaudeSlowSignal> = {}): ClaudeSlowSignal {
  return {
    status: "active",
    unifiedLimitClaim: false,
    overageInUse: false,
    unifiedResetAtSec: FUTURE_SEC,
    ...overrides,
  };
}

describe("G. ClaudeSlowLanes", () => {
  test("starts idle and reports inactive", () => {
    const lanes = new ClaudeSlowLanes();
    expect(lanes.lane("acct_1", NOW_MS).phase.kind).toBe("idle");
    expect(lanes.isActive("acct_1", NOW_MS)).toBe(false);
  });

  test("keys per provider_account_id", () => {
    const lanes = new ClaudeSlowLanes();
    lanes.observe("acct_1", activeSignal(), NOW_MS);
    expect(lanes.isActive("acct_1", NOW_MS)).toBe(true);
    expect(lanes.isActive("acct_2", NOW_MS)).toBe(false);
  });

  test("an active lane activates and carries its reset", () => {
    const lanes = new ClaudeSlowLanes();
    const lane = lanes.observe("acct_1", activeSignal(), NOW_MS);
    expect(lane.phase).toEqual({ kind: "active", resetsAtSec: FUTURE_SEC });
  });

  test("weekly_limit blocks until the weekly reset", () => {
    const lanes = new ClaudeSlowLanes();
    const lane = lanes.observe(
      "acct_1",
      activeSignal({ status: "weekly_limit", weeklyResetAtSec: FUTURE_SEC }),
      NOW_MS,
    );
    expect(lane.phase).toEqual({ kind: "blocked", reason: "weekly", untilSec: FUTURE_SEC });
  });

  test("budget_exhausted blocks and caps the block at 8 days", () => {
    const lanes = new ClaudeSlowLanes();
    const lane = lanes.observe(
      "acct_1",
      activeSignal({
        status: "budget_exhausted",
        budgetResetAtSec: NOW_SEC + 60 * 24 * 60 * 60,
      }),
      NOW_MS,
    );
    expect(lane.phase.kind).toBe("blocked");
    const phase = lane.phase;
    if (phase.kind !== "blocked") throw new Error("expected blocked");
    expect(phase.reason).toBe("budget");
    expect(phase.untilSec).toBe(NOW_SEC + 8 * 24 * 60 * 60);
  });

  test("terminal statuses and unrecognized end the lane", () => {
    for (const status of ["ineligible", "off", "unrecognized"] as const) {
      const lanes = new ClaudeSlowLanes();
      lanes.observe("acct_1", activeSignal(), NOW_MS);
      const lane = lanes.observe("acct_1", activeSignal({ status }), NOW_MS);
      expect(lane.phase.kind).toBe("idle");
    }
  });

  test("overage in use ends the lane", () => {
    const lanes = new ClaudeSlowLanes();
    lanes.observe("acct_1", activeSignal(), NOW_MS);
    const lane = lanes.observe("acct_1", activeSignal({ overageInUse: true }), NOW_MS);
    expect(lane.phase.kind).toBe("idle");
  });

  test("active expires at reset + 60s grace, not before", () => {
    const lanes = new ClaudeSlowLanes();
    lanes.observe("acct_1", activeSignal(), NOW_MS);
    expect(lanes.isActive("acct_1", (FUTURE_SEC + 59) * 1000)).toBe(true);
    expect(lanes.isActive("acct_1", (FUTURE_SEC + 60) * 1000)).toBe(false);
  });

  test("a blocked lane returns to idle once its deadline passes", () => {
    const lanes = new ClaudeSlowLanes();
    lanes.observe(
      "acct_1",
      activeSignal({ status: "weekly_limit", weeklyResetAtSec: FUTURE_SEC }),
      NOW_MS,
    );
    expect(lanes.lane("acct_1", (FUTURE_SEC - 1) * 1000).phase.kind).toBe("blocked");
    expect(lanes.lane("acct_1", FUTURE_SEC * 1000).phase.kind).toBe("idle");
  });

  test("cooling off lasts 10 minutes after a give-up", () => {
    const lanes = new ClaudeSlowLanes();
    lanes.observe("acct_1", activeSignal(), NOW_MS);
    lanes.coolOff("acct_1", NOW_MS);
    expect(lanes.isActive("acct_1", NOW_MS)).toBe(false);
    expect(lanes.isCoolingOff("acct_1", NOW_MS)).toBe(true);
    expect(lanes.isCoolingOff("acct_1", NOW_MS + 10 * 60 * 1000 - 1)).toBe(true);
    expect(lanes.isCoolingOff("acct_1", NOW_MS + 10 * 60 * 1000)).toBe(false);
  });

  test("a control offer drops an active lane", () => {
    const lanes = new ClaudeSlowLanes();
    lanes.observe("acct_1", activeSignal(), NOW_MS);
    const lane = lanes.observe("acct_1", activeSignal({ offer: "control" }), NOW_MS);
    expect(lane.phase.kind).toBe("idle");
    expect(lane.offer).toBe("control");
  });

  test("pacing and budget fields are retained on the lane", () => {
    const lanes = new ClaudeSlowLanes();
    const lane = lanes.observe(
      "acct_1",
      activeSignal({ retryAfterMs: 30_000, maxWaitMs: 1_200_000, budgetUtilization: 0.5 }),
      NOW_MS,
    );
    expect(lane.retryAfterMs).toBe(30_000);
    expect(lane.maxWaitMs).toBe(1_200_000);
    expect(lane.budgetUtilization).toBe(0.5);
  });

  test("clear() resets every lane (restart-equivalent)", () => {
    const lanes = new ClaudeSlowLanes();
    lanes.observe("acct_1", activeSignal(), NOW_MS);
    lanes.observe("acct_2", activeSignal(), NOW_MS);
    expect(lanes.size).toBe(2);
    lanes.clear();
    expect(lanes.size).toBe(0);
    expect(lanes.isActive("acct_1", NOW_MS)).toBe(false);
  });

  test("a fresh instance has no lanes — restart starts idle", () => {
    const lanes = new ClaudeSlowLanes();
    expect(lanes.size).toBe(0);
  });
});

describe("classifyClaudeSlowStatus", () => {
  test("slot_busy waits on the same account", () => {
    expect(classifyClaudeSlowStatus("slot_busy")).toBe("wait");
  });

  test("lane-ending statuses are terminal", () => {
    expect(classifyClaudeSlowStatus("weekly_limit")).toBe("terminal");
    expect(classifyClaudeSlowStatus("budget_exhausted")).toBe("terminal");
    expect(classifyClaudeSlowStatus("ineligible")).toBe("terminal");
    expect(classifyClaudeSlowStatus("off")).toBe("terminal");
  });

  test("serving statuses record nothing", () => {
    expect(classifyClaudeSlowStatus("active")).toBe("served");
    expect(classifyClaudeSlowStatus("not_needed")).toBe("served");
  });

  test("an unrecognized or absent status is treated as served, never as a wait", () => {
    // An unknown status that spun would hang the attempt; one that wrote
    // health would record a failure for a non-event. Both are worse than
    // letting the normal error path handle it.
    expect(classifyClaudeSlowStatus("unrecognized")).toBe("served");
    expect(classifyClaudeSlowStatus(undefined)).toBe("served");
  });

  test("only slot_busy waits — no other status does", () => {
    const all: (ClaudeSlowStatus | undefined)[] = [
      "active", "not_needed", "slot_busy", "weekly_limit",
      "budget_exhausted", "ineligible", "off", "unrecognized", undefined,
    ];
    expect(all.filter((s) => classifyClaudeSlowStatus(s) === "wait")).toEqual(["slot_busy"]);
  });
});
