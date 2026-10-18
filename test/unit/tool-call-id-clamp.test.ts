import { describe, expect, test } from "bun:test";
import { clampToolCallId } from "../../src/protocol/codecs";

describe("tool call id clamp", () => {
  test("an id within the limit is returned untouched", () => {
    expect(clampToolCallId("call_abc")).toBe("call_abc");
    expect(clampToolCallId("x".repeat(64))).toBe("x".repeat(64));
  });

  test("an over-long id is clamped to the limit", () => {
    expect(clampToolCallId("x".repeat(200)).length).toBe(64);
    expect(clampToolCallId("x".repeat(65)).length).toBe(64);
  });

  test("clamping keeps the id's leading prefix recognisable", () => {
    // The ids that trip this share a long prefix, so keeping the head is what
    // makes a clamped id traceable back to the call it came from.
    const id = `sig:${"a".repeat(160)}`;
    expect(clampToolCallId(id).startsWith("sig:")).toBe(true);
  });

  test("distinct ids sharing a prefix stay distinct", () => {
    // Truncation alone would collapse these: they differ only after char 64.
    const prefix = "sig:EmoKaAFpFH0TwXoBP1zdqxkPs5dwI9CqZPKHUKUiSiIqh5NPwMhRyDpCusBPUNRpe";
    const a = clampToolCallId(`${prefix}AAAA${"x".repeat(90)}`);
    const b = clampToolCallId(`${prefix}BBBB${"x".repeat(90)}`);
    expect(a).not.toBe(b);
  });

  test("clamping is deterministic", () => {
    // A tool call and its result are clamped in separate branches; if the
    // helper wobbled they would stop matching and the pair would break.
    const id = `sig:${"z".repeat(150)}`;
    expect(clampToolCallId(id)).toBe(clampToolCallId(id));
  });

  test("a caller-supplied limit is honoured", () => {
    expect(clampToolCallId("x".repeat(200), 32).length).toBe(32);
  });
});
