import { describe, expect, test } from "bun:test";
import {
  GITHUB_EXCLUDED_MODEL_IDS,
  GITHUB_MODELS,
  githubModelRoute,
} from "../../src/providers/integrations/github/github";

import { discoverGithubModels } from "../../src/providers/integrations/github/github-discovery";

describe("GitHub Copilot fallback model catalog", () => {
  test("omits models that failed reachability checks", () => {
    const modelIds = new Set(GITHUB_MODELS.map((model) => model.modelId));

    for (const modelId of GITHUB_EXCLUDED_MODEL_IDS) {
      expect(modelIds.has(modelId), modelId).toBe(false);
    }
  });

  test("keeps models verified as reachable", () => {
    const modelIds = new Set(GITHUB_MODELS.map((model) => model.modelId));

    expect(modelIds.has("copilot-search-a")).toBe(true);
    expect(modelIds.has("copilot-search-b")).toBe(true);
    expect(modelIds.has("gpt-3.5-turbo-0613")).toBe(true);
    expect(modelIds.has("gpt-4.1")).toBe(true);
    expect(modelIds.has("gpt-4o")).toBe(true);
    expect(modelIds.has("gpt-4o-mini")).toBe(true);
  });

  test("publishes all Auto routing tiers in the fallback catalog", () => {
    const modelIds = new Set(GITHUB_MODELS.map((model) => model.modelId));

    expect(modelIds.has("gpt-6-luna")).toBe(true);
    expect(modelIds.has("gpt-6-luna-low")).toBe(false);
    expect(modelIds.has("gpt-6-luna-medium")).toBe(false);
    expect(modelIds.has("gpt-6-luna-high")).toBe(false);
    expect(modelIds.has("auto")).toBe(true);
    expect(modelIds.has("auto-efficiency")).toBe(false);
    expect(modelIds.has("auto-balance")).toBe(false);
    expect(modelIds.has("auto-intelligence")).toBe(false);
  });

  test("removes retired Luna variants and keeps the canonical efficiency alias", async () => {
    const credential = JSON.stringify({ access: "token", apiHost: "copilot.example" });
    const response = new Response(JSON.stringify({
      data: [
        ...[...GITHUB_EXCLUDED_MODEL_IDS].map((id) => ({
          id,
          supported_endpoints: ["/chat/completions"],
        })),
        { id: "gpt-6-luna", supported_endpoints: ["/responses"] },
        { id: "gpt-4.1", supported_endpoints: ["/chat/completions"] },
      ],
    }));
    const models = await discoverGithubModels({
      credential,
      fetcher: Object.assign(async () => response, {
        preconnect: fetch.preconnect.bind(fetch),
      }),
    });

    const modelIds = new Set(models?.map((model) => model.modelId));
    expect(modelIds.has("gpt-4.1")).toBe(true);
    expect(modelIds.has("gpt-6-luna")).toBe(true);
    expect(modelIds.has("gpt-6-luna-low")).toBe(false);
    expect(modelIds.has("gpt-6-luna-medium")).toBe(false);
    expect(modelIds.has("gpt-6-luna-high")).toBe(false);
    expect(await githubModelRoute("gpt-6-luna", credential)).toEqual({
      wireFamily: "responses",
      endpointPath: "/responses",
    });
  });



  test("does not overwrite a discovered catalog row with the static virtual limits", async () => {
    const credential = JSON.stringify({
      access: "catalog-access",
      apiHost: "copilot.example",
      github: "catalog-refresh",
    });
    const models = await discoverGithubModels({
      credential,
      fetcher: Object.assign(
        async () => new Response(JSON.stringify({
          data: [{
            id: "gpt-6-luna",
            supported_endpoints: ["/responses"],
            capabilities: {
              limits: {
                max_context_window_tokens: 1_000_000,
                max_output_tokens: 128_000,
                max_prompt_tokens: 872_000,
              },
            },
          }],
        })),
        { preconnect: fetch.preconnect.bind(fetch) },
      ),
    });
    const row = models?.find((model) => model.modelId === "gpt-6-luna");
    expect(row?.contextLimit).toBe(1_000_000);
    expect(row?.outputLimit).toBe(128_000);
  });
});
