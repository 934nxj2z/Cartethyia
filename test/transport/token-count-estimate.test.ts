/**
 * The gateway's own `input_tokens` estimate for `/v1/messages/count_tokens`.
 *
 * A Messages client pointed at a route with no counter — a combo of
 * buddy-family chat rows, say — used to get a 400, because there was nothing to
 * forward the count to. The number is now estimated instead, and Claude Code
 * only ever asks it "does this context still fit", so what matters is that it
 * is the same magnitude the reference gateways answer: characters ÷ 4, with a
 * flat reserve per image, counting `system`, every content block that carries
 * context, and `tools`.
 *
 * These assertions pin the arithmetic against those sources' own documented
 * cases, so a "tidier" divisor or a dropped `tools` term cannot pass silently.
 */
import { describe, expect, test } from "bun:test";
import { estimateMessagesInputTokens } from "../../src/transport/dispatch/token-count";

describe("estimateMessagesInputTokens", () => {
  test("prices plain text at one token per four characters", () => {
    // "hello world" is 11 chars; the reference estimators answer 3.
    expect(
      estimateMessagesInputTokens({
        messages: [{ role: "user", content: "hello world" }],
      }),
    ).toBe(3);
  });

  test("counts system text and tool definitions", () => {
    const withSystemOnly = estimateMessagesInputTokens({
      system: "You are a coding assistant.",
      messages: [],
    });
    const withSystemAndTools = estimateMessagesInputTokens({
      system: "You are a coding assistant.",
      tools: [
        {
          name: "Read",
          description: "Read a file",
          input_schema: { type: "object", properties: { file_path: { type: "string" } } },
        },
      ],
      messages: [],
    });
    // A tool schema is real input the follow-up request pays for; omitting it
    // is what makes a count read far below the turn it is meant to gate.
    expect(withSystemAndTools).toBeGreaterThan(withSystemOnly);
  });

  test("prices tool use and tool result payloads, not just their names", () => {
    const estimate = estimateMessagesInputTokens({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_01", name: "Read", input: { file_path: "/tmp/example.txt" } },
            { type: "thinking", thinking: "Need to inspect the file before answering." },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_01", content: "line1 line2 line3 some file content here" },
          ],
        },
      ],
    });
    expect(estimate).toBeGreaterThan(0);
    // The result text alone is ~40 chars ≈ 10 tokens; the round must not be
    // priced at zero, which is how a long transcript reads as tiny.
    expect(estimate).toBeGreaterThan(10);
  });

  test("reserves a flat token budget per image", () => {
    const textOnly = estimateMessagesInputTokens({
      messages: [{ role: "user", content: [{ type: "text", text: "what is this" }] }],
    });
    const withImage = estimateMessagesInputTokens({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
          ],
        },
      ],
    });
    // Binary payloads have no honest character count, so an image takes the
    // flat reserve instead — the same treatment it gets in estimateInputTokens.
    expect(withImage - textOnly).toBe(1_600);
  });

  test("never answers zero for a body with nothing to count", () => {
    expect(estimateMessagesInputTokens({ messages: [] })).toBe(1);
  });
});
