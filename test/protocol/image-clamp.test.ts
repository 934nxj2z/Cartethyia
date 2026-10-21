// Pre-send image clamp.
//
// The contract under test: an image that is over a documented ceiling never
// reaches the wire unchanged. Unknown dimensions and unknown byte sizes PASS —
// an image behind a url/file reference carries no measurable payload, and a
// clamp that refuses what it cannot measure would fail requests that were fine
// before the clamp existed.
import { describe, expect, test } from "bun:test";
import {
  base64DecodedByteLength,
  clampImage,
  IMAGE_CLAMP_MANY_IMAGE_COUNT,
  IMAGE_CLAMP_MANY_IMAGE_MAX_DIMENSION_PX,
  IMAGE_CLAMP_MAX_BYTES,
  IMAGE_CLAMP_MAX_DIMENSION_PX,
  type ImageClampAction,
  type ImageClampInput,
  type ImageClampReason,
} from "../../src/protocol/image-clamp";
import { canonicalToClaudeMessagesPayload } from "../../src/protocol/request/messages";
import { buildGeminiPayload } from "../../src/protocol/request/gemini";
import type { CanonicalRequest, ContentPart } from "../../src/protocol/canonical-model";

function imagePayload(bytes: number): { type: string; source: Record<string, unknown> } {
  // base64 is 4/3 of the decoded payload, rounded up to a whole quad.
  const units = Math.ceil((bytes * 4) / 3);
  return { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(units) } };
}

function imageRequest(parts: ContentPart[]): CanonicalRequest {
  return {
    model: "claude-sonnet-4-5",
    messages: [{ role: "user", content: parts }],
    generation_controls: {},
    stream: false,
    source_surface: "messages",
  };
}

function blocks(payload: ReturnType<typeof canonicalToClaudeMessagesPayload>): unknown[] {
  const messages = payload["messages"] as { content: unknown[] }[];
  return messages[0]?.content ?? [];
}

describe("base64DecodedByteLength — measured without decoding", () => {
  test("exact for unpadded standard base64", () => {
    expect(base64DecodedByteLength("AAAA")).toBe(3);
    expect(base64DecodedByteLength("AAAAAA")).toBe(4);
    expect(base64DecodedByteLength("AAAAAAA")).toBe(5);
  });

  test("subtracts padding", () => {
    expect(base64DecodedByteLength("AA==")).toBe(1);
    expect(base64DecodedByteLength("AAA=")).toBe(2);
  });

  test("empty payload is zero bytes, never negative", () => {
    expect(base64DecodedByteLength("")).toBe(0);
    expect(base64DecodedByteLength("==")).toBe(0);
  });
});

