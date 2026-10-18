/**
 * A 402 from the proxy and a 402 from the upstream must not be confused.
 *
 * Both answer the same status with opposite meanings: the proxy's 402 is a
 * verdict on the pool (it cannot carry traffic — disable it), while the
 * upstream's 402 is that provider's billing verdict on the account that was
 * dialed (cool the account down, leave the pool alone). Conflating them either
 * kills accounts for a proxy that owes money, or keeps selecting a pool that
 * has already refused to tunnel.
 *
 * The discriminator is who answered, not the status. A proxy refuses the
 * CONNECT handshake before any upstream is dialed, so its status is
 * unambiguously the proxy's own — carried on a typed `ProxyConnectRefusalError`
 * rather than a `GatewayError`, which is why the status had to be read from
 * more than `error.status`.
 */
import { describe, expect, test } from "bun:test";
import { GatewayError } from "../../src/protocol/gateway-error";
import { ProxyConnectRefusalError } from "../../src/network/pool/agent";
import { resolveProxyDisableDecision } from "../../src/transport/dispatch/attempt-finalize";
import type { AttemptCompletion } from "../../src/transport/dispatch/attempt-finalize";

const POOL = "pool-1";

/** One failed attempt against `POOL`, with only the fields the decision reads. */
function completion(error: unknown, extra: Partial<AttemptCompletion> = {}): AttemptCompletion {
  return {
    status: "failed",
    networkPoolId: POOL,
    terminal: true,
    tenantId: "tenant-1",
    ingressBody: { model: "stub/model", messages: [] },
    db: {},
    error,
    ...extra,
  } as unknown as AttemptCompletion;
}

describe("proxy 402 vs account 402", () => {
  test("a proxy CONNECT 402 disables the pool", () => {
    // The whole point: this is the pool owing money, not the account.
    const { disableProxy, responseHttpStatus } = resolveProxyDisableDecision(
      completion(new ProxyConnectRefusalError(402, "Payment Required")),
    );
    expect(responseHttpStatus).toBe(402);
    expect(disableProxy).toBe(true);
  });

  test("a proxy CONNECT 407 disables the pool", () => {
    expect(
      resolveProxyDisableDecision(
        completion(new ProxyConnectRefusalError(407, "Proxy Authentication Required")),
      ).disableProxy,
    ).toBe(true);
  });

  test("an upstream 402 leaves the pool alone", () => {
    // Same status, opposite owner: a provider billing verdict on the account.
    const { disableProxy, responseHttpStatus } = resolveProxyDisableDecision(
      completion(new GatewayError("quota_exceeded", 402, "insufficient quota", {}, "upstream")),
    );
    expect(responseHttpStatus).toBe(402);
    expect(disableProxy).toBe(false);
  });

  test("a proxy refusal that is not payment/auth does not disable", () => {
    // 503 from CONNECT is "unavailable", not "unusable" — it may recover.
    expect(
      resolveProxyDisableDecision(
        completion(new ProxyConnectRefusalError(503, "Service Unavailable")),
      ).disableProxy,
    ).toBe(false);
  });

  test("a completed attempt never disables the pool", () => {
    expect(
      resolveProxyDisableDecision(
        completion(new ProxyConnectRefusalError(402, "Payment Required"), {
          status: "completed",
        }),
      ).disableProxy,
    ).toBe(false);
  });

  test("no pool on the attempt means nothing to disable", () => {
    const noPool = completion(new ProxyConnectRefusalError(402, "Payment Required"));
    delete (noPool as { networkPoolId?: string }).networkPoolId;
    expect(resolveProxyDisableDecision(noPool).disableProxy).toBe(false);
  });

  test("a non-proxy failure is unchanged", () => {
    // Regression guard: nothing about ordinary upstream failures moves.
    expect(
      resolveProxyDisableDecision(
        completion(new GatewayError("deadline_exceeded", 504, "timeout", {}, "cartethyia")),
      ).disableProxy,
    ).toBe(false);
  });
});
