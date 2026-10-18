/**
 * What a probe answer means about the egress.
 *
 * The distinction this file pins is the one that was wrong in production: a
 * `4xx` from the upstream's **own validation** proves the address was accepted,
 * because the IP gate runs before the body is read. Mapping it to `unreachable`
 * said "the probe could not complete", which blamed the proxy for the probe's
 * request — and reported four egresses that answer `200` to a real dispatch as
 * unusable.
 *
 * The classification is exercised through the same predicate the store uses,
 * with synthetic responses, so it needs no network.
 */
import { describe, expect, test } from "bun:test";
import { classifyProviderProbeAnswer, isRetryableProbeError } from "../../src/console/routing/pools/probe-verdict";

describe("provider probe verdict", () => {
  test("a served dispatch is allowed", () => {
    expect(classifyProviderProbeAnswer(200, "")).toMatchObject({ status: "allowed" });
  });

  test("the IP gate's own refusal is blocked", () => {
    expect(
      classifyProviderProbeAnswer(
        403,
        '{"type":"error","error":{"type":"FreeTierError","message":"OpenCode\'s free tier can only be used from within OpenCode."}}',
      ),
    ).toMatchObject({ status: "blocked" });
  });

  test("a body-validation complaint is allowed, not unreachable", () => {
    // The gate accepted the address; the request was merely malformed. Reading
    // this as `unreachable` is the defect this test exists for.
    const verdict = classifyProviderProbeAnswer(400, '{"error":{"param":"messages must not be empty"}}');
    expect(verdict.status).toBe("allowed");
    expect(verdict.reason).toContain("400");
  });

  test("a spent rate is throttled, not blocked", () => {
    // The address works; it is the rate that ran out, and that recovers.
    expect(classifyProviderProbeAnswer(429, "")).toMatchObject({ status: "throttled" });
  });

  test("an upstream fault says nothing about the address", () => {
    expect(classifyProviderProbeAnswer(502, "")).toMatchObject({ status: "unreachable" });
    expect(classifyProviderProbeAnswer(503, "")).toMatchObject({ status: "unreachable" });
  });

  test("a proxy demanding auth is unreachable, not blocked", () => {
    // 407 comes from the proxy front door, never from the provider.
    expect(classifyProviderProbeAnswer(407, "")).toMatchObject({ status: "unreachable" });
  });

  test("a 403 that is not the free-tier gate is not a block", () => {
    // Only the upstream's own free-tier wording retires an egress. A bare
    // "Forbidden" reached the upstream, so the address was accepted; retiring
    // on it would drop a usable pool for good.
    const verdict = classifyProviderProbeAnswer(403, "Forbidden");
    expect(verdict.status).not.toBe("blocked");
    expect(verdict.status).toBe("allowed");
  });
});

/**
 * Which probe failures deserve a second attempt.
 *
 * The report was "probe fails the first time, works on retry". A cold dial has
 * to resolve, open the proxy tunnel, and finish a TLS handshake, and any step
 * can be refused or reset once by a middlebox that accepts the very next
 * attempt — so retiring an egress on the first failure blamed the address for a
 * race. These pin the boundary: transport failures retry, and anything that is
 * an answer or our own deadline does not.
 */
describe("isRetryableProbeError", () => {
  function transportError(message: string, code?: string, name = "Error"): Error {
    return Object.assign(new Error(message), { code, name });
  }

  test("a refused or reset connection is retried", () => {
    // The exact case in the report.
    expect(isRetryableProbeError(transportError("connect ECONNREFUSED", "ECONNREFUSED"))).toBe(true);
    expect(isRetryableProbeError(transportError("socket hang up", "ECONNRESET"))).toBe(true);
    expect(isRetryableProbeError(transportError("aborted", "ECONNABORTED"))).toBe(true);
  });

  test("an unreachable network and DNS failure are retried", () => {
    expect(isRetryableProbeError(transportError("no route", "EHOSTUNREACH"))).toBe(true);
    expect(isRetryableProbeError(transportError("dns", "EAI_AGAIN"))).toBe(true);
    expect(isRetryableProbeError(transportError("gone", "UND_ERR_SOCKET"))).toBe(true);
  });

  test("Bun's folded-message transport failures are retried", () => {
    // Bun raises some of these as a plain TypeError with the reason in the
    // message rather than on `error.code`.
    expect(isRetryableProbeError(new Error("fetch failed"))).toBe(true);
    expect(isRetryableProbeError(new Error("socket connection was closed unexpectedly"))).toBe(true);
    expect(isRetryableProbeError(new Error("other side closed"))).toBe(true);
  });

  test("our own deadline is not retried", () => {
    // Spending the probe budget retrying a slow egress turns a timeout into the
    // whole budget; a slow address should be reported slow, not redialled.
    expect(isRetryableProbeError(transportError("timed out", undefined, "AbortError"))).toBe(false);
    expect(isRetryableProbeError(transportError("deadline", undefined, "TimeoutError"))).toBe(false);
  });

  test("a wrapped transport failure is retried", () => {
    // The real case: the proxy layer raises ProxyConnectHandshakeError with the
    // code only in its message and nothing on `code`, so only following `cause`
    // finds it. This is the error the original report produced.
    const inner = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), {
      code: "ECONNREFUSED",
    });
    const wrapped = new Error(`Proxy CONNECT handshake failed: ${inner.message}`);
    wrapped.name = "ProxyConnectHandshakeError";
    (wrapped as { cause?: unknown }).cause = inner;
    expect(isRetryableProbeError(wrapped)).toBe(true);
  });

  test("a code carried only in the message is retried", () => {
    // Bun folds some transport codes into the message and leaves `code` unset.
    expect(isRetryableProbeError(new Error("connect ECONNREFUSED 10.0.0.1:80"))).toBe(true);
  });

  test("a logic fault is not retried", () => {
    // Retrying a programming error hides it and burns the budget.
    expect(isRetryableProbeError(new Error("undefined is not a function"))).toBe(false);
    expect(isRetryableProbeError("not an error object")).toBe(false);
    expect(isRetryableProbeError(undefined)).toBe(false);
  });
});
