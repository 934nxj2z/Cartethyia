/**
 * Field reading in the OpenAI-compatible `/models` discovery.
 *
 * The failure this guards is silent and uniform: an unrecognised field name
 * falls through to a default, so every model on that upstream is advertised at
 * the same wrong number and nothing errors. A 384k-output model published at
 * the 64_192 default just truncates longer answers, and a vision model read as
 * text-only has its image parts dropped before dispatch.
 */
import { describe, expect, test } from "bun:test";
import { fetchOpenAICompatibleModels } from "../../src/providers/discovery/openai-model-discovery";

/** Answers `/models` with one payload and records nothing. */
function fetcherWith(payload: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

async function discover(payload: unknown) {
  return fetchOpenAICompatibleModels({
    baseUrl: "https://upstream.test/v1",
    providerId: "probe",
    fetcher: fetcherWith(payload),
  });
}

describe("output limit", () => {
  test("reads max_completion_tokens, the OpenAI spelling", async () => {
    // The name this gateway's own /v1/models emits. A reader that knew only
    // max_output_tokens/maxTokens saw none and used the 64_192 default.
    const models = await discover({
      data: [{ id: "m1", context_length: 1_000_000, max_completion_tokens: 384_000 }],
    });
    expect(models?.[0]?.outputLimit).toBe(384_000);
  });

  test("still reads the other spellings", async () => {
    const models = await discover({
      data: [{ id: "m1", context_length: 1_000_000, max_output_tokens: 131_072 }],
    });
    expect(models?.[0]?.outputLimit).toBe(131_072);
  });

  test("output never exceeds context", async () => {
    const models = await discover({
      data: [{ id: "m1", context_length: 8_000, max_completion_tokens: 999_999 }],
    });
    expect(models?.[0]?.outputLimit).toBe(8_000);
  });
});

describe("capabilities", () => {
  test("image input from a capabilities.input array", async () => {
    // OpenAI-shaped catalogs name modalities as strings, not as the structured
    // input_modalities[] objects the sibling reader expects.
    const models = await discover({
      data: [
        {
          id: "m1",
          context_length: 100_000,
          max_completion_tokens: 8_000,
          capabilities: { input: ["text", "image"], output: ["text"] },
        },
      ],
    });
    expect(models?.[0]?.modalities.input).toEqual(["text", "image"]);
  });

  test("text-only stays text-only", async () => {
    const models = await discover({
      data: [
        {
          id: "m1",
          context_length: 100_000,
          max_completion_tokens: 8_000,
          capabilities: { input: ["text"], output: ["text"] },
        },
      ],
    });
    expect(models?.[0]?.modalities.input).toEqual(["text"]);
  });

  test("image input from the structured modality array still works", async () => {
    const models = await discover({
      data: [
        {
          id: "m1",
          context_length: 100_000,
          max_completion_tokens: 8_000,
          input_modalities: [{ type: "text" }, { type: "image" }],
        },
      ],
    });
    expect(models?.[0]?.modalities.input).toEqual(["text", "image"]);
  });
});

describe("declared capabilities", () => {
  test("reasoning is taken from the upstream", async () => {
    const models = await discover({
      data: [{ id: "m1", context_length: 100_000, max_completion_tokens: 8_000, reasoning: true }],
    });
    expect(models?.[0]?.reasoning).toBe(true);
  });

  test("reasoning defaults to false when unstated", async () => {
    const models = await discover({
      data: [{ id: "m1", context_length: 100_000, max_completion_tokens: 8_000 }],
    });
    expect(models?.[0]?.reasoning).toBe(false);
  });

  test("tool_call false is honoured", async () => {
    const models = await discover({
      data: [{ id: "m1", context_length: 100_000, max_completion_tokens: 8_000, tool_call: false }],
    });
    expect(models?.[0]?.toolCall).toBe(false);
  });
});
