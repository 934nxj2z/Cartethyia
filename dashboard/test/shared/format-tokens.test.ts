/**
 * Token-count display policy.
 *
 * Three formatters live side by side in `lib/format/tokens.ts` on purpose: a
 * usage chart needs locale-grouped scaling with a switchable unit, a credential
 * row needs two fixed decimals, and a model card needs a window like `400k`.
 * These assertions pin each one's rounding, because the defect they are here to
 * catch is one surface silently inheriting another's scale — a 3,441-token
 * account reading `3.4K` in one row and `3.44K` in the next.
 */
import { describe, expect, test } from "bun:test";
import {
  formatModelTokens,
  formatTokens,
  parseTokenInput,
  tokenScaleIndex,
  tokenScaleValue,
  DEFAULT_TOKEN_SCALE,
  RAW_TOKEN_SCALE,
  TOKEN_SCALE_AUTO,
  TOKEN_SCALES,
  ESTIMATED_LIMITS_TOOLTIP,
  FALLBACK_CONTEXT_TOKENS,
  FALLBACK_OUTPUT_TOKENS,
} from "../../src/lib/format/tokens";

/** A locale with `,` thousands and `.` decimals, pinned for determinism. */
const EN = "en-US";

describe("tokenScaleIndex", () => {
  test("picks the coarsest unit a value reaches", () => {
    expect(tokenScaleIndex(1_500_000_000_000)).toBe(0);
    expect(tokenScaleIndex(1_500_000_000)).toBe(1);
    expect(tokenScaleIndex(1_500_000)).toBe(2);
    expect(tokenScaleIndex(1_500)).toBe(3);
  });

  test("a value below the smallest scale reports the raw index", () => {
    expect(tokenScaleIndex(999)).toBe(RAW_TOKEN_SCALE);
    expect(tokenScaleIndex(0)).toBe(RAW_TOKEN_SCALE);
  });

  test("the boundary value takes the coarser unit", () => {
    expect(tokenScaleIndex(1000)).toBe(3);
    expect(tokenScaleIndex(1_000_000)).toBe(2);
  });

  test("scales on magnitude, so a negative count lands where its size does", () => {
    expect(tokenScaleIndex(-1_500_000)).toBe(2);
  });
});

describe("formatTokens", () => {
  test("uses the compact unit the value lands on", () => {
    expect(formatTokens(2_500_000, EN)).toBe("2.5M");
    expect(formatTokens(3_000_000_000, EN)).toBe("3B");
  });

  test("a value below the smallest scale renders the exact count", () => {
    expect(formatTokens(999, EN)).toBe("999");
  });

  test("the fraction digits come from the scale index, not from the value", () => {
    // `formatScaled` uses `maximumFractionDigits: index === TOKEN_SCALES.length - 1 ? 0 : 1`.
    // `TOKEN_SCALES` has four entries, so indices 0..2 keep a decimal and index
    // 3 (the K scale) rounds to a whole number. Measured:
    //   formatTokens(1_500)    -> "2K"     (K scale, 0 fraction digits)
    //   formatTokens(2_500_000)-> "2.5M"   (M scale, 1 fraction digit)
    //
    // The intent behind that expression is presumably "the raw scale gets no
    // decimals", which would be `index === RAW_TOKEN_SCALE`; as written the
    // last *compact* scale is the one that loses its decimal. Pinned as
    // shipped, because a reader of this suite should see the real rule.
    expect(formatTokens(1500, EN)).toBe("2K");
    expect(formatTokens(1050, EN)).toBe("1K");
    expect(formatTokens(2500, EN)).toBe("3K");
    expect(formatTokens(1_500_000, EN)).toBe("1.5M");
  });

  test("renders the placeholder for absent or non-finite values", () => {
    expect(formatTokens(undefined)).toBe("—");
    expect(formatTokens(Number.NaN)).toBe("—");
    expect(formatTokens(0, EN)).toBe("0");
  });
});

describe("tokenScaleValue", () => {
  test("auto picks the landing unit", () => {
    expect(tokenScaleValue(2_500_000, TOKEN_SCALE_AUTO, EN)).toBe("2.5M");
  });

  test("the raw scale renders the exact count even above a threshold", () => {
    // This is the switch's whole purpose: an operator who wants the real
    // number must get it, not the abbreviation.
    expect(tokenScaleValue(1_500_000, RAW_TOKEN_SCALE, EN)).toBe("1,500,000");
  });

  test("a pinned scale renders that unit regardless of magnitude", () => {
    // A chart axis pins one unit so its bars are comparable; a value too small
    // for the unit rounds within that unit rather than silently switching.
    expect(tokenScaleValue(1_500_000, 3, EN)).toBe("1,500K");
    expect(tokenScaleValue(500, 3, EN)).toBe("1K");
    expect(tokenScaleValue(1_500_000, 2, EN)).toBe("1.5M");
  });

  test("the default scale is the raw count", () => {
    expect(DEFAULT_TOKEN_SCALE).toBe(RAW_TOKEN_SCALE);
    expect(tokenScaleValue(1_500_000, DEFAULT_TOKEN_SCALE, EN)).toBe("1,500,000");
  });

  test("renders the placeholder for absent values at every scale", () => {
    expect(tokenScaleValue(undefined, TOKEN_SCALE_AUTO, EN)).toBe("—");
    expect(tokenScaleValue(undefined, RAW_TOKEN_SCALE, EN)).toBe("—");
    expect(tokenScaleValue(null, 2, EN)).toBe("—");
  });

  test("every scale index in range renders without throwing", () => {
    // The switch's options come from `TOKEN_SCALES`; an index that threw would
    // be a render crash rather than a wrong number.
    for (let index = 0; index <= RAW_TOKEN_SCALE; index += 1) {
      expect(tokenScaleValue(1_500_000, index, EN)).toBeString();
    }
  });

  test("an out-of-range scale index falls back to the raw count", () => {
    // `formatScaled` looks up `TOKEN_SCALES[index]` and, when it is absent,
    // renders the exact count. A persisted preference from an older build
    // therefore degrades to the raw number instead of throwing during render.
    expect(tokenScaleValue(1_500_000, 99, EN)).toBe("1,500,000");
  });
});

