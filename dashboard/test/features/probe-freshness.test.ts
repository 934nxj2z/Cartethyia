import { describe, expect, test } from "bun:test";
import { liveProbeFor } from "../../src/features/proxy/probe-freshness";
import type { PoolProviderProbeResult } from "../../../src/console/routing/pools/contracts";

function verdict(status: PoolProviderProbeResult["status"]): PoolProviderProbeResult {
  return { poolId: "p1", providerId: "opencode", status };
}

/**
 * A probe verdict is a statement about one egress address.
 *
 * Showing it against a different address is how a pool that had been re-pointed
 * from a blocked proxy to a working one kept reading "OpenCode blocked": the
 * verdict was keyed by pool id alone, so nothing noticed the endpoint had
 * changed underneath it. The operator had no way to tell a fresh verdict from a
 * stale one.
 */
describe("probe freshness", () => {
  test("a verdict applies while the endpoint is unchanged", () => {
    const stored = { endpoint: "1.2.3.4:8080", result: verdict("allowed") };
    expect(liveProbeFor(stored, "1.2.3.4:8080")).toMatchObject({ status: "allowed" });
  });

  test("an edited endpoint discards the verdict", () => {
    const stored = { endpoint: "1.2.3.4:8080", result: verdict("blocked") };
    // The address was replaced; the old refusal says nothing about the new one.
    expect(liveProbeFor(stored, "5.6.7.8:9090")).toBeUndefined();
  });

  test("a verdict recorded before the endpoint was known is kept", () => {
    // The add form reports a probe result before the refetch lands, so the
    // endpoint is briefly empty. Dropping it would hide a real result.
    const stored = { endpoint: "", result: verdict("allowed") };
    expect(liveProbeFor(stored, "1.2.3.4:8080")).toMatchObject({ status: "allowed" });
  });

  test("no stored verdict means no badge", () => {
    expect(liveProbeFor(undefined, "1.2.3.4:8080")).toBeUndefined();
  });

  test("a null endpoint on the row compares as empty", () => {
    const stored = { endpoint: "", result: verdict("throttled") };
    expect(liveProbeFor(stored, null)).toMatchObject({ status: "throttled" });
  });
});
