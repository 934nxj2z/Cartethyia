/**
 * The unsupported-model backoff.
 *
 * An upstream that says "I do not serve this model" (buddy business code
 * `11102`, or a `service info not found` / `model ... not supported` message)
 * is a verdict on one (account, model) pair, and it is durable: the pair is
 * re-dialled when the window lapses and answers the same thing. The reference
 * gateways answer that with an escalating site block; we answer it with an
 * escalating *cooldown*, because adopting their 400 would break clients that
 * currently succeed through our clamping.
 *
 * Three properties are pinned, all of them invisible from the outside — they
 * are properties of a single UPDATE:
 *
 * 1. **The window is at least the base, and escalates per hit.** A flat window
 *    let a permanently unsupported model consume a request every few hours
 *    forever.
 * 2. **Only this verdict advances the counter.** A rate limit or a capacity
 *    refusal on the same model must not push it up the ladder.
 * 3. **A success clears the counter but not an in-force cooldown.**
 *
 * A database double stands in for the handle: the behavior under test is
 * exactly which values reach `.set()`.
 */
import { describe, expect, test } from "bun:test";
import { GatewayError } from "../../src/protocol/gateway-error";
import type { CartethyiaDatabase } from "../../src/persistence/db-handle";
import {
  recordAccountFailure,
  recordAccountSuccess,
  unsupportedModelCooldownMs,
} from "../../src/providers/operations/account-health-service";

interface Captured {
  readonly updates: Record<string, unknown>[];
  readonly events: Record<string, unknown>[];
}

/** A drizzle-shaped double over one in-memory account row. */
function dbDouble(account: Record<string, unknown>): { db: CartethyiaDatabase; captured: Captured } {
  const updates: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  const client = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [account],
        }),
      }),
    }),
    update: () => ({
      set: (payload: Record<string, unknown>) => {
        updates.push(payload);
        return { where: async () => undefined };
      },
    }),
    insert: () => ({
      values: async (row: Record<string, unknown>) => {
        events.push(row);
      },
    }),
  };
  const db = {
    ...client,
    transaction: async (fn: (tx: unknown) => unknown) => fn(client),
  } as unknown as CartethyiaDatabase;
  return { db, captured: { updates, events } };
}

function activeAccount(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "acc-1",
    status: "active",
    consecutiveFailures: 0,
    staticToken: false,
    cooldownUntil: null,
    modelCooldowns: {},
    modelBlockHits: null,
    ...extra,
  };
}

/** The buddy family's "this model does not exist" answer. */
function unsupportedModelError(): GatewayError {
  return new GatewayError(
    "invalid_request",
    400,
    "upstream 400: service info not found",
    { providerCode: "11102" },
    "upstream",
  );
}

const MODEL_EVIDENCE = { origin: "upstream", scope: "model", modelId: "x" } as const;

function onlyUpdate(captured: Captured): Record<string, unknown> {
  expect(captured.updates).toHaveLength(1);
  return captured.updates[0]!;
}

function cooldownMsOf(payload: Record<string, unknown>): number {
  const cooldowns = payload.modelCooldowns as Record<string, string>;
  const until = cooldowns["x"];
  expect(typeof until).toBe("string");
  return Date.parse(until!) - Date.now();
}

describe("unsupportedModelCooldownMs — the ladder", () => {
  test("starts at six hours and doubles per hit, capped at a day", () => {
    const sixHours = 6 * 3600_000;
    expect(unsupportedModelCooldownMs(1)).toBe(sixHours);
    expect(unsupportedModelCooldownMs(2)).toBe(2 * sixHours);
    expect(unsupportedModelCooldownMs(3)).toBe(4 * sixHours);
    // 4 * 6h is already the cap, and every later hit stays there rather than
    // growing without bound.
    expect(unsupportedModelCooldownMs(4)).toBe(24 * 3600_000);
    expect(unsupportedModelCooldownMs(40)).toBe(24 * 3600_000);
  });
});

describe("recordAccountFailure — an unsupported model stops being redialed", () => {
  test("classifies 11102 as a model-scoped cooldown, not an account failure", async () => {
    const { db, captured } = dbDouble(activeAccount());
    const result = await recordAccountFailure(db, "acc-1", unsupportedModelError(), MODEL_EVIDENCE);
    expect(result?.category).toBe("model_unreachable");
    const payload = onlyUpdate(captured);
    // The account's own status is untouched: every other model it holds still
    // serves. Only the pair backs off.
    expect(payload["status"]).toBeUndefined();
    expect(cooldownMsOf(payload)).toBeGreaterThanOrEqual(6 * 3600_000 - 5_000);
  });

  test("escalates on the second report of the same pair", async () => {
    // The row already recorded one hit, so this failure is the second: the
    // window must be the doubled one, not the base it would state from scratch.
    const { db, captured } = dbDouble(
      activeAccount({ modelBlockHits: { x: 1 }, modelCooldowns: {} }),
    );
    await recordAccountFailure(db, "acc-1", unsupportedModelError(), MODEL_EVIDENCE);
    const payload = onlyUpdate(captured);
    expect(payload["modelBlockHits"]).toEqual({ x: 2 });
    const window = cooldownMsOf(payload);
    expect(window).toBeGreaterThanOrEqual(12 * 3600_000 - 5_000);
    expect(window).toBeLessThan(24 * 3600_000);
  });

  test("a rate limit on the same model does not advance the unsupported ladder", async () => {
    const { db, captured } = dbDouble(activeAccount({ modelBlockHits: { x: 1 } }));
    await recordAccountFailure(
      db,
      "acc-1",
      new GatewayError("quota_exceeded", 429, "429 too many requests", {}, "upstream"),
      MODEL_EVIDENCE,
    );
    const payload = onlyUpdate(captured);
    // The counter is absent from the write entirely: nothing should have moved.
    expect(payload["modelBlockHits"]).toBeUndefined();
  });

  test("the message shape is enough without the code", async () => {
    // An upstream that phrases it instead of coding it must be caught too —
    // "model ... is not supported" is the other spelling the references match.
    const { db, captured } = dbDouble(activeAccount());
    const error = new GatewayError(
      "invalid_request",
      404,
      "upstream 404: model glm-9.9 is not supported",
      {},
      "upstream",
    );
    const result = await recordAccountFailure(db, "acc-1", error, MODEL_EVIDENCE);
    expect(result?.category).toBe("model_unreachable");
    expect(cooldownMsOf(onlyUpdate(captured))).toBeGreaterThanOrEqual(6 * 3600_000 - 5_000);
  });
});

describe("recordAccountSuccess — the escalation restarts, the cooldown does not", () => {
  test("clears the hit counter without releasing an in-force cooldown", async () => {
    const { db, captured } = dbDouble(
      activeAccount({ modelBlockHits: { x: 3 }, consecutiveFailures: 2 }),
    );
    await recordAccountSuccess(db, "acc-1");
    const payload = onlyUpdate(captured);
    expect(payload["modelBlockHits"]).toEqual({});
    // Deliberate: a model cooldown already in force survives a success, which is
    // the existing behavior and the reference gateways' too.
    expect(payload["modelCooldowns"]).toBeUndefined();
  });

  test("an account with no hits is not written to at all", async () => {
    // The common case is a healthy account; the extra column must not turn
    // every success into a wider write.
    const { db, captured } = dbDouble(activeAccount());
    await recordAccountSuccess(db, "acc-1");
    expect(onlyUpdate(captured)["modelBlockHits"]).toBeUndefined();
  });
});
