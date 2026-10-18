/**
 * Token-count display, in one place.
 *
 * Three spellings of the same idea used to live apart — the compact scale, a
 * `compactTokens` copy, and a model-window formatter — so a 3,441-token account
 * read `3.4K` in one row and `3.44K` in the next. They sit side by side here
 * rather than being merged, because each one's rounding is what a surface is
 * built around; changing one to match another is a behavior change, not a
 * rename.
 *
 * Pick by what the surface shows:
 *
 * - {@link formatTokens} / {@link tokenScaleValue} — a count on a chart axis or
 *   a usage breakdown, locale-grouped, with a scale switcher.
 * - {@link compactTokens} — a credential row or share limit: two decimals, no
 *   locale, never negative.
 * - {@link formatModelTokens} — a model's context or output window on a catalog
 *   card: `400k`, `1.0M`.
 *
 * Policy everywhere: an absent or non-finite value is `—`; zero is a real
 * measurement.
 */

/**
 * Ordered coarsest-first. The last index ({@link RAW_TOKEN_SCALE}) is the exact
 * count. Usage's scale switcher pins one unit; `TOKEN_SCALE_AUTO` picks the
 * unit a value lands on.
 */
export const TOKEN_SCALES = [
  { threshold: 1_000_000_000_000, divisor: 1_000_000_000_000, suffix: "T" },
  { threshold: 1_000_000_000, divisor: 1_000_000_000, suffix: "B" },
  { threshold: 1_000_000, divisor: 1_000_000, suffix: "M" },
  { threshold: 1_000, divisor: 1_000, suffix: "K" },
] as const;

/** Index past the last scale: show the exact token count. */
export const RAW_TOKEN_SCALE = TOKEN_SCALES.length;
/** Sentinel for the compact unit the value lands on. */
export const TOKEN_SCALE_AUTO = -1;
export const DEFAULT_TOKEN_SCALE = RAW_TOKEN_SCALE;

/** Index into `TOKEN_SCALES` for the compact unit a token count lands on. */
export function tokenScaleIndex(value: number): number {
  const abs = Math.abs(value);
  const found = TOKEN_SCALES.findIndex((scale) => abs >= scale.threshold);
  return found === -1 ? TOKEN_SCALES.length : found;
}

/** Formats a token count at `TOKEN_SCALES[index]`; the last index is the raw count. */
function formatScaled(value: number, index: number, locale?: string): string {
  const scale = TOKEN_SCALES[index];
  if (!scale) return Math.round(value).toLocaleString(locale);
  const scaled = value / scale.divisor;
  return `${scaled.toLocaleString(locale, {
    maximumFractionDigits: index === TOKEN_SCALES.length - 1 ? 0 : 1,
  })}${scale.suffix}`;
}

/** A token count in the compact unit it lands on (`1.2K`, `3.4M`), or the exact count. */
export function formatTokens(value: number | null | undefined, locale?: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return formatScaled(value, tokenScaleIndex(value), locale);
}

/**
 * Formats a token count at the card's scale: `TOKEN_SCALE_AUTO` picks the
 * compact unit the value lands on, `RAW_TOKEN_SCALE` is the exact count, and
 * anything else pins one of `TOKEN_SCALES`.
 */
export function tokenScaleValue(value: number | null | undefined, scale: number, locale?: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (scale === TOKEN_SCALE_AUTO) return formatScaled(value, tokenScaleIndex(value), locale);
  if (scale === RAW_TOKEN_SCALE) return Math.round(value).toLocaleString(locale);
  return formatScaled(value, scale, locale);
}

/** Compact K/M/B/T token count, e.g. 3441 → "3.44K". */
export function compactTokens(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const amount = Math.max(0, value);
  if (amount >= 1_000_000_000_000) return `${Number((amount / 1_000_000_000_000).toFixed(2))}T`;
  if (amount >= 1_000_000_000) return `${Number((amount / 1_000_000_000).toFixed(2))}B`;
  if (amount >= 1_000_000) return `${Number((amount / 1_000_000).toFixed(2))}M`;
  if (amount >= 1_000) return `${Number((amount / 1_000).toFixed(2))}K`;
  return amount.toLocaleString();
}

