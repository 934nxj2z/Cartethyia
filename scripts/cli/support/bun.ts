/** Minimum Bun the repository declares in `package.json` `engines`. */
export const MINIMUM_BUN_VERSION = "1.4.0";

/**
 * True when `actual` is at least `minimum`, compared as dotted integers.
 * A non-numeric segment reads as 0, so a malformed version fails closed
 * against a real minimum instead of passing.
 */
export function bunVersionAtLeast(actual: string, minimum: string): boolean {
  const left = actual.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = minimum.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const a = left[i] ?? 0;
    const b = right[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/** Throws unless the running Bun satisfies the declared minimum. */
export function assertBunVersion(): void {
  if (bunVersionAtLeast(Bun.version, MINIMUM_BUN_VERSION)) return;
  throw new Error(
    `Bun ${MINIMUM_BUN_VERSION} or newer is required (found ${Bun.version}). Install it from https://bun.sh and run this command again.`,
  );
}
