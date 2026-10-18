/**
 * A refused egress must fail over to the next pool, not end the request.
 *
 * opencode is credential-less (`requiresAccount: false`), so its route plan
 * holds exactly **one** candidate — and that candidate carries every eligible
 * pool in `network_pool_ids`. Pool selection therefore happens *inside* one
 * attempt, not by walking candidates.
 *
 * The attempt loop judged terminality as
 * `!isRetryableFailure(error) || index === candidates.length - 1`. With one
 * candidate, the second clause is true on the very first failure, so a 403
 * that flagged the pool and asked for a different egress ended the request
 * instead of retrying through the healthy pool sitting in the same candidate.
 * The operator saw "all pools cooling" while an unflagged pool sat idle.
 *
 * The fix treats a pool-scoped failure as a new attempt against the same
 * candidate: the pool is flagged first, the candidate is not marked failed, and
 * the index does not advance. The budget still bounds the loop, so an all-pools
 * -refused case terminates through selection with its own error.
 */
import { expect, test } from "bun:test";
import { GatewayError } from "../../src/protocol/gateway-error";
import { runAttemptLoop } from "../../src/transport/dispatch/attempt-loop";
import { NetworkPoolSelector } from "../../src/network/pool/selector";
import type { ProxyRequestState } from "../../src/transport/request/state";
import type { RouteCandidate } from "../../src/transport/routing/route-model";

function stateFor(): ProxyRequestState {
  return {
    requestId: "req-pool-failover",
    ingressBody: { model: "big-pickle", messages: [] },
    abortController: new AbortController(),
    outcome: undefined,
    deadlineMs: Date.now() + 60_000,
    completed: false,
    startProviderFlight: () => undefined,
    stopProviderFlight: () => undefined,
  } as unknown as ProxyRequestState;
}

/**
 * One opencode candidate carrying both pools — the shape `route-catalog`
 * builds for a credential-less provider.
 */
function opencodeCandidate(): RouteCandidate {
  return {
    candidate_id: "opencode:global",
    provider_id: "opencode",
    model_id: "big-pickle",
    endpoint: "/zen/v1/chat/completions",
    capability_profile: null,
    wire_family: "chat",
    requires_account: false,
    network_pool_ids: ["pool-a", "pool-b"],
    network_pool_limits: { "pool-a": 10, "pool-b": 10 },
    network_pool_weights: { "pool-a": 100, "pool-b": 100 },
  } as unknown as RouteCandidate;
}

/** The refusal the upstream sends for a flagged address: 403 FreeTierError. */
function freeTierRefusal(): GatewayError {
  return new GatewayError(
    "authentication_failed",
    403,
    "FreeTierError: free tier can only be used from an allowed region",
    { providerCode: "FreeTierError", rateLimitScope: "provider", raw: "FreeTierError" },
    "upstream",
  );
}

function leaseSource() {
  return {
    estimatedInputTokens: 10,
    estimatedOutputTokens: 0,
    admissionService: {
      admit: async () => ({
        commit: async () => undefined,
        release: async () => undefined,
        commitUsage: async () => undefined,
      }),
      release: async () => undefined,
    },
    routingEngine: {
      acquire: async () => ({ lease_id: "lease-1" }),
      reserve: async () => ({ lease_id: "lease-1" }),
      release: async () => undefined,
    },
    plan: { requested_model: "big-pickle" },
  };
}

/**
 * Drives the loop once. `onAttempt` receives the pool the selector chose, so a
 * test can assert which egress the retry actually left by.
 */
async function runOnce(options: {
  readonly pools: NetworkPoolSelector;
  readonly onAttempt: () => string | GatewayError;
  readonly maxAttempts?: number;
}): Promise<{ readonly seen: readonly string[]; readonly error: unknown }> {
  const previousAttempts = process.env["CARTETHYIA_ROUTE_MAX_ATTEMPTS"];
  const previousBase = process.env["CARTETHYIA_FALLBACK_RETRY_BASE_MS"];
  process.env["CARTETHYIA_ROUTE_MAX_ATTEMPTS"] = String(options.maxAttempts ?? 8);
  process.env["CARTETHYIA_FALLBACK_RETRY_BASE_MS"] = "0";
  const seen: string[] = [];
  let error: unknown;
  try {
    await runAttemptLoop<string, unknown>({
      state: stateFor(),
      deps: { db: {}, poolSelector: options.pools },
      leaseSource: leaseSource(),
      candidates: [opencodeCandidate()],
      tenantId: "tenant-1",
      strictPoolSelection: true,
      prepare: async () => ({ credential: {}, adapter: {} }),
      attempt: async (context: { readonly leases: { readonly networkPoolId?: string } }) => {
        const poolId = context.leases.networkPoolId ?? "none";
        seen.push(poolId);
        const outcome = options.onAttempt();
        if (outcome instanceof GatewayError) throw outcome;
        return outcome;
      },
      exhaustedError: new GatewayError("accounts_unavailable", 503, "exhausted"),
    } as never).catch((cause: unknown) => {
      error = cause;
    });
    return { seen, error };
  } finally {
    if (previousAttempts === undefined) delete process.env["CARTETHYIA_ROUTE_MAX_ATTEMPTS"];
    else process.env["CARTETHYIA_ROUTE_MAX_ATTEMPTS"] = previousAttempts;
    if (previousBase === undefined) delete process.env["CARTETHYIA_FALLBACK_RETRY_BASE_MS"];
    else process.env["CARTETHYIA_FALLBACK_RETRY_BASE_MS"] = previousBase;
  }
}

