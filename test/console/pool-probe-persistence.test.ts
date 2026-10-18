/**
 * A stored probe verdict must describe the pool as it stands.
 *
 * The verdict moved out of `localStorage` and onto the pool row because the
 * browser copy was invisible to everyone else: another machine saw nothing, the
 * gateway saw nothing, and admission kept choosing a pool the badge called
 * blocked. Moving it into the database only helps if it can still be wrong —
 * so the row records **which endpoint** the verdict was measured against, and a
 * pool that has since been re-pointed reports "never probed" rather than
 * showing a colour about an address that no longer exists.
 */
import { describe, expect, test } from "bun:test";
import { storedProviderProbe } from "../../src/console/routing/pools/store";
import { networkPools } from "../../src/persistence/schema";

/** A row as Drizzle would hand it back, with only the probe fields set. */
function row(overrides: Partial<typeof networkPools.$inferSelect>) {
  return {
    providerProbeProviderId: null,
    providerProbeStatus: null,
    providerProbeHttpStatus: null,
    providerProbeReason: null,
    providerProbeLatencyMs: null,
    providerProbeAt: null,
    providerProbeEndpoint: null,
    ...overrides,
  } as typeof networkPools.$inferSelect;
}

describe("stored provider probe", () => {
  test("a verdict on the current endpoint is reported", () => {
    const probe = storedProviderProbe(
      row({
        providerProbeProviderId: "opencode",
        providerProbeStatus: "blocked",
        providerProbeEndpoint: "1.2.3.4:8080",
        providerProbeAt: new Date("2026-10-17T10:00:00Z"),
        providerProbeHttpStatus: 403,
        providerProbeReason: "Upstream refused this egress address",
      }),
      "1.2.3.4:8080",
    );
    expect(probe).toMatchObject({
      providerId: "opencode",
      status: "blocked",
      endpoint: "1.2.3.4:8080",
      httpStatus: 403,
      checkedAt: "2026-10-17T10:00:00.000Z",
    });
  });

  test("a verdict about a different endpoint is not reported", () => {
    // The operator re-pointed the pool. The old refusal says nothing about the
    // new address, so showing it would be a stale claim, not a measurement.
    const probe = storedProviderProbe(
      row({
        providerProbeProviderId: "opencode",
        providerProbeStatus: "blocked",
        providerProbeEndpoint: "1.2.3.4:8080",
        providerProbeAt: new Date("2026-10-17T10:00:00Z"),
      }),
      "5.6.7.8:9090",
    );
    expect(probe).toBeUndefined();
  });

  test("an unprobed row reports nothing", () => {
    expect(storedProviderProbe(row({}), "1.2.3.4:8080")).toBeUndefined();
  });

  test("a row written before the endpoint was recorded is not trusted", () => {
    // No address to compare against, so the claim cannot be validated.
    const probe = storedProviderProbe(
      row({
        providerProbeProviderId: "opencode",
        providerProbeStatus: "allowed",
        providerProbeEndpoint: null,
        providerProbeAt: new Date("2026-10-17T10:00:00Z"),
      }),
      "1.2.3.4:8080",
    );
    expect(probe).toBeUndefined();
  });

  test("an unknown status is ignored rather than shown", () => {
    const probe = storedProviderProbe(
      row({
        providerProbeProviderId: "opencode",
        providerProbeStatus: "bogus",
        providerProbeEndpoint: "1.2.3.4:8080",
        providerProbeAt: new Date("2026-10-17T10:00:00Z"),
      }),
      "1.2.3.4:8080",
    );
    expect(probe).toBeUndefined();
  });

  test("throttled and unreachable are reported like any other verdict", () => {
    for (const status of ["throttled", "unreachable", "allowed"] as const) {
      const probe = storedProviderProbe(
        row({
          providerProbeProviderId: "opencode",
          providerProbeStatus: status,
          providerProbeEndpoint: "1.2.3.4:8080",
          providerProbeAt: new Date("2026-10-17T10:00:00Z"),
        }),
        "1.2.3.4:8080",
      );
      expect(probe?.status).toBe(status);
    }
  });
});
