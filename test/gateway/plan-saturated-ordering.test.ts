/**
 * Plan ordering accounts for concurrency that is already used up.
 *
 * The admission controller holds a per-account inflight counter and refuses an
 * account at its ceiling — but the plan order knew nothing about it, so the
 * first candidate was often one that was certain to answer 429. The caller paid
 * a round-trip to be told something the gateway already had in memory: attempt
 * one hit the saturated account, failed retryably, and only attempt two reached
 * the sibling that had room all along.
 *
 * A saturated account is now ordered behind the ones with room. It is
 * deprioritized rather than excluded, so a deployment where every account is
 * genuinely busy still dials somewhere and answers an honest 429 instead of
 * reading as "no account available" (503) for a deployment that is merely busy.
 *
 * The counters come from the real in-memory controller, filled by admitting,
 * so the test exercises the same key format admission enforces against.
 */
import { describe, expect, test } from "bun:test";
import { InMemoryAdmissionController } from "../../src/transport/routing/admission";
import { RoutingEngine } from "../../src/transport/routing/router";
import type { RouteCandidate, RouteSnapshot } from "../../src/transport/routing/route-model";

const QUALIFIED = "p/m";
const CEILING = 2;

function candidate(accountId: string, overrides: Record<string, unknown> = {}): RouteCandidate {
  return {
    provider_id: "p",
    model_id: "m",
    wire_family: "chat",
    endpoint: "/v1/chat/completions",
    capability_profile: {},
    provider_account_id: accountId,
    max_inflight: CEILING,
    ...overrides,
  } as RouteCandidate;
}

function snapshot(candidates: readonly RouteCandidate[]): RouteSnapshot {
  return { revision: 1, candidates, aliases: {}, combos: {}, created_at: Date.now() };
}

/** Fills `count` slots on one candidate, as live requests would. */
async function occupy(
  controller: InMemoryAdmissionController,
  target: RouteCandidate,
  count: number,
): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const decision = await controller.admit(target);
    if (!decision.admitted) throw new Error(`test setup: could not admit slot ${i + 1}`);
  }
}

describe("RoutingEngine.plan saturated ordering", () => {
  test("a saturated account is ordered behind one with room", async () => {
    const controller = new InMemoryAdmissionController();
    const engine = new RoutingEngine(controller);
    const full = candidate("full");
    const roomy = candidate("roomy");

    await occupy(controller, full, CEILING);

    // Input order puts the saturated account first, which is exactly the case
    // that used to spend the first attempt on it.
    const plan = await engine.plan(QUALIFIED, snapshot([full, roomy]));
    expect(plan.candidates.map((c) => c.provider_account_id)).toEqual(["roomy", "full"]);
  });

  test("an account that is merely busy, not full, keeps its place", async () => {
    // One slot of two used is not saturated; reordering it would shuffle the
    // plan for every partly-used account.
    const controller = new InMemoryAdmissionController();
    const engine = new RoutingEngine(controller);
    const busy = candidate("busy");
    const idle = candidate("idle");

    await occupy(controller, busy, CEILING - 1);

    const plan = await engine.plan(QUALIFIED, snapshot([busy, idle]));
    expect(plan.candidates.map((c) => c.provider_account_id)).toEqual(["busy", "idle"]);
  });

  test("a candidate with no ceiling is never treated as saturated", async () => {
    // Admission treats an absent ceiling as unlimited, so the ordering must not
    // invent one.
    const controller = new InMemoryAdmissionController();
    const engine = new RoutingEngine(controller);
    const unlimited = candidate("unlimited", { max_inflight: undefined });
    const roomy = candidate("roomy");

    const plan = await engine.plan(QUALIFIED, snapshot([unlimited, roomy]));
    expect(plan.candidates.map((c) => c.provider_account_id)).toEqual(["unlimited", "roomy"]);
  });

  test("when every account is saturated the request is still planned", async () => {
    // Deprioritized, not dropped: all-busy must not read as no-account (503).
    const controller = new InMemoryAdmissionController();
    const engine = new RoutingEngine(controller);
    const a = candidate("a");
    const b = candidate("b");

    await occupy(controller, a, CEILING);
    await occupy(controller, b, CEILING);

    const plan = await engine.plan(QUALIFIED, snapshot([a, b]));
    expect(plan.candidates).toHaveLength(2);
  });
});
