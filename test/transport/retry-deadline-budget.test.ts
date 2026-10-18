/**
 * A retry must not start an attempt the deadline will kill mid-flight.
 *
 * The pre-dispatch phase (credential, admission, pool slot, prepare) has to be
 * paid again on every retry. On a slow upstream that phase alone measured 60s+
 * against a 120s budget, so the second attempt began past the halfway mark and
 * was cut by the same deadline before the upstream could answer — the loop
 * spent the whole request on an attempt that could never have returned
 * anything, and the client saw that attempt's timeout instead of the first
 * attempt's real error.
 *
 * These drive `runAttemptLoop` with a short deadline and count the attempts
 * that actually start, so the proof is the attempt sequence rather than a
 * classifier. The budget guard is a wall-clock check, so the deadline is set
 * directly on the state instead of through env config.
 */
import { expect, test } from "bun:test";
import { GatewayError } from "../../src/protocol/gateway-error";
import { runAttemptLoop } from "../../src/transport/dispatch/attempt-loop";
import type { ProxyRequestState } from "../../src/transport/request/state";
import type { RouteCandidate } from "../../src/transport/routing/route-model";

/** State whose deadline is `deadlineMs` from now; the guard reads `deadlineMs`. */
function stateWithDeadline(deadlineMs: number): ProxyRequestState {
  return {
    requestId: "req-deadline-budget",
    ingressBody: { model: "deepseek-v4.1-flash", messages: [] },
    abortController: new AbortController(),
    outcome: undefined,
    startProviderFlight: () => undefined,
    deadlineMs: Date.now() + deadlineMs,
    startedAtMs: Date.now(),
  } as unknown as ProxyRequestState;
}

function candidate(providerId: string, accountId: string): RouteCandidate {
  return {
    candidate_id: `${providerId}:${accountId}`,
    provider_id: providerId,
    model_id: "deepseek-v4.1-flash",
    endpoint: `/v1/${providerId}`,
    capability_profile: null,
    wire_family: "chat",
    provider_account_id: accountId,
    provider_account_label: accountId,
    network_pool_ids: null,
    model_prefix: null,
  } as unknown as RouteCandidate;
}

/** Retryable, so failover would otherwise walk to the next candidate. */
function timeout(): GatewayError {
  return new GatewayError("deadline_exceeded", 504, "request deadline exceeded", {}, "upstream");
}

function leaseSourceStub() {
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
    plan: { requested_model: "deepseek-v4.1-flash" },
  };
}

/**
 * Runs the loop with every candidate failing retryably, and returns the
 * candidates actually attempted plus the error the loop finally threw.
 */
async function runUntilExhausted(deadlineMs: number): Promise<{
  readonly attempted: readonly string[];
  readonly thrown: unknown;
}> {
  const previousBase = process.env["CARTETHYIA_FALLBACK_RETRY_BASE_MS"];
  process.env["CARTETHYIA_FALLBACK_RETRY_BASE_MS"] = "0";
  try {
    const seen: string[] = [];
    let thrown: unknown;
    await runAttemptLoop<string, unknown>({
      state: stateWithDeadline(deadlineMs),
      deps: { db: {} },
      leaseSource: leaseSourceStub(),
      candidates: [candidate("wb", "wb-1"), candidate("wb", "wb-2"), candidate("wb", "wb-3")],
      tenantId: "tenant-1",
      strictPoolSelection: false,
      prepare: async () => ({ credential: {}, adapter: {} }),
      attempt: async (context: { readonly candidate: RouteCandidate }) => {
        seen.push(context.candidate.provider_account_id ?? "");
        throw timeout();
      },
      exhaustedError: new GatewayError("accounts_unavailable", 503, "exhausted"),
    } as never).catch((error: unknown) => {
      thrown = error;
    });
    return { attempted: seen, thrown };
  } finally {
    if (previousBase === undefined) delete process.env["CARTETHYIA_FALLBACK_RETRY_BASE_MS"];
    else process.env["CARTETHYIA_FALLBACK_RETRY_BASE_MS"] = previousBase;
  }
}

test("a retry with too little deadline left does not dial another candidate", async () => {
  // 5s left is below the retry budget: the second attempt would be cut by the
  // deadline mid-flight, so the loop stops after the first.
  const { attempted } = await runUntilExhausted(5_000);
  expect(attempted).toEqual(["wb-1"]);
});

test("a retry with room left still dials the next candidate", async () => {
  // Generous deadline: the guard must not suppress failover that can finish.
  const { attempted } = await runUntilExhausted(600_000);
  expect(attempted.length).toBeGreaterThan(1);
});

test("the suppressed retry surfaces the first attempt's own error", async () => {
  const { thrown } = await runUntilExhausted(5_000);
  // Not the sentinel: the client is told why the first attempt failed.
  expect(thrown).toBeInstanceOf(GatewayError);
  expect((thrown as GatewayError).code).toBe("deadline_exceeded");
  expect((thrown as GatewayError).message).not.toContain("exhausted");
});