test("a refused egress fails over to the next pool within one candidate", async () => {
  const pools = new NetworkPoolSelector();
  let attemptNumber = 0;
  const { seen, error } = await runOnce({
    pools,
    onAttempt: () => {
      // Refuse only the first egress; the second must serve.
      attemptNumber += 1;
      return attemptNumber === 1 ? freeTierRefusal() : "served";
    },
  });
  expect(error).toBeUndefined();
  expect(seen).toHaveLength(2);
  expect(seen[0]).not.toBe(seen[1]);
  // The refused pool is retired, and the other one is still usable.
  expect(await pools.isProviderCooldown(seen[0]!, "opencode")).toMatchObject({
    inCooldown: true,
    blocked: true,
  });
  expect(await pools.isProviderCooldown(seen[1]!, "opencode")).toMatchObject({ inCooldown: false });
});

test("the refusal is never retried on the pool that caused it", async () => {
  const pools = new NetworkPoolSelector();
  const { seen } = await runOnce({
    pools,
    onAttempt: () => freeTierRefusal(),
  });
  // Each pool is tried at most once: the flag written by the first refusal
  // takes it out of selection before the retry.
  expect(new Set(seen).size).toBe(seen.length);
});

test("when every pool is refused the request ends with its own error, not a cooldown lie", async () => {
  const pools = new NetworkPoolSelector();
  const { seen, error } = await runOnce({
    pools,
    onAttempt: () => freeTierRefusal(),
  });
  expect(seen).toHaveLength(2);
  expect(error).toBeInstanceOf(GatewayError);
  const gateway = error as GatewayError;
  expect(gateway.code).toBe("proxy_pool_blocked");
  // Nothing clears a retired egress on a timer, so the message must not tell
  // the operator to wait for one.
  expect(gateway.message.toLowerCase()).not.toContain("cooling down");
  expect(gateway.message).toContain("refuses");
});

test("a 403 from a provider that is not IP-scoped never retires a pool", async () => {
  const pools = new NetworkPoolSelector();
  const policyRejection = new GatewayError(
    "policy_rejected",
    403,
    "content policy",
    { providerCode: "11140" },
    "upstream",
  );
  // `claude` is account-keyed, so a 403 is the request's problem, not the
  // egress's. The guard is in the provider metadata, not in the caller.
  const candidate = { ...opencodeCandidate(), provider_id: "claude" } as RouteCandidate;
  const previousAttempts = process.env["CARTETHYIA_ROUTE_MAX_ATTEMPTS"];
  process.env["CARTETHYIA_ROUTE_MAX_ATTEMPTS"] = "4";
  process.env["CARTETHYIA_FALLBACK_RETRY_BASE_MS"] = "0";
  try {
    await runAttemptLoop<string, unknown>({
      state: stateFor(),
      deps: { db: {}, poolSelector: pools },
      leaseSource: leaseSource(),
      candidates: [candidate],
      tenantId: "tenant-1",
      strictPoolSelection: true,
      prepare: async () => ({ credential: {}, adapter: {} }),
      attempt: async () => {
        throw policyRejection;
      },
      exhaustedError: new GatewayError("accounts_unavailable", 503, "exhausted"),
    } as never).catch(() => undefined);
  } finally {
    if (previousAttempts === undefined) delete process.env["CARTETHYIA_ROUTE_MAX_ATTEMPTS"];
    else process.env["CARTETHYIA_ROUTE_MAX_ATTEMPTS"] = previousAttempts;
    delete process.env["CARTETHYIA_FALLBACK_RETRY_BASE_MS"];
  }
  // No pool may have been retired by a non-IP-scoped 403.
  expect(await pools.isProviderCooldown("pool-a", "claude")).toMatchObject({ inCooldown: false });
  expect(await pools.isProviderCooldown("pool-b", "claude")).toMatchObject({ inCooldown: false });
});
