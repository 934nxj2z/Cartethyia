/**
 * Whether a stored probe verdict still describes the pool it is shown on.
 *
 * A probe verdict is a statement about **one egress address**. Keying it by
 * pool id alone let an edited pool keep displaying the previous address's
 * answer: change a blocked proxy to a working one and the card still read
 * "OpenCode blocked", because nothing compared the two. The operator had no way
 * to tell a fresh verdict from a stale one, and the stale one looked
 * authoritative.
 *
 * Kept as a pure function so the rule is testable without rendering the page.
 */
import type { PoolProviderProbeResult } from "../../../../src/console/routing/pools/contracts";

export interface StoredProviderResult {
  /** The endpoint the verdict was measured against. */
  readonly endpoint: string;
  readonly result: PoolProviderProbeResult;
}

/**
 * The verdict for `pool`, or `undefined` when it no longer applies.
 *
 * An empty stored endpoint means the row was probed before the endpoint was
 * known (the add form reports before the refetch lands). That comparison is
 * skipped rather than guessed: discarding a verdict we cannot validate would
 * hide a real result, while keeping one we *can* validate is what this exists
 * for.
 */
export function liveProbeFor(
  stored: StoredProviderResult | undefined,
  currentEndpoint: string | null | undefined,
): PoolProviderProbeResult | undefined {
  if (stored === undefined) return undefined;
  if (stored.endpoint === "") return stored.result;
  return stored.endpoint === (currentEndpoint ?? "") ? stored.result : undefined;
}