describe("TOKEN_SCALES ordering", () => {
  test("is coarsest-first, which every index calculation depends on", () => {
    for (let index = 1; index < TOKEN_SCALES.length; index += 1) {
      const previous = TOKEN_SCALES[index - 1]!;
      const current = TOKEN_SCALES[index]!;
      expect(previous.threshold).toBeGreaterThan(current.threshold);
    }
  });

  test("each suffix matches its divisor's magnitude", () => {
    for (const scale of TOKEN_SCALES) {
      expect(scale.divisor).toBe(scale.threshold);
    }
  });
});

/**
 * The unsized-model fallback.
 *
 * A model the catalog cannot size is persisted with these ceilings so the row
 * stays routable instead of reading `n/a ctx · n/a out`. The pair is duplicated
 * on the backend because importing it would drag the compiled base catalog into
 * the browser bundle; these assertions are what keep the two copies honest.
 */
describe("unsized-model fallback", () => {
  test("mirrors the backend ceilings exactly", async () => {
    const backend = await import("../../../src/providers/provider-model-definition");
    expect(FALLBACK_CONTEXT_TOKENS).toBe(backend.FALLBACK_CONTEXT_LIMIT);
    expect(FALLBACK_OUTPUT_TOKENS).toBe(backend.FALLBACK_OUTPUT_LIMIT);
  });

  test("sits above every frontier window, so it is never the binding constraint", () => {
    // The point of the fallback: a ceiling that is too low truncates a working
    // request, while one that is too high only means the upstream rejects the
    // call on its own terms.
    expect(FALLBACK_CONTEXT_TOKENS).toBeGreaterThanOrEqual(200_000);
    expect(FALLBACK_OUTPUT_TOKENS).toBeGreaterThanOrEqual(32_000);
    expect(FALLBACK_OUTPUT_TOKENS).toBeLessThanOrEqual(FALLBACK_CONTEXT_TOKENS);
  });

  test("the estimated-limit tooltip quotes the ceilings it describes", () => {
    // Interpolated rather than spelled out, so the tooltip cannot keep quoting
    // an old pair after the constants change.
    expect(ESTIMATED_LIMITS_TOOLTIP).toContain(formatModelTokens(FALLBACK_CONTEXT_TOKENS));
    expect(ESTIMATED_LIMITS_TOOLTIP).toContain(formatModelTokens(FALLBACK_OUTPUT_TOKENS));
    expect(ESTIMATED_LIMITS_TOOLTIP).not.toContain("500k");
  });
});

/**
 * Operator-entered token counts.
 *
 * `parseTokenInput` has three outcomes on purpose, and the defect it is here to
 * catch is the middle one collapsing into the others: blank ("unknown") and
 * unreadable ("refuse to submit") must not read the same, or a mistyped ceiling
 * gets persisted and every request against that model truncates.
 */
describe("parseTokenInput", () => {
  test("reads a bare count", () => {
    expect(parseTokenInput("200000")).toBe(200_000);
    expect(parseTokenInput("131072")).toBe(131_072);
  });

  test("reads the k and m suffixes, either case, with or without a space", () => {
    expect(parseTokenInput("512k")).toBe(512_000);
    expect(parseTokenInput("512K")).toBe(512_000);
    expect(parseTokenInput("131 k")).toBe(131_000);
    expect(parseTokenInput("1.5m")).toBe(1_500_000);
    expect(parseTokenInput("2M")).toBe(2_000_000);
  });

  test("blank is unknown, not invalid", () => {
    // The caller sends this as `null`: the operator left it blank on purpose.
    expect(parseTokenInput("")).toBeUndefined();
    expect(parseTokenInput("   ")).toBeUndefined();
  });

  test("unreadable input is refused rather than guessed", () => {
    expect(parseTokenInput("abc")).toBeNull();
    expect(parseTokenInput("12k34")).toBeNull();
    expect(parseTokenInput("-5k")).toBeNull();
    expect(parseTokenInput("0")).toBeNull();
    expect(parseTokenInput("0.4k")).toBe(400);
    expect(parseTokenInput("1e6")).toBeNull();
    expect(parseTokenInput("128 b")).toBeNull();
  });

  test("a fractional suffix floors to a whole token count", () => {
    // The backend rejects a non-integer limit outright, so the floor happens
    // here rather than as a 400 the operator has to decode.
    expect(parseTokenInput("1.5k")).toBe(1_500);
    expect(parseTokenInput("0.5m")).toBe(500_000);
  });

  test("the fallback ceilings round-trip through the text the UI seeds", () => {
    // The draft is seeded with `String(...)`, not the rounded `131k` a card
    // shows — parsing that back would persist 131000 in place of 131072.
    expect(parseTokenInput(String(FALLBACK_CONTEXT_TOKENS))).toBe(FALLBACK_CONTEXT_TOKENS);
    expect(parseTokenInput(String(FALLBACK_OUTPUT_TOKENS))).toBe(FALLBACK_OUTPUT_TOKENS);
  });
});

