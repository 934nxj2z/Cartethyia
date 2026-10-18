import { describe, expect, test } from "bun:test";
import { stripThinkingTags } from "../../src/providers/integrations/xiaomi-mimo/think-stream";

/**
 * The reasoning path on `chat.ts` forwards `reasoning_content` through to the
 * client verbatim. hy4-preview-f (and other buddy reasoning models) sometimes
 * double-wraps the field with `<think>…</think>`, so the tag bytes reach the
 * client as literal text — a reader then sees the "reasoning" as the tagged
 * block and reports the model as not thinking at all.
 *
 * `stripThinkingTags` is the helper the reasoning path runs each settled value
 * through. These lock the shape it has to keep.
 */

describe("stripThinkingTags — the reasoning path's defence against upstream double-wrap", () => {
  test("drops a paired think wrapper and keeps the inner text", () => {
    expect(stripThinkingTags("<think>step one</think>")).toBe("step one");
  });

  test("drops both tag spellings — <think> and <thinking>", () => {
    expect(stripThinkingTags("<thinking>a</thinking><think>b</think>")).toBe("ab");
  });

  test("drops a stray closing tag with no opener", () => {
    // An upstream that lost the opening tag before it committed the reasoning
    // field still leaves the closer behind, and reading it as literal text is
    // just as bad as reading a paired block.
    expect(stripThinkingTags("step one</think>")).toBe("step one");
  });

  test("drops an open tag that carries attributes", () => {
    expect(stripThinkingTags('<think signature="x">inside</think>')).toBe("inside");
  });

  test("drops whitespace inside the closing tag", () => {
    expect(stripThinkingTags("<think>inside</think >")).toBe("inside");
  });

  test("leaves a value with no tag characters untouched (no allocation)", () => {
    const value = "plain reasoning text, no tags at all";
    expect(stripThinkingTags(value)).toBe(value);
  });

  test("leaves `<` that is not part of a think tag alone", () => {
    expect(stripThinkingTags("a < b and c > d")).toBe("a < b and c > d");
  });

  test("case variants are deliberately left for the splitter to find", () => {
    // The reasoning leak this closes is lowercase; mixed-case is a separate
    // signal, so the function does not quietly expand what it says it strips.
    expect(stripThinkingTags("<Think>x</Think>")).toBe("<Think>x</Think>");
  });

  test("handles multiple wrapped segments in one string", () => {
    expect(stripThinkingTags("<think>a</think>mid<think>b</think>")).toBe("amidb");
  });
});
