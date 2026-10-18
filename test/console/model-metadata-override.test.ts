/**
 * Model metadata overrides: the fallback ceilings and the passthrough rule.
 *
 * These are the two decisions that would otherwise be invisible: that an unknown
 * limit is `null` rather than a number, and that passthrough grants every
 * capability rather than adding to a list.
 */
import { describe, expect, test } from "bun:test";
import {
  FALLBACK_CONTEXT_LIMIT,
  FALLBACK_OUTPUT_LIMIT,
  applyModelMetadataOverride,
  resolveManualModelMetadata,
} from "../../src/providers/provider-model-definition";
import { mapModelRow, withImageModality } from "../../src/console/providers/catalog/store";

describe("fallback ceilings", () => {
  test("are large enough to never be the binding constraint", () => {
    // A ceiling that is too low truncates a working request; one that is too
    // high only means the upstream refuses on its own terms. So the fallback
    // must sit above every current frontier model.
    expect(FALLBACK_CONTEXT_LIMIT).toBeGreaterThanOrEqual(200_000);
    expect(FALLBACK_OUTPUT_LIMIT).toBeGreaterThanOrEqual(32_000);
  });

  test("are the documented 512k / 131k", () => {
    expect(FALLBACK_CONTEXT_LIMIT).toBe(512_000);
    expect(FALLBACK_OUTPUT_LIMIT).toBe(131_072);
  });
});

describe("applyModelMetadataOverride", () => {
  const base = resolveManualModelMetadata("factory", "a-model-nobody-knows");

  test("an absent override is a no-op", () => {
    expect(applyModelMetadataOverride(base, undefined)).toEqual(base);
  });

  test("absent fields leave the stored value alone", () => {
    // An edit that only sets the context ceiling must not reset the flags.
    const next = applyModelMetadataOverride(base, { contextLimit: 200_000 });
    expect(next.contextLimit).toBe(200_000);
    expect(next.outputLimit).toBe(base.outputLimit);
    expect(next.toolCall).toBe(base.toolCall);
  });

  test("null means unknown, not zero", () => {
    const next = applyModelMetadataOverride(base, { contextLimit: null });
    expect(next.contextLimit).toBeNull();
  });

  test("passthrough grants every capability", () => {
    const next = applyModelMetadataOverride(base, { passthrough: true });
    expect(next.reasoning).toBe(true);
    expect(next.toolCall).toBe(true);
    expect(next.modalities.input).toContain("image");
  });

  test("passthrough cannot be partly revoked by a per-flag false", () => {
    // The point of passthrough is that the operator does not know which
    // capabilities the model has, so an explicit false beside it is either
    // stale or a mistake. Passthrough wins.
    const next = applyModelMetadataOverride(base, {
      passthrough: true,
      image: false,
      toolCall: false,
    });
    expect(next.toolCall).toBe(true);
    expect(next.modalities.input).toContain("image");
  });

  test("a per-flag false is honored when passthrough is off", () => {
    const next = applyModelMetadataOverride(base, { image: false });
    expect(next.modalities.input).not.toContain("image");
  });
});

describe("withImageModality", () => {
  test("adds image to a text-only blob", () => {
    const next = JSON.parse(withImageModality(JSON.stringify({ input: ["text"] }), true)) as {
      input: string[];
    };
    expect(next.input).toContain("image");
    expect(next.input).toContain("text");
  });

  test("removes image without dropping text", () => {
    const next = JSON.parse(
      withImageModality(JSON.stringify({ input: ["text", "image", "pdf"] }), false),
    ) as { input: string[] };
    expect(next.input).not.toContain("image");
    expect(next.input).toContain("text");
    expect(next.input).toContain("pdf");
  });

  test("an unparseable blob is replaced rather than left to corrupt preflight", () => {
    const next = JSON.parse(withImageModality("not json{", true)) as { input: string[] };
    expect(next.input).toContain("image");
  });

  test("a null blob is treated as absent, not as an error", () => {
    const next = JSON.parse(withImageModality(null, true)) as { input: string[] };
    expect(next.input).toContain("image");
  });

  test("never produces an empty input list", () => {
    // An empty modality list makes capability preflight treat the route as
    // unable to accept anything.
    const next = JSON.parse(withImageModality(JSON.stringify({ input: ["image"] }), false)) as {
      input: string[];
    };
    expect(next.input.length).toBeGreaterThan(0);
  });
});

/**
 * The unsized row, as the console reads it.
 *
 * A model the catalog cannot size was projected with `null` limits, so its card
 * read `n/a ctx · n/a out` while the route was perfectly routable — a working
 * model that looked unusable. The ceiling is now substituted at the read, which
 * keeps the stored `null` honest (upstream really did say nothing) while the
 * console shows a number and flags it as a guess.
 *
 * Driven through `mapModelRow` rather than a store, because the decision is
 * purely a function of one row.
 */
describe("unsized model rows", () => {
  /** A persisted `models` row; only the fields the projection reads matter. */
  function row(overrides: Partial<Record<string, unknown>>) {
    return {
      modelId: "a-model-nobody-knows",
      providerId: "factory",
      wireFamily: "chat",
      endpointPath: "/v1/chat/completions",
      serviceKind: "llm",
      enabled: true,
      contextLimit: null,
      outputLimit: null,
      modalities: { input: ["text"], output: ["text"] },
      reasoning: false,
      toolCall: false,
      cost: null,
      source: "manual",
      sourceUpdatedAt: null,
      ...overrides,
    } as unknown as Parameters<typeof mapModelRow>[0];
  }

  test("an unfiled row is shown with the fallback, marked estimated", () => {
    const entry = mapModelRow(row({}), false);
    expect(entry.contextLimit).toBe(FALLBACK_CONTEXT_LIMIT);
    expect(entry.outputLimit).toBe(FALLBACK_OUTPUT_LIMIT);
    expect(entry.limitsEstimated).toBe(true);
  });

  test("a row with its own limit keeps it and carries no marker", () => {
    // The substitution must not overwrite a number upstream actually stated.
    const entry = mapModelRow(row({ contextLimit: 200_000, outputLimit: 8_192 }), false);
    expect(entry.contextLimit).toBe(200_000);
    expect(entry.outputLimit).toBe(8_192);
    expect(entry.limitsEstimated).toBeUndefined();
  });

  test("a row the base catalog can size keeps null rather than inventing a number", () => {
    // The catalog knows this id, so nothing was "unfiled" — the row's own
    // `null` is a gap in the listing, not a model nobody has heard of, and the
    // card should say so instead of showing a confident fallback.
    const entry = mapModelRow(row({ modelId: "deepseek-chat", providerId: "deepseek" }), false);
    expect(entry.contextLimit).toBeNull();
    expect(entry.limitsEstimated).toBeUndefined();
  });

  test("the substitution is display-only: the row itself is untouched", () => {
    const stored = row({});
    mapModelRow(stored, false);
    expect(stored.contextLimit).toBeNull();
  });
});
