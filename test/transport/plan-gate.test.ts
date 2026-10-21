/**
 * The plan gate: keeping a model the upstream refuses on a free plan away from
 * an account the upstream reports as free.
 *
 * CodeBuddy is the case that motivates it. It refuses a set of models with
 * `11158 "model [X] is not allowed for user type [personal_free_user]"`, and
 * the account's plan is the only thing that predicts it — the model directory
 * publishes nothing usable. The gate exists so a certain refusal is not sent,
 * because sending it advances the account's failure streak toward a six-hour
 * park for something that is not the account's fault.
 *
 * The asymmetry these tests pin: a wrong "free" answer costs a working account,
 * a wrong "not free" answer costs one request that the cooldown machinery
 * already handles. So every doubtful input resolves toward serving.
 *
 * No wall-clock timers: the gate is a pure predicate over two fields.
 */
import { describe, expect, test } from "bun:test";
import { isFreePlanAccount, planAllowsCandidate } from "../../src/transport/routing/plan-gate";

describe("isFreePlanAccount", () => {
  test("the plan CodeBuddy actually reports is free", () => {
    // Live value from a `personal_free_user` account, read from the billing
    // meter's `PackageName`.
    expect(isFreePlanAccount("Free Plan Subscription")).toBe(true);
  });

  test("a paid plan is not free", () => {
    expect(isFreePlanAccount("Pro Plan Subscription")).toBe(false);
    expect(isFreePlanAccount("Enterprise")).toBe(false);
  });

  test("no plan at all is not free", () => {
    // The important direction. An account whose plan was never read must stay
    // in rotation; treating unknown as free would empty the candidate list.
    expect(isFreePlanAccount(null)).toBe(false);
    expect(isFreePlanAccount(undefined)).toBe(false);
    expect(isFreePlanAccount("")).toBe(false);
    expect(isFreePlanAccount("   ")).toBe(false);
  });

  test("the match is case-insensitive and whitespace-tolerant", () => {
    expect(isFreePlanAccount("free plan")).toBe(true);
    expect(isFreePlanAccount("  FREE PLAN SUBSCRIPTION  ")).toBe(true);
  });

  test("a plan that merely contains the word is still free", () => {
    // Narrower than this would need an exact string we would have to keep in
    // sync with a name the provider controls.
    expect(isFreePlanAccount("CodeBuddy Free Tier")).toBe(true);
  });
});

describe("planAllowsCandidate", () => {
  test("a pro-only model on a free account is excluded", () => {
    expect(
      planAllowsCandidate({ pro_only: true, account_plan: "Free Plan Subscription" }),
    ).toBe(false);
  });

  test("a pro-only model on a paid account is allowed", () => {
    expect(planAllowsCandidate({ pro_only: true, account_plan: "Pro Plan" })).toBe(true);
  });

  test("a pro-only model on an account with no known plan is allowed", () => {
    // Absence is not evidence of free. Excluding here would take working
    // accounts out of rotation on the strength of a missing read.
    expect(planAllowsCandidate({ pro_only: true, account_plan: null })).toBe(true);
    expect(planAllowsCandidate({ pro_only: true })).toBe(true);
  });

  test("an ordinary model is allowed on any account, free included", () => {
    // The gate is about the model, not a general distrust of free accounts:
    // most of a free account's catalogue serves it perfectly well.
    expect(planAllowsCandidate({ account_plan: "Free Plan Subscription" })).toBe(true);
    expect(
      planAllowsCandidate({ pro_only: false, account_plan: "Free Plan Subscription" }),
    ).toBe(true);
  });

  test("pro_only false is not the same claim as absent, but neither gates", () => {
    expect(planAllowsCandidate({ pro_only: false, account_plan: "Free Plan" })).toBe(true);
  });
});
