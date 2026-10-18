/**
 * A request that exhausts its attempt budget still owes the console one
 * completion.
 *
 * `runAttemptLoop` has a terminal branch inside its catch — reached when the
 * failure is non-retryable or the candidate list is spent — but a loop whose
 * every attempt was *retryable* falls out of the `while` and used to throw
 * without ever calling `completeAttempt`. That skipped the telemetry row, the
 * payload capture, and `state.completed`, so the request was invisible in
 * Request Detail: no status, no error category, and four empty payload panels
 * for exactly the failures an operator most needs to read.
 *
 * This drives `runAttemptLoop` with a stubbed lease source and a `prepare`
 * that always fails, so the proof is the completion itself rather than a
 * classifier.
 */
import { expect, test } from "bun:test";
import { GatewayError } from "../../src/protocol/gateway-error";
import { runAttemptLoop } from "../../src/transport/dispatch/attempt-loop";
import type { ProxyRequestState } from "../../src/transport/request/state";
import type { RouteCandidate } from "../../src/transport/routing/route-model";

/** The minimum state `completeAttempt` reads on this path. */
function stateFor(requestId: string): ProxyRequestState {
  return {
    requestId,
    ingressBody: { model: "stub/model", messages: [] },
    abortController: new AbortController(),
    outcome: undefined,
  } as unknown as ProxyRequestState;
}

function candidate(id: string): RouteCandidate {
  return {
    candidate_id: id,
    provider_id: "stub",
    model_id: "stub-model",
    endpoint: "/v1/chat/completions",
    capability_profile: null,
    wire_family: "chat",
    provider_account_id: null,
    provider_account_label: null,
    network_pool_ids: null,
    model_prefix: null,
  } as unknown as RouteCandidate;
}

/**
 * A bare `Error` is retryable — `classifyUpstreamFailure` returns
 * `retryable: true` for anything that is not a `GatewayError` — so every
 * attempt takes the failover branch and the loop falls out of the `while`
 * with the budget spent: the path that used to throw with no completion.
 * More candidates than the budget keeps `index` below `candidates.length`, so
 * the loop ends on the budget rather than the candidate list.
 */
test("an exhausted, always-retryable attempt budget still records a terminal completion", async () => {
  // Two attempts at zero backoff: enough to exhaust the budget, fast enough
  // that the test never waits on the failover delay.
  const previousAttempts = process.env["CARTETHYIA_ROUTE_MAX_ATTEMPTS"];
  const previousBase = process.env["CARTETHYIA_FALLBACK_RETRY_BASE_MS"];
  process.env["CARTETHYIA_ROUTE_MAX_ATTEMPTS"] = "2";
  process.env["CARTETHYIA_FALLBACK_RETRY_BASE_MS"] = "0";
  try {
    const state = stateFor("req-exhausted");
    let attempts = 0;

    const error = await runAttemptLoop<never, unknown>({
      state,
      deps: { db: {} },
      leaseSource: {
        estimatedInputTokens: 10,
        estimatedOutputTokens: 0,
        routingEngine: { release: async () => undefined },
      },
      candidates: Array.from({ length: 12 }, (_unused, index) => candidate(`c${index}`)),
      tenantId: "tenant-1",
      strictPoolSelection: false,
      exhaustedError: new GatewayError("transport_unavailable", 502, "no candidate", {}, "upstream"),
      prepare: async () => {
        attempts += 1;
        throw new Error("upstream stream failed");
      },
      attempt: async () => {
        throw new Error("attempt must never run when prepare fails");
      },
    } as never).catch((thrown: unknown) => thrown);

    expect(error instanceof Error).toBe(true);
    expect(attempts).toBe(2);
    // The proof: the loop no longer throws with `state.completed` left clear.
    expect(state.completed).toBe(true);
    expect(state.outcome?.status).toBe("failed");
  } finally {
    if (previousAttempts === undefined) delete process.env["CARTETHYIA_ROUTE_MAX_ATTEMPTS"];
    else process.env["CARTETHYIA_ROUTE_MAX_ATTEMPTS"] = previousAttempts;
    if (previousBase === undefined) delete process.env["CARTETHYIA_FALLBACK_RETRY_BASE_MS"];
    else process.env["CARTETHYIA_FALLBACK_RETRY_BASE_MS"] = previousBase;
  }
});
