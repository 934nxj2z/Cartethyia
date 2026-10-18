/**
 * `/models` entries that declare limits inside a `modality` array.
 *
 * Several OpenAI-compatible catalogs — intern-ai's discovery API among them —
 * put the window under `input_modalities[].supported_inputs.max_context_length
 * .value` and the output bound under `output_modalities[].max_length.value`,
 * rather than on a flat `context_length` / `max_output_tokens` field. The
 * fetcher read only the flat aliases, so every model on such an upstream fell
 * through to the same 200_000 × 64_192 defaults and was advertised at a window
 * that had nothing to do with what it could hold — which is what routing then
 * sized prompts against.
 *
 * Only the `text` modality carries a context length; an `image` entry says how
 * images may be supplied instead, and image input is what makes the model a
 * vision one.
 */
import { describe, expect, test } from "bun:test";
import { fetchOpenAICompatibleModels } from "../../src/providers/discovery/openai-model-discovery";

/** One entry in the shape the upstream serves, trimmed to the limit fields. */
function nestedEntry(id: string, context: number, output: number, image = false) {
  return {
    id,
    input_modalities: [
      { type: "text", supported_inputs: { max_context_length: { value: context, unit: "token" } } },
      ...(image ? [{ type: "image", supported_inputs: { sources: { type: "enum", values: ["url", "base64"] } } }] : []),
    ],
    output_modalities: [
      { type: "text", max_length: { value: output, unit: "token" }, streaming: true },
    ],
  };
}

async function discover(entries: readonly unknown[]) {
  return fetchOpenAICompatibleModels({
    baseUrl: "https://upstream.example/v1",
    fetcher: (async () => new Response(JSON.stringify({ object: "list", data: entries }))) as never,
  });
}

describe("nested modality limits", () => {
  test("the context window comes from input_modalities, not the 200k default", async () => {
    // The bug: this read 200_000 for a model that holds a million tokens.
    const models = await discover([nestedEntry("deepseek-v4-flash-0731", 1048576, 1048576)]);
    expect(models?.[0]?.contextLimit).toBe(1048576);
  });

  test("the output bound comes from output_modalities, not the default", async () => {
    const models = await discover([nestedEntry("glm-5.3", 1048576, 1048576)]);
    expect(models?.[0]?.outputLimit).toBe(1048576);
  });

  test("each model keeps its own window", async () => {
    // Not one shared fallback: the catalog mixes 262k and 1M models.
    const models = await discover([
      nestedEntry("Agents-A1", 262144, 262144, true),
      nestedEntry("Atria-Dawn", 524288, 524288),
      nestedEntry("deepseek-v4-pro-0813", 1048576, 1048576),
    ]);
    expect(models?.map((m) => m.contextLimit)).toEqual([262144, 524288, 1048576]);
  });

  test("an image entry marks the model as vision", async () => {
    const models = await discover([nestedEntry("kimi-k2.6", 262144, 262144, true)]);
    expect(models?.[0]?.modalities.input).toContain("image");
  });

  test("a text-only entry stays text-only", async () => {
    const models = await discover([nestedEntry("minimax-m3", 1048576, 1048576)]);
    expect(models?.[0]?.modalities.input).toEqual(["text"]);
  });

  test("a flat context_length still wins over the nested shape", async () => {
    // Not a regression: existing upstreams keep their own precedence.
    const models = await discover([
      { id: "flat", context_length: 128_000, input_modalities: [{ type: "text", supported_inputs: { max_context_length: { value: 999 } } }] },
    ]);
    expect(models?.[0]?.contextLimit).toBe(128_000);
  });

  test("a modality array with no text entry falls back instead of crashing", async () => {
    // An image-only entry declares no context; the default is the honest answer.
    const models = await discover([
      { id: "image-only", input_modalities: [{ type: "image", supported_inputs: {} }] },
    ]);
    expect(models?.[0]?.contextLimit).toBe(200_000);
  });

  test("a malformed nested value falls back instead of propagating", async () => {
    const models = await discover([
      { id: "junk", input_modalities: [{ type: "text", supported_inputs: { max_context_length: { value: "lots" } } }] },
    ]);
    expect(models?.[0]?.contextLimit).toBe(200_000);
  });
});