/** A configured limit; `null`/`undefined` reads as "Unlimited". */
export function limitLabel(value: number | null | undefined): string {
  if (value === null || value === undefined) return "Unlimited";
  return Number.isFinite(value) ? value.toLocaleString() : "—";
}

/**
 * Unknown-limit display for model cards.
 *
 * Backend keeps `contextLimit`/`outputLimit` as `null` when upstream supplied
 * no metadata (string-only discovery, manual register). Cards render those as
 * unavailable rather than guessing a number: a made-up 200k/64k looks measured
 * and misleads capacity planning. Never used for routing or request shaping —
 * display only.
 */
export const UNKNOWN_LIMITS_TOOLTIP =
  "Upstream provided no context metadata; limits are unavailable, not estimated.";

/**
 * The ceilings the operator is offered when the real ones are unknown.
 *
 * Mirrors the backend's `FALLBACK_CONTEXT_LIMIT` / `FALLBACK_OUTPUT_LIMIT`, which
 * is what an unsized row is actually persisted with. Kept as a literal rather
 * than imported: the backend module pulls in the compiled base catalog, and that
 * is far too much to ship to the browser for two numbers. A test pins the pair
 * so the two copies cannot drift apart unnoticed.
 */
export const FALLBACK_CONTEXT_TOKENS = 512_000;
export const FALLBACK_OUTPUT_TOKENS = 131_072;

/**
 * Shown beside a limit the catalog could not file.
 *
 * Distinct from {@link UNKNOWN_LIMITS_TOOLTIP} on purpose. That one says the
 * upstream told us nothing, so the row is genuinely blank. This one says *we*
 * have no row, so the number on screen is a placeholder chosen to keep the
 * model routable — a different claim, and one an operator has to be able to
 * tell apart from a real measurement.
 *
 * The numbers are interpolated, not spelled out: a fallback that changed on the
 * backend while the tooltip still quoted the old pair would describe a model's
 * limits wrongly.
 */
export const ESTIMATED_LIMITS_TOOLTIP =
  `No catalog row files this model, so these limits are a fallback ` +
  `(${formatModelTokens(FALLBACK_CONTEXT_TOKENS)} context, ${formatModelTokens(FALLBACK_OUTPUT_TOKENS)} output) ` +
  `to keep it routable — not a measurement of the model.`;

/**
 * Reads a token-ish entry ("512k", "131072", "1.5m") as a token count.
 *
 * Three outcomes, deliberately: `undefined` for blank input, which the caller
 * sends as `null` — the honest "unknown"; `null` for input it cannot read, so
 * the UI can refuse to submit rather than persist a wrong ceiling. A context
 * limit the operator mistyped makes every request against that model truncate,
 * which reads as the model being broken.
 */
export function parseTokenInput(raw: string): number | null | undefined {
  const value = raw.trim().toLowerCase();
  if (value.length === 0) return undefined;
  const matched = /^(\d+(?:\.\d+)?)\s*([km])?$/.exec(value);
  if (matched === null) return null;
  const amount = Number(matched[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const multiplier = matched[2] === "k" ? 1_000 : matched[2] === "m" ? 1_000_000 : 1;
  return Math.floor(amount * multiplier);
}

/**
 * A model limit as a card shows it: `400k`, `1.0M`.
 *
 * One owner for the two cards that draw these numbers — the provider catalog
 * and the public share page — so the same model cannot read `400k` on one and
 * `400K` on the other. An absent limit is `—`; a card that wants to explain the
 * absence renders `n/a` beside {@link UNKNOWN_LIMITS_TOOLTIP} instead of calling
 * this with `null`.
 */
export function formatModelTokens(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}k`;
  return String(value);
}
