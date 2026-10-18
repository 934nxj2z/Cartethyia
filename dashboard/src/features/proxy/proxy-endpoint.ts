/**
 * Pure helpers for the Add Proxy batch form.
 *
 * The batch form's two non-obvious decisions live here rather than inside the
 * component, so a test can exercise them without rendering React:
 *
 * - which scheme a chip contributes to a pasted line (and when it must not), and
 * - how one shared bandwidth quota divides across the endpoints that name the
 *   same family.
 *
 * Both are pure on purpose: the browser bundle must not pull in anything
 * Node-only, and a pure function is the only kind that can be asserted directly.
 */

/** The scheme chips a paste can carry. */
export const SCHEME_CHIPS = ["http", "https", "socks5"] as const;
export type SchemeChip = (typeof SCHEME_CHIPS)[number];

/** True when the line already carries an explicit scheme the chips must not override. */
export function hasExplicitScheme(line: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(line.trim());
}

/**
 * Prepends the chosen scheme only when the line is still bare.
 *
 * An explicit scheme always wins, so a chip never masks a host the operator
 * already wrote (`https://host` stays `https://host`, never `http://https://host`).
 */
export function applySchemeChip(line: string, chip: SchemeChip | null): string {
  const trimmed = line.trim();
  if (chip === null || hasExplicitScheme(trimmed)) return trimmed;
  return `${chip}://${trimmed}`;
}

/** The endpoint a chip applies to: the first non-empty line, or undefined when the paste is empty. */
export function chipTargetLine(lines: readonly string[]): string | undefined {
  return lines.find((line) => line.trim() !== "");
}

/**
 * Reads the scheme off a single line the way the batch form does.
 *
 * `socks5://` and `socks://` are the only non-HTTP schemes the chips can imply;
 * everything else without a scheme defaults to `http`, which the chip exists to
 * override.
 */
export function detectProxyKind(line: string): (typeof SCHEME_CHIPS)[number] {
  const s = line.trim().toLowerCase();
  if (s.startsWith("https://")) return "https";
  if (s.startsWith("socks5://") || s.startsWith("socks://")) return "socks5";
  return "http";
}

const GIB = 1024 ** 3;

/** Parses a GB field into bytes; blank or invalid means "no quota". */
export function parseQuotaGb(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const gb = Number(trimmed);
  if (!Number.isFinite(gb) || gb <= 0) return null;
  return Math.max(1, Math.round(gb * GIB));
}

/**
 * Divides one shared quota across every endpoint that names the same family.
 *
 * The operator's "100 GB" is the family's allowance, not a per-proxy figure: five
 * endpoints sharing a family get 20 GB each, not 100 GB apiece. Rows with no
 * family are outside any pool and take no quota, so the split is only meaningful
 * once a family is named.
 *
 * Rounding: the family's members must still sum to exactly the entered figure, so
 * the last member absorbs whatever `floor` left over. Without that, 100 GB over 3
 * members would silently become 99 GB.
 *
 * Returns a map from batch line index to that row's byte allowance, omitting
 * indexes that take no quota.
 */
export function splitQuotaAcrossFamily(
  quotaBytes: number,
  family: string,
  lineCount: number,
): ReadonlyMap<number, number> {
  const perRow = new Map<number, number>();
  const familyKey = family.trim().toLowerCase();
  if (familyKey === "" || lineCount <= 0) return perRow;
  const share = Math.floor(quotaBytes / lineCount);
  let remainder = quotaBytes - share * lineCount;
  for (let index = 0; index < lineCount; index += 1) {
    // The last member takes the rounding remainder so the family's allowance
    // sums to exactly what the operator typed.
    const extra = index === lineCount - 1 ? remainder : 0;
    perRow.set(index, share + extra);
  }
  return perRow;
}
