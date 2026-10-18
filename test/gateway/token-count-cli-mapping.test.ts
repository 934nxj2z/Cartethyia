/**
 * Whether `POST /v1/messages/count_tokens` can reach a provider through a
 * combo whose members are `chat`, when a CLI mapping points at an Anthropic
 * Messages provider.
 *
 * The gate is `wire_family === "messages"` in
 * `ProxyRequestPreparer.prepareNativeTokenCount`, applied *after* the router
 * has already expanded the combo into its member candidates. So the question
 * is not whether the mapping resolves — it is whether the mapping produces a
 * candidate whose row says `messages`.
 *
 * A combo expands to registered catalog rows. A CLI mapping is an alias, and
 * an alias resolves a *name*, so it can only change which registered row is
 * named — it cannot make a `chat` row report `messages`. Pinning that is the
 * point: the 400 is a property of the registered rows behind the combo, not of
 * the mapping.
 */
import { describe, expect, test } from "bun:test";
import { RoutingEngine } from "../../src/transport/routing/router";
import type { RouteCandidate } from "../../src/transport/routing/route-model";
import type { RouteSnapshot } from "../../src/transport/routing/route-model";

function candidate(overrides: Record<string, unknown> = {}): RouteCandidate {
  return {
    provider_id: "cb",
    model_id: "deepseek-v4.1-flash",
    wire_family: "chat",
    endpoint: "/v1/chat/completions",
    capability_profile: {},
    ...overrides,
  } as RouteCandidate;
}

/** A combo of two `chat` members plus an Anthropic `messages` row alongside it. */
function snapshot(): RouteSnapshot {
  return {
    revision: 1,
    candidates: [
      candidate({ provider_id: "cb" }),
      candidate({ provider_id: "workbuddy" }),
      // The row a CLI mapping would have to reach to make counting work.
      candidate({
        provider_id: "anthropic",
        model_id: "claude-sonnet-4-6",
        wire_family: "messages",
        endpoint: "/v1/messages",
      }),
    ],
    aliases: {},
    combos: {
      t1: {
        "bansos/deepseek-v4.1-flash": {
          members: ["cb/deepseek-v4.1-flash", "workbuddy/deepseek-v4.1-flash"],
          strategy: "fallback",
        },
      } as unknown as Record<string, import("../../src/transport/routing/route-model").ComboDefinition>,
    },
    created_at: Date.now(),
  } as unknown as RouteSnapshot;
}

describe("count_tokens candidate eligibility", () => {
  test("a chat-only combo yields no messages-family candidate", async () => {
    const engine = new RoutingEngine();
    const plan = await engine.plan("bansos/deepseek-v4.1-flash", snapshot(), "t1");
    const counting = plan.candidates.filter((c) => c.wire_family === "messages");
    // The mechanism behind the 400: every member of this combo is `chat`.
    expect(plan.candidates.length).toBeGreaterThan(0);
    expect(counting).toEqual([]);
  });

  test("a cli_alias naming a messages row does produce a counting candidate", async () => {
    const engine = new RoutingEngine();
    const snap = snapshot();
    const withCliAlias = {
      ...snap,
      cli_aliases: { t1: { "bansos/deepseek-v4.1-flash": "anthropic/claude-sonnet-4-6" } },
    } as unknown as RouteSnapshot;
    const plan = await engine.plan("bansos/deepseek-v4.1-flash", withCliAlias, "t1", undefined, true, "k1");
    const counting = plan.candidates.filter((c) => c.wire_family === "messages");
    // A mapping can only help when it names a row that IS `messages`.
    expect(counting.map((c) => c.provider_id)).toEqual(["anthropic"]);
  });
});
