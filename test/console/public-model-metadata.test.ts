import { describe, expect, test } from "bun:test";
import {
  advertisedMetadata,
  resolveTargetIds,
  type ModelMetadata,
} from "../../src/console/providers/catalog/public-model-store";

const meta = (contextLimit: number, outputLimit: number): ModelMetadata => ({
  contextLimit,
  outputLimit,
  modalities: { input: ["text"], output: ["text"] },
  reasoning: true,
  toolCall: true,
  webSearch: false,
  cost: null,
});

describe("public model metadata resolution", () => {
  test("walks combo members and aliases to concrete ids", () => {
    const aliases = new Map([["bansos/deepseek-v4.1-flash", "deepseek-pool"]]);
    const combos = new Map([
      ["deepseek-pool", ["cb/deepseek-v4.1-flash", "cbcn/deepseek-v4.1-flash"]],
    ]);
    expect(resolveTargetIds("bansos/deepseek-v4.1-flash", aliases, combos)).toEqual([
      "cb/deepseek-v4.1-flash",
      "cbcn/deepseek-v4.1-flash",
    ]);
  });

  test("a member that states its own limits describes the pool", () => {
    // The old rule took the minimum across members, so an alias over these two
    // advertised 50k output — a pool that can serve 384k reading as one that
    // cannot, and the weaker member's ceiling binding the whole route.
    const metadata = new Map<string, ModelMetadata>([
      ["cb/deepseek-v4.1-flash", meta(1_000_000, 384_000)],
      ["cbcn/deepseek-v4.1-flash", meta(1_000_000, 50_000)],
    ]);
    const result = advertisedMetadata(
      ["cb/deepseek-v4.1-flash", "cbcn/deepseek-v4.1-flash"],
      metadata,
    );
    expect(result.contextLimit).toBe(1_000_000);
    expect(result.outputLimit).toBe(384_000);
  });

  test("the winning member carries its capabilities too, not just its limits", () => {
    // The defect as reported: `cb` has a 1M/384k window with vision and tools,
    // `opencode` is 200k/64k without them, and the pool advertised the latter
    // — dropping vision entirely because one member lacked it.
    const metadata = new Map<string, ModelMetadata>([
      ["cb/deepseek-v4.1-flash", { ...meta(1_000_000, 384_000), toolCall: true }],
      ["opencode/deepseek-v4.1-flash", { ...meta(200_000, 64_000), toolCall: false }],
    ]);
    const result = advertisedMetadata(
      ["cb/deepseek-v4.1-flash", "opencode/deepseek-v4.1-flash"],
      metadata,
    );
    expect(result.contextLimit).toBe(1_000_000);
    expect(result.outputLimit).toBe(384_000);
    expect(result.toolCall).toBe(true);
  });

  test("an estimated member is skipped rather than winning by position", () => {
    // "First" alone would let a placeholder outrank a real measurement: rows
    // whose limits are the shared fallback must not describe the pool while a
    // filed member is available.
    const metadata = new Map<string, ModelMetadata>([
      ["unfiled/deepseek-v4.1-flash", { ...meta(512_000, 131_072), limitsEstimated: true }],
      ["cb/deepseek-v4.1-flash", meta(1_000_000, 384_000)],
    ]);
    const result = advertisedMetadata(
      ["unfiled/deepseek-v4.1-flash", "cb/deepseek-v4.1-flash"],
      metadata,
    );
    expect(result.contextLimit).toBe(1_000_000);
    expect(result.outputLimit).toBe(384_000);
    expect(result.limitsEstimated).toBeUndefined();
  });

  test("all-estimated members still aggregate conservatively", () => {
    // No member states its own limits, so none is preferable: the conservative
    // minimum remains the honest answer, and the estimate is marked.
    const metadata = new Map<string, ModelMetadata>([
      ["a/deepseek-v4.1-flash", { ...meta(512_000, 200_000), limitsEstimated: true }],
      ["b/deepseek-v4.1-flash", { ...meta(512_000, 131_072), limitsEstimated: true }],
    ]);
    const result = advertisedMetadata(
      ["a/deepseek-v4.1-flash", "b/deepseek-v4.1-flash"],
      metadata,
    );
    expect(result.outputLimit).toBe(131_072);
    expect(result.limitsEstimated).toBe(true);
  });

  test("no describable member falls back to a null-limit entry", () => {
    const result = advertisedMetadata(["nope/deepseek-v4.1-flash"], new Map());
    expect(result.contextLimit).toBeNull();
    expect(result.reasoning).toBe(false);
  });

  test("cycle protection returns no fabricated target", () => {
    const aliases = new Map([
      ["a", "b"],
      ["b", "a"],
    ]);
    expect(resolveTargetIds("a", aliases, new Map())).toEqual([]);
  });
});