describe("clampImage — table over the documented ceilings", () => {
  const MAX = IMAGE_CLAMP_MAX_DIMENSION_PX;
  const BYTES = IMAGE_CLAMP_MAX_BYTES;
  const MANY = IMAGE_CLAMP_MANY_IMAGE_COUNT;
  const MANY_MAX = IMAGE_CLAMP_MANY_IMAGE_MAX_DIMENSION_PX;

  const cases: {
    name: string;
    input: ImageClampInput;
    action: ImageClampAction;
    reason: ImageClampReason;
    maxDimensionPx?: number;
    targetMaxDimensionPx?: number;
  }[] = [
    // At the limit — inclusive ceilings, so an exactly-at-limit image passes.
    { name: "no metadata at all", input: {}, action: "pass", reason: "within_limits" },
    { name: "dimension exactly at 8000", input: { width: MAX }, action: "pass", reason: "within_limits" },
    { name: "bytes exactly at 10MB", input: { bytes: BYTES }, action: "pass", reason: "within_limits" },
    { name: "small image", input: { width: 1024, height: 768, bytes: 200_000 }, action: "pass", reason: "within_limits" },

    // Over the limit.
    { name: "one pixel over 8000", input: { width: MAX + 1 }, action: "downscale", reason: "dimension_over_limit", targetMaxDimensionPx: MAX },
    { name: "height over 8000", input: { width: 100, height: MAX + 1 }, action: "downscale", reason: "dimension_over_limit", targetMaxDimensionPx: MAX },
    { name: "one byte over 10MB", input: { bytes: BYTES + 1 }, action: "reject", reason: "bytes_over_limit" },
    { name: "far over both", input: { width: 40_000, height: 30_000, bytes: 50 * 1024 * 1024 }, action: "downscale", reason: "dimension_over_limit", targetMaxDimensionPx: MAX },

    // Many images — the ceiling drops.
    { name: "exactly 20 images keeps 8000", input: { width: MAX, imageCount: MANY }, action: "pass", reason: "within_limits" },
    { name: "21 images drops the ceiling to 2000", input: { width: MAX, imageCount: MANY + 1 }, action: "downscale", reason: "dimension_over_limit", targetMaxDimensionPx: MANY_MAX },
    { name: "21 images at 2000 passes", input: { width: MANY_MAX, imageCount: MANY + 1 }, action: "pass", reason: "within_limits", maxDimensionPx: MANY_MAX },
    { name: "21 images one pixel over 2000", input: { width: MANY_MAX + 1, imageCount: MANY + 1 }, action: "downscale", reason: "dimension_over_limit", targetMaxDimensionPx: MANY_MAX },
    { name: "byte ceiling does not drop with count", input: { bytes: BYTES, imageCount: MANY + 1 }, action: "pass", reason: "within_limits", maxDimensionPx: MANY_MAX },
  ];

  for (const row of cases) {
    test(row.name, () => {
      const decision = clampImage(row.input);
      expect(decision.action).toBe(row.action);
      expect(decision.reason).toBe(row.reason);
      expect(decision.maxBytes).toBe(BYTES);
      if (row.maxDimensionPx !== undefined) expect(decision.maxDimensionPx).toBe(row.maxDimensionPx);
      // The resize box is only ever present for `downscale`.
      if (row.targetMaxDimensionPx !== undefined)
        expect(decision.targetMaxDimensionPx).toBe(row.targetMaxDimensionPx);
      else expect(decision.targetMaxDimensionPx).toBeUndefined();
    });
  }

  test("defaults imageCount to a single image", () => {
    expect(clampImage({ width: MAX }).action).toBe("pass");
    expect(clampImage({}).maxDimensionPx).toBe(MAX);
  });

  test("the many-image ceiling is stricter than the single-image one", () => {
    expect(MANY_MAX).toBeLessThan(MAX);
  });
});

describe("clampImage — purity", () => {
  test("never mutates its input", () => {
    const input = { bytes: 1, width: 9, height: 9, imageCount: 3 };
    clampImage(input);
    expect(input).toEqual({ bytes: 1, width: 9, height: 9, imageCount: 3 });
  });
});

