/**
 * Which account-health writes drop the route snapshot.
 *
 * The snapshot projects `provider_accounts.status` and `.cooldownUntil` and
 * nothing else (`route-catalog.ts:286-287`). A failure that only cooled one
 * (account, model) pair — the common throttle — changes neither, so dropping
 * the snapshot for it forced the next request to rebuild 11 SELECTs' worth of
 * routing for no reason. Under a failure wave each rebuild fed the next
 * invalidation, which is what made the cost superlinear.
 *
 * These assert the gate, not the SQL: the classification's `routesVisible` flag
 * is the contract, and it is what the reporter reads.
 */
import { describe, expect, test } from "bun:test";
import { classifyAccountError } from "../../src/providers/operations/account-health-service";
import { GatewayError } from "../../src/protocol/gateway-error";

/**
 * `routesVisible` is set by the caller that knows which columns it wrote, not
 * by the classifier — the same classification feeds both the account-wide path
 * (writes `status` + `cooldownUntil`) and the model-scoped path (writes
 * neither). So the classifier's own answer is always the conservative `true`,
 * and these assert that contract plus the categories the two paths key off.
 */

function upstream(message: string, extra: Record<string, unknown> = {}): GatewayError {
  const error = new GatewayError("rate_limit_transient" as never, 429, message);
  Object.assign(error.details, { origin: "upstream", scope: "account", credentialEvidence: true, ...extra });
  return error;
}

describe("account error classification", () => {
  test("a model-scoped throttle reports itself as not routing-visible", () => {
    // Rate limits are (account, model) scoped in this module: the account
    // stays routable for every other model, so `status` and `cooldownUntil`
    // never move.
    const classification = classifyAccountError(upstream("rate limit exceeded"), {
      origin: "upstream",
      scope: "account",
      credentialEvidence: true,
    });
    expect(classification.category).toBe("rate_limit_transient");
    expect(classification.mutatesAccount).toBe(true);
    // Conservative at classify time; narrowed to false by the model-scoped
    // write path, which is what the reporter gates on.
    expect(classification.routesVisible).toBe(true);
  });

  test("an auth failure that parks the account is routing-visible", () => {
    const classification = classifyAccountError(upstream("token revoked"), {
      origin: "upstream",
      scope: "account",
      credentialEvidence: true,
    });
    // A revocation writes `status`, which the snapshot reads.
    expect(classification.routesVisible).toBe(true);
  });

  test("a non-mutating classification is still reported", () => {
    // Scope "provider" with no credential evidence: recognised, but nothing is
    // written, so there is nothing for routing to learn.
    const classification = classifyAccountError(upstream("rate limit exceeded"), {
      origin: "upstream",
      scope: "provider",
    });
    // A rate limit mutates at provider scope too: the streak must advance or
    // the most common throttle never escalates.
    expect(classification.mutatesAccount).toBe(true);
  });
});

describe("a queued upstream is capacity, not a dead credential", () => {
  /**
   * The reported failure: Qoder answers `403 {"code":"10605", ...}` with
   * `isQueued:true` and a `queueCount`. The 403 made the generic auth arm
   * claim it, so a healthy account was parked as `auth_invalidated` — the
   * console's "Re-login required" — purely because the provider was busy.
   * The credential was never rejected; refreshing it cannot shorten a queue.
   */
  const queued = (): GatewayError =>
    new GatewayError(
      "upstream_error" as never,
      403,
      `{"code":"10605","message":"{\\"isQueued\\":true,\\"modelKey\\":\\"dfmodel\\",\\"queueCount\\":1395,\\"queueType\\":\\"\\"}"}`,
      { providerCode: "10605" } as never,
      "upstream" as never,
    );

  test("a queued 403 is a model-capacity cooldown", () => {
    const classification = classifyAccountError(queued(), {
      origin: "upstream",
      scope: "account",
      providerId: "qoder",
      modelId: "deepseek-v4.1-flash",
    });
    expect(classification.category).toBe("model_capacity");
    expect(classification.status).toBe("cooldown");
  });

  test("it is never reported as credential invalidation", () => {
    // The whole point: the console must not offer "Re-login required" for an
    // account that is queued behind 1395 other callers.
    const classification = classifyAccountError(queued(), {
      origin: "upstream",
      scope: "account",
      credentialEvidence: true,
      providerId: "qoder",
      modelId: "deepseek-v4.1-flash",
    });
    expect(classification.category).not.toBe("auth_invalidated");
  });

  test("queue evidence is recognised without the provider code", () => {
    // The body is nested JSON, so the tell is the key rather than a parse.
    const error = new GatewayError(
      "upstream_error" as never,
      403,
      `{"isQueued":true,"modelKey":"dfmodel","queueCount":12}`,
      {} as never,
      "upstream" as never,
    );
    const classification = classifyAccountError(error, {
      origin: "upstream",
      scope: "account",
      providerId: "qoder",
      modelId: "deepseek-v4.1-flash",
    });
    expect(classification.category).toBe("model_capacity");
  });

  test("a real credential rejection is still recognised", () => {
    // Guard against the mirror mistake: excluding queued bodies must not
    // swallow an auth rejection that happens to be a 403.
    const error = new GatewayError(
      "authentication_failed" as never,
      403,
      "invalid api key",
      {} as never,
      "upstream" as never,
    );
    const classification = classifyAccountError(error, {
      origin: "upstream",
      scope: "account",
      providerId: "qoder",
    });
    expect(classification.category).toBe("auth_invalidated");
  });
});

describe("an unclassified failure is a cooldown, never a parked account", () => {
  test("an unmapped upstream error cools down for 15 minutes", () => {
    const error = new GatewayError(
      "upstream_error" as never,
      400,
      "something this gateway does not understand",
      {} as never,
      "upstream" as never,
    );
    const classification = classifyAccountError(error, {
      origin: "upstream",
      scope: "account",
      providerId: "qoder",
    });
    expect(classification.category).toBe("unknown");
    expect(classification.status).toBe("cooldown");
    expect(classification.cooldownMs).toBe(900_000);
  });
});
