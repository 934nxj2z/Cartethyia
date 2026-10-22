/**
 * An OpenAI-shaped catalog's `context_window` field.
 *
 * Discovery read four spellings of the context field but not this one, so every
 * model on such an upstream fell through to the 200_000 default and was
 * advertised at the same wrong window regardless of what the upstream reported
 * — a 1M-context model shown as 200k. The ceiling is what routing filters on,
 * so the wrong number silently rejects requests that would have fit.
 */
import { describe, expect, test } from "bun:test";
import { fetchOpenAICompatibleModels } from "../../src/providers/discovery/openai-model-discovery";

function fetcherFor(payload: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("discovery reads context_window", () => {
  test("a 1M model is advertised at 1M, not the default", async () => {
    const models = await fetchOpenAICompatibleModels({
      baseUrl: "https://upstream.test/v1",
      fetcher: fetcherFor({
        data: [{ id: "claude-opus-4-6", context_window: 1_000_000, max_output_tokens: 128_000 }],
      }),
    });

    expect(models).toHaveLength(1);
    expect(models?.[0]?.contextLimit).toBe(1_000_000);
  });

  test("a smaller window is not rounded up to the default", async () => {
    const models = await fetchOpenAICompatibleModels({
      baseUrl: "https://upstream.test/v1",
      fetcher: fetcherFor({
        data: [{ id: "kimi-k2.6", context_window: 262_144, max_output_tokens: 262_144 }],
      }),
    });

    expect(models?.[0]?.contextLimit).toBe(262_144);
  });

  test("a model that states none still falls back rather than failing", async () => {
    const models = await fetchOpenAICompatibleModels({
      baseUrl: "https://upstream.test/v1",
      fetcher: fetcherFor({ data: [{ id: "no-window", max_output_tokens: 1_000 }] }),
    });

    expect(models).toHaveLength(1);
    expect(models?.[0]?.contextLimit).toBe(200_000);
  });
});