describe("Claude request path — the clamp runs before send", () => {
  test("an under-limit image is forwarded as an image block", () => {
    const payload = canonicalToClaudeMessagesPayload(
      imageRequest([{ kind: "image", payload: imagePayload(1_000) }]),
    );
    expect(blocks(payload)[0]).toMatchObject({ type: "image" });
  });

  test("an over-byte-limit image is clamped to a placeholder, not sent", () => {
    const payload = canonicalToClaudeMessagesPayload(
      imageRequest([{ kind: "image", payload: imagePayload(IMAGE_CLAMP_MAX_BYTES + 1) }]),
    );
    const block = blocks(payload)[0] as { type: string };
    expect(block.type).toBe("text");
    expect(JSON.stringify(block)).toContain("image omitted");
  });

  test("21 images: every one is clamped once the ceiling drops to 2000px", () => {
    // 5000px is the discriminating width: under the 8000px single-image
    // ceiling and over the 2000px many-image one, so count is the only
    // variable that can flip the decision.
    const parts: ContentPart[] = Array.from({ length: 21 }, () => ({
      kind: "image",
      payload: { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA", width: 5_000 } },
    })) as ContentPart[];
    const clamped = blocks(canonicalToClaudeMessagesPayload(imageRequest(parts)));
    expect(clamped).toHaveLength(21);
    expect(clamped.every((b) => (b as { type: string }).type === "text")).toBe(true);
  });

  test("20 images at the same 5000px are left alone — the ceiling only drops above 20", () => {
    const parts: ContentPart[] = Array.from({ length: 20 }, () => ({
      kind: "image",
      payload: { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA", width: 5_000 } },
    })) as ContentPart[];
    const forwarded = blocks(canonicalToClaudeMessagesPayload(imageRequest(parts)));
    expect(forwarded.every((b) => (b as { type: string }).type === "image")).toBe(true);
  });

  test("a url image carries no measurable payload and is forwarded untouched", () => {
    const payload = canonicalToClaudeMessagesPayload(
      imageRequest([
        { kind: "image", payload: { type: "image", source: { type: "url", url: "https://example.com/a.png" } } },
      ]),
    );
    expect(blocks(payload)[0]).toMatchObject({
      type: "image",
      source: { type: "url", url: "https://example.com/a.png" },
    });
  });
});

describe("clampImage with a per-tenant byte ceiling", () => {
  /**
   * The override is how a tenant says "my upstreams take more than the
   * default". What must hold is that it actually moves the decision — an
   * override that is parsed but ignored would be worse than no setting at all,
   * because the UI would appear to work while nothing changed.
   */
  test("an override raises the ceiling the block is measured against", () => {
    const over = IMAGE_CLAMP_MAX_BYTES + 1;
    // Refused at the default…
    expect(clampImage({ bytes: over }).action).toBe("reject");
    // …and admitted with the override.
    expect(clampImage({ bytes: over, maxBytesOverride: over + 1 }).action).toBe("pass");
  });

  test("an override can also lower it", () => {
    // The safer direction, and the more common need.
    expect(clampImage({ bytes: 1000 }).action).toBe("pass");
    expect(clampImage({ bytes: 1000, maxBytesOverride: 500 }).action).toBe("reject");
  });

  test("a non-positive or non-finite override falls back to the default", () => {
    // A malformed preference must not silently admit (or reject) everything.
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(clampImage({ bytes: 1000, maxBytesOverride: bad }).action).toBe("pass");
    }
    // Above the default and still refused proves the fallback is the default
    // and not "no ceiling".
    expect(
      clampImage({ bytes: IMAGE_CLAMP_MAX_BYTES + 1, maxBytesOverride: 0 }).action,
    ).toBe("reject");
  });

  test("the payload builder honours the override end to end", () => {
    // Proves the plumbing: the option reaches clampImage from the encoder that
    // adapters actually call, rather than working only in isolation.
    const bytes = IMAGE_CLAMP_MAX_BYTES + 1024;
    const request = imageRequest([{ kind: "image", payload: imagePayload(bytes) }]);
    const refused = canonicalToClaudeMessagesPayload(request);
    // A refused block becomes a visible placeholder, not a silent drop: the
    // model must not answer a question whose attachment simply vanished.
    expect(JSON.stringify(blocks(refused))).toContain("omitted");
    const admitted = canonicalToClaudeMessagesPayload(request, { maxBytesOverride: bytes + 1024 });
    expect(JSON.stringify(blocks(admitted))).not.toContain("omitted");
  });
});

describe("buildGeminiPayload with a per-tenant byte ceiling", () => {
  /** A data-URL image whose decoded payload is roughly `bytes` long. */
  function geminiImage(bytes: number): CanonicalRequest {
    const data = "A".repeat(Math.ceil(bytes / 3) * 4);
    return {
      model: "gemini-3-flash",
      stream: false,
      source_surface: "gemini",
      generation_controls: {},
      messages: [
        {
          role: "user",
          content: [
            {
              kind: "image",
              payload: { type: "image", source: { type: "base64", data, media_type: "image/png" } },
            },
          ],
        },
      ],
    } as unknown as CanonicalRequest;
  }

  test("an oversized inline image is refused at the default", () => {
    const payload = buildGeminiPayload(geminiImage(IMAGE_CLAMP_MAX_BYTES + 10_000));
    expect(JSON.stringify(payload)).toContain("omitted");
  });

  test("the override admits the same image", () => {
    // Proves the option reaches the clamp from the Gemini encoder too, not
    // only from the Messages one.
    const payload = buildGeminiPayload(geminiImage(IMAGE_CLAMP_MAX_BYTES + 10_000), {
      maxBytesOverride: IMAGE_CLAMP_MAX_BYTES + 20_000,
    });
    expect(JSON.stringify(payload)).not.toContain("omitted");
  });
});
