/**
 * How Model Lab picks a media worker for a tool call the planner made.
 *
 * A planner that saw `generate_image` in an earlier turn calls it again even
 * when the tool is not declared in this request — which happens the moment the
 * operator changes the worker, or when the configured worker is not in the
 * catalog at all. Refusing those calls outright returned "The model requested
 * an unavailable image-generation model." and killed the turn, and it only ever
 * reproduced with prior chat history: a fresh chat never called the undeclared
 * tool.
 */
import { describe, expect, test } from "bun:test";
import { resolveMediaModel } from "../../src/features/studio/StudioPage";

describe("resolveMediaModel — an undeclared tool call still resolves", () => {
  const declared = ["cb/gemini-3.0-pro-image"];

  test("honours a requested model that this request declared", () => {
    expect(resolveMediaModel("cb/gemini-3.0-pro-image", declared, "cb/gpt-image-2", "image")).toBe(
      "cb/gemini-3.0-pro-image",
    );
  });

  test("a stale model from chat history falls back to the configured worker", () => {
    // The regression: the planner echoed the previous turn's worker after the
    // operator switched to gemini, and the mismatch threw.
    expect(resolveMediaModel("cb/gpt-image-2", declared, "cb/gemini-3.0-pro-image", "image")).toBe(
      "cb/gemini-3.0-pro-image",
    );
  });

  test("an undeclared call with no requested model uses the configured worker", () => {
    expect(resolveMediaModel(undefined, declared, "cb/gemini-3.0-pro-image", "image")).toBe(
      "cb/gemini-3.0-pro-image",
    );
  });

  test("no configured worker falls back to the declared list", () => {
    expect(resolveMediaModel("cb/gpt-image-2", declared, "", "image")).toBe(
      "cb/gemini-3.0-pro-image",
    );
  });

  test("no worker anywhere is still an error, and names the intent", () => {
    expect(() => resolveMediaModel("cb/gpt-image-2", [], "", "video")).toThrow(
      /No enabled video-generation model is configured/,
    );
  });

  test("a non-string requested model is not trusted", () => {
    expect(resolveMediaModel({ model: "cb/gpt-image-2" }, declared, "cb/gemini-3.0-pro-image", "image")).toBe(
      "cb/gemini-3.0-pro-image",
    );
  });
});
