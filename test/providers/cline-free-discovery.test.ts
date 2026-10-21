/**
 * The free tier is one catalog behind three providers, and the auto-fetch must
 * not import paid models into it.
 *
 * Both properties were wrong before this file existed:
 *
 *   (a) `recommendedModels` set `free: !subscription`, so every row in Cline's
 *       `recommended` bucket — `anthropic/claude-sonnet-5.5`, `openai/gpt-6-astra`
 *       and friends — was marked free. That is not cosmetic: `defineModel`
 *       prices a `free` row at zero, so the cost surface reported paid models as
 *       free. The upstream settles it: dispatching `anthropic/claude-sonnet-5.5`
 *       answers 402 `insufficient_credits`, while a `free` bucket id answers 200.
 *
 *   (b) Cline's free tier was read from `/ai/cline/recommended-models` alone,
 *       whose `free` bucket files four ids, all spelled `cline-free/…`.
 *       `/models` publishes seventeen ids carrying a `:free` suffix — including
 *       `minimax/minimax-m3.1-flash:free` — and the two rosters do not
 *       intersect at all. Minimax was therefore invisible to auto-fetch.
 *
 * The rosters below are the live listings as observed, trimmed to the ids each
 * assertion turns on. No network: every fetch is injected.
 */
import { describe, expect, test } from "bun:test";
import {
  CLINE_MODELS,
  fetchClineFreeModelIds,
  fetchClineRecommendedModels,
} from "../../src/providers/integrations/cline/cline";
import { KILO_MODELS, KILO_FREE_MODELS } from "../../src/providers/integrations/kilo/kilo";
import { OPENROUTER_MODELS, OPENROUTER_FREE_MODELS } from "../../src/providers/integrations/openrouter/provider";

/** A billed row from Cline's `recommended` bucket. */
const BILLED = "anthropic/claude-sonnet-5.5";
/** A row from the `free` bucket. */
const FREE_BUCKET = "cline-free/mimo-v2.6-flash";
/** A free row only `/models` names. */
const MODELS_ONLY_FREE = "minimax/minimax-m3.1-flash:free";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Routes the three endpoints the discovery touches, so one injected fetcher
 * serves a whole run.
 */
function fetcher(): typeof fetch {
  return (async (input: unknown): Promise<Response> => {
    const url = String(input);
    if (url.endsWith("/ai/cline/recommended-models")) {
      return jsonResponse({
        recommended: [{ id: BILLED, name: "Sonnet" }],
        free: [{ id: FREE_BUCKET, name: "Mimo" }],
        clinePass: [{ id: "cline-pass/kimi-k3", name: "Kimi" }],
        clineCloud: [],
      });
    }
    if (url.endsWith("/ai/cline/models")) {
      return jsonResponse({ data: [] });
    }
    if (url.endsWith("/models")) {
      return jsonResponse({
        object: "list",
        data: [
          { id: MODELS_ONLY_FREE, object: "model" },
          { id: "cohere/north-mini-code:free", object: "model" },
          // Billed ids must not be admitted by the free listing.
          { id: "anthropic/claude-sonnet-5.5", object: "model" },
        ],
      });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

async function discover(pass: boolean) {
  return (await fetchClineRecommendedModels(undefined, pass, fetcher())) ?? [];
}

describe("cline auto-fetch: free means free", () => {
  test("a billed recommended row is not marked free", async () => {
    const models = await discover(false);
    const billed = models.find((m) => m.modelId === BILLED);
    expect(billed).toBeDefined();
    // The defect was `free: !subscription`, which priced this row at zero. A
    // billed row must keep its real price, and must not claim the free tier.
    expect(billed?.cost).not.toEqual({ input: 0, output: 0, pricing_model: "pay-per-use" });
    expect(billed?.freeTier).toBe(false);
  });

  test("a free bucket row is marked free", async () => {
    const models = await discover(false);
    const free = models.find((m) => m.modelId === FREE_BUCKET);
    expect(free?.cost).toEqual({ input: 0, output: 0, pricing_model: "pay-per-use" });
  });

  test("a free row only /models names is discovered", async () => {
    // Minimax was invisible while discovery read the recommended roster alone.
    const models = await discover(false);
    expect(models.some((m) => m.modelId === MODELS_ONLY_FREE)).toBe(true);
  });

  test("a billed id is never admitted by the free listing", async () => {
    const ids = await fetchClineFreeModelIds(fetcher());
    expect(ids).not.toBeNull();
    expect(ids?.every((id) => id.endsWith(":free"))).toBe(true);
    expect(ids).not.toContain(BILLED);
  });
});

describe("the shared free roster", () => {
  test("all three providers carry the same 17 free ids", () => {
    const cline = CLINE_MODELS.filter((m) => m.freeTier === true).map((m) => m.modelId).sort();
    const kilo = KILO_FREE_MODELS.filter((m) => m.freeTier === true).map((m) => m.modelId).sort();
    const openrouter = OPENROUTER_FREE_MODELS.filter((m) => m.freeTier === true)
      .map((m) => m.modelId)
      .sort();
    expect(cline).toHaveLength(17);
    expect(kilo).toEqual(cline);
    expect(openrouter).toEqual(cline);
  });

  test("every free row is priced at zero", () => {
    for (const row of [...CLINE_MODELS, ...KILO_FREE_MODELS, ...OPENROUTER_FREE_MODELS]) {
      expect(row.cost).toEqual({ input: 0, output: 0, pricing_model: "pay-per-use" });
    }
  });

  test("the billed routers are all that remains in the static catalogs", () => {
    // Everything else was a snapshot of one afternoon; discovery is the
    // authority and the free roster is the offline floor.
    expect(KILO_MODELS.map((m) => m.modelId).sort()).toEqual([
      "kilo-auto/free",
      "kilo-auto/small",
      "openrouter/auto",
    ]);
    // `typesafe/jev-1.13` is not a chat row — it is the System One decision
    // route, and deleting it removes a capability rather than a stale entry.
    expect(OPENROUTER_MODELS.map((m) => m.modelId).sort()).toEqual([
      "openrouter/auto",
      "typesafe/jev-1.13",
    ]);
  });

  test("deepseek v4 is gone from Cline's static seed", () => {
    expect(CLINE_MODELS.some((m) => m.modelId.includes("deepseek-v4-flash"))).toBe(false);
  });
});
