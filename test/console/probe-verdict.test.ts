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
import { classifyProviderProbeAnswer } from "../../src/console/routing/pools/probe-verdict";

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
