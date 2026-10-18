/**
 * Slow-lane capacity-wait retry planning (design doc §5).
 *
 * The properties that matter: a capacity wait retries the SAME account and is
 * not a failure; a lane that has ended must not spin; and the wait is bounded
 * so a long-running lane cannot exceed the request's patience.
 */
import { describe, expect, test } from "bun:test";
import {
  isOverloadedFailure,
  planSlowLaneRetry,
  type SlowLaneFailureObservation,
} from "../../src/providers/integrations/claude/claude-slow-lane-retry";
import { ClaudeSlowLanes } from "../../src/providers/integrations/claude/claude-slow-lane";

function activeLane(accountId: string): ClaudeSlowLanes {
  const lanes = new ClaudeSlowLanes();
  lanes.observe(accountId, {
    offer: "treatment",
    status: "active",
    unifiedLimitClaim: false,
    overageInUse: false,
    unifiedResetAtSec: Math.floor(Date.now() / 1000) + 3600,
  });
  return lanes;
}

const slotBusy: SlowLaneFailureObservation = {
  sentSlow: true,
  waitedMs: 0,
  attempts: 0,
  headers: {
    status: "slot_busy",
    retryAfterMs: 20_000,
    maxWaitMs: 600_000,
    unifiedLimitClaim: false,
    overageInUse: false,
  },
};

describe("isOverloadedFailure", () => {
  test("529 is overloaded", () => {
    expect(isOverloadedFailure({ ...slotBusy, httpStatus: 529 })).toBe(true);
  });

  test("an overloaded_error body is overloaded", () => {
    expect(
      isOverloadedFailure({ ...slotBusy, message: '{"type":"error","error":{"type":"overloaded_error"}}' }),
    ).toBe(true);
  });

  test("an ordinary 429 is not overloaded by itself", () => {
    expect(isOverloadedFailure({ ...slotBusy, httpStatus: 429, message: "rate limited" })).toBe(false);
  });
});

describe("planSlowLaneRetry", () => {
  test("slot_busy while slow was sent retries the same account", () => {
    const lanes = activeLane("acct-1");
    const decision = planSlowLaneRetry(slotBusy, lanes, "acct-1");
    expect(decision?.capacityWait).toBe(true);
    expect(decision?.delayMs).toBe(20_000);
  });

  test("a request that did NOT send the slow header never waits", () => {
    // Without the slow header the account is not in the lane, so waiting is
    // latency with no capacity behind it.
    const lanes = activeLane("acct-1");
    expect(planSlowLaneRetry({ ...slotBusy, sentSlow: false }, lanes, "acct-1")).toBeNull();
  });

  test("an account with no active lane never waits", () => {
    const lanes = new ClaudeSlowLanes();
    expect(planSlowLaneRetry(slotBusy, lanes, "unknown")).toBeNull();
  });

  test("a 529 while slow waits even without a slow status header", () => {
    const lanes = activeLane("acct-1");
    const decision = planSlowLaneRetry(
      { sentSlow: true, waitedMs: 0, attempts: 0, httpStatus: 529 },
      lanes,
      "acct-1",
    );
    expect(decision?.capacityWait).toBe(true);
    expect(decision?.delayMs).toBeGreaterThan(0);
  });

  test("a terminal lane status ends the lane rather than spinning", () => {
    const lanes = activeLane("acct-1");
    for (const status of ["weekly_limit", "budget_exhausted", "off", "ineligible"] as const) {
      expect(
        planSlowLaneRetry(
          {
            ...slotBusy,
            headers: { ...slotBusy.headers!, status },
          },
          lanes,
          "acct-1",
        ),
      ).toBeNull();
    }
  });

  test("the wait is bounded by the server's max-wait", () => {
    const lanes = activeLane("acct-1");
    expect(
      planSlowLaneRetry({ ...slotBusy, waitedMs: 610_000 }, lanes, "acct-1"),
    ).toBeNull();
  });

  test("the last wait is clamped to what the budget has left", () => {
    const lanes = activeLane("acct-1");
    // 590s spent of a 600s budget: a stated 20s wait must be trimmed to 10s
    // rather than overshooting the budget.
    const decision = planSlowLaneRetry({ ...slotBusy, waitedMs: 590_000 }, lanes, "acct-1");
    expect(decision?.delayMs).toBe(10_000);
  });

  test("an already-exhausted budget returns no retry", () => {
    const lanes = activeLane("acct-1");
    expect(planSlowLaneRetry({ ...slotBusy, waitedMs: 600_000 }, lanes, "acct-1")).toBeNull();
  });

  test("a non-capacity failure (ordinary 429, no slow status) is left to the normal path", () => {
    const lanes = activeLane("acct-1");
    expect(
      planSlowLaneRetry(
        { sentSlow: true, waitedMs: 0, attempts: 0, httpStatus: 429, message: "rate limited" },
        lanes,
        "acct-1",
      ),
    ).toBeNull();
  });
});
