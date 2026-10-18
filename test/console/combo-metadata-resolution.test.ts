/**
 * A combo or alias is described by the member that states its own limits.
 *
 * Both surfaces used to aggregate conservatively — minimum limits, and only the
 * capabilities every member shares — which described a pool by its weakest
 * route. A combo over a 1M/384k member and a 200k/64k member advertised 64k
 * output and dropped vision, so the number a client read before routing
 * contradicted what the pool could actually serve.
 *
 * These pin the replacement rule at both places it applies: the public model
 * list (`advertisedMetadata`) and the routing console's own combo row
 * (`mapComboRow`).
 */
import { describe, expect, test } from "bun:test";
import {
  advertisedMetadata,
  resolveTargetIds,
  type ModelMetadata,
} from "../../src/console/providers/catalog/public-model-store";
import { mapAliasRow, mapComboRow } from "../../src/console/routing/model/store";
import { modelsDevCatalog } from "../../src/providers/discovery/models-dev-catalog";

/** A combo member as the public store sees it, with one capability off. */
function member(
  contextLimit: number | null,
  outputLimit: number | null,
  extra: Partial<ModelMetadata> = {},
): ModelMetadata {
  return {
    contextLimit,
    outputLimit,
    modalities: { input: ["text"], output: ["text"] },
    reasoning: true,
    toolCall: true,
    webSearch: false,
    cost: null,
    ...extra,
  };
}

describe("combo metadata resolution", () => {
  test("the widest member wins, not the narrowest", () => {
    // The reported case. `cb` files this model at 1M/384k; the combo used to
    // publish the 64k ceiling of its other member.
    const metadata = new Map<string, ModelMetadata>([
      ["cb/deepseek-v4.1-flash", member(1_000_000, 384_000)],
      ["opencode/deepseek-v4.1-flash", member(200_000, 64_000)],
    ]);
    const result = advertisedMetadata(
      ["cb/deepseek-v4.1-flash", "opencode/deepseek-v4.1-flash"],
      metadata,
    );
    expect(result.contextLimit).toBe(1_000_000);
    expect(result.outputLimit).toBe(384_000);
  });

  test("capabilities come from the same member as the limits", () => {
    // Mixing would be worse than either rule alone: a 384k window paired with
    // "no tools" describes no member that exists.
    const metadata = new Map<string, ModelMetadata>([
      ["cb/deepseek-v4.1-flash", member(1_000_000, 384_000, { toolCall: true, reasoning: true })],
      ["opencode/deepseek-v4.1-flash", member(200_000, 64_000, { toolCall: false, reasoning: false })],
    ]);
    const result = advertisedMetadata(
      ["cb/deepseek-v4.1-flash", "opencode/deepseek-v4.1-flash"],
      metadata,
    );
    expect(result.toolCall).toBe(true);
    expect(result.reasoning).toBe(true);
  });

  test("an alias resolves through its combo to the same answer", () => {
    const aliases = new Map([["bansos/deepseek-v4.1-flash", "deepseek-pool"]]);
    const combos = new Map([
      ["deepseek-pool", ["cb/deepseek-v4.1-flash", "opencode/deepseek-v4.1-flash"]],
    ]);
    const metadata = new Map<string, ModelMetadata>([
      ["cb/deepseek-v4.1-flash", member(1_000_000, 384_000)],
      ["opencode/deepseek-v4.1-flash", member(200_000, 64_000)],
    ]);
    const ids = resolveTargetIds("bansos/deepseek-v4.1-flash", aliases, combos);
    expect(ids).toEqual(["cb/deepseek-v4.1-flash", "opencode/deepseek-v4.1-flash"]);
    expect(advertisedMetadata(ids, metadata).outputLimit).toBe(384_000);
  });

  test("members with no window at all fall back to the advertised default", () => {
    // No member states a window, so there is nothing to prefer. The caller's
    // default still applies — an undescribed pool must publish some number for
    // a client to size against, and the estimate is not marked here because
    // `advertisedMetadata` leaves that to the row's own `limitsEstimated`.
    const result = advertisedMetadata(
      ["unknown-a/model", "unknown-b/model"],
      new Map([
        ["unknown-a/model", member(null, null)],
        ["unknown-b/model", member(null, null)],
      ]),
    );
    expect(result.contextLimit).toBe(200_000);
    expect(result.outputLimit).toBe(64_192);
  });
});

describe("routing console combo row", () => {
  /** Two ids the catalog files at clearly different windows. */
  const WIDE = "deepseek-v4.1-flash";
  const NARROW = "gpt-5";

  test("reads a member the catalog actually files", () => {
    // The regression: `resolve("", member)` fails closed on any catalog
    // disagreement, and a popular bare id is filed by many resellers that
    // rarely agree — so every combo silently showed the hardcoded 200k/64k
    // default regardless of its members.
    const row = mapComboRow({
      id: "c1",
      tenantId: "t1",
      name: "pool",
      members: [WIDE],
      strategy: "fallback",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    expect(row.contextLimit).toBe(modelsDevCatalog.majorityFor(WIDE)?.contextLimit);
    expect(row.contextLimit).not.toBe(200_000);
  });

  test("publishes the widest member's window, not the narrowest", () => {
    const wide = modelsDevCatalog.majorityFor(WIDE)?.contextLimit ?? 0;
    const narrow = modelsDevCatalog.majorityFor(NARROW)?.contextLimit ?? 0;
    expect(wide).toBeGreaterThan(narrow);
    const row = mapComboRow({
      id: "c2",
      tenantId: "t1",
      name: "pool",
      members: [NARROW, WIDE],
      strategy: "fallback",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    expect(row.contextLimit).toBe(wide);
  });

  test("a member the catalog does not file falls back to the default", () => {
    const row = mapComboRow({
      id: "c3",
      tenantId: "t1",
      name: "pool",
      members: ["not-a-model-xyz"],
      strategy: "fallback",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    expect(row.contextLimit).toBe(200_000);
    expect(row.outputLimit).toBe(64_192);
  });
});

describe("routing console alias row", () => {
  test("reads a target the catalog actually files", () => {
    // The same dead-resolve bug as a combo member: an alias to a widely-resold
    // id always showed 200k/64k because `resolve("", …)` fails closed on any
    // catalog disagreement.
    const row = mapAliasRow({
      id: "a1",
      tenantId: "t1",
      alias: "fast",
      targetModel: "gpt-5",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    expect(row.contextLimit).toBe(modelsDevCatalog.majorityFor("gpt-5")?.contextLimit);
    expect(row.contextLimit).not.toBe(200_000);
  });

  test("a target the catalog does not file falls back to the default", () => {
    const row = mapAliasRow({
      id: "a2",
      tenantId: "t1",
      alias: "mystery",
      targetModel: "not-a-model-xyz",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    expect(row.contextLimit).toBe(200_000);
    expect(row.outputLimit).toBe(64_192);
  });

  test("a qualified target resolves through its bare id", () => {
    const row = mapAliasRow({
      id: "a3",
      tenantId: "t1",
      alias: "flash",
      targetModel: "cb/deepseek-v4.1-flash",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    expect(row.contextLimit).toBe(modelsDevCatalog.majorityFor("deepseek-v4.1-flash")?.contextLimit);
  });
});
