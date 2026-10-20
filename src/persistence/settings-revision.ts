/**
 * Process-wide runtime-settings revision counter.
 *
 * Single staleness source for per-tenant `console_settings` caching: every
 * mutation bumps it, every cache key includes it, so a write instantly
 * invalidates cached reads (with TTL as the backstop, not the mechanism).
 *
 * Lives in `persistence/settings-revision.ts` — not in `console/stores/runtime-settings.ts` — because
 * the hot path (`transport/dispatch/proxy-request.ts`) reads it on every request and must not
 * import the dashboard persistence layer for a monotonic integer.
 */
import { publishInvalidation, subscribeInvalidation } from "./shared-cache";

let revisionCounter = 0;

/** Current revision; cache keys embed this. */
export function currentSettingsRevision(): number {
  return revisionCounter;
}

/** Bumps the revision after a settings mutation. Returns the new revision. */
export function bumpSettingsRevision(): number {
  revisionCounter += 1;
  // Peer processes key their own caches on their own counter, and `reusePort`
  // means the write may have been served by one of several. Without this, a
  // settings change was invisible to every other process until its 5 s TTL
  // lapsed. Peers bump their own counter on receipt, which changes their cache
  // keys and so invalidates without any enumeration.
  publishInvalidation({ namespace: "preferences", key: String(revisionCounter) });
  return revisionCounter;
}

/**
 * Applies peer processes' settings-revision bumps to this process's counter.
 *
 * Subscribed once at boot. Idempotent in effect — the counter only ever moves
 * forward, and a duplicate notice changes nothing a later one would not.
 */
export function subscribePeerSettingsRevisions(): () => void {
  return subscribeInvalidation((notice) => {
    if (notice.namespace !== "preferences") return;
    const peer = Number(notice.key);
    if (!Number.isFinite(peer)) return;
    // Monotonic: never wind the counter back, so an out-of-order delivery
    // cannot resurrect a key a later write had already invalidated.
    if (peer > revisionCounter) revisionCounter = peer;
  });
}
