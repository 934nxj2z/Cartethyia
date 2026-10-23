// Files a provider's rate-limit headers against the account that earned them.
//
// Providers answer real traffic with the bucket they are metering — Grok's CLI
// plane returns `x-ratelimit-*` on every response — and that is a reading the
// gateway already paid for. Capturing it here is what lets the quota surface
// show a balance without spending a request of its own.
//
// Kept provider-scoped and fail-open: a provider with no bucket parser is
// skipped, and any throw is swallowed, because a bookkeeping miss must never
// take down a request that already succeeded.

import { rememberGrokRateLimit } from "../../providers/integrations/grok/grok-ratelimit-store";
import { readGrokRateLimitHeaders } from "../../providers/integrations/grok/grok-ratelimit";

/** Providers whose response headers carry a readable bucket. */
const GROK_PROVIDER_IDS: readonly string[] = ["grok"];

/**
 * Stores whatever bucket the response carried, keyed by account.
 *
 * No account id means no home for the reading: a bucket filed under the wrong
 * account is worse than none, since it would report another account's balance.
 */
export function captureProviderRateLimit(
  providerId: string,
  accountId: string | undefined,
  headers: { get(name: string): string | null },
): void {
  if (!accountId) return;
  const id = providerId.toLowerCase();
  if (!GROK_PROVIDER_IDS.includes(id)) return;
  try {
    rememberGrokRateLimit(accountId, readGrokRateLimitHeaders(headers));
  } catch {
    // Swallowed: advisory bookkeeping on a request that already succeeded.
  }
}
