import { QueryClient, type Query } from "@tanstack/react-query";
import { DASHBOARD_MUTATION_OPTIONS, DASHBOARD_QUERY_OPTIONS } from "./query-policy";
import { dehydrate, hydrate, persistClient, removeClient, restoreClient } from "./query-persister";

/** One application-wide server-state cache for the dashboard. */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: DASHBOARD_QUERY_OPTIONS,
    mutations: DASHBOARD_MUTATION_OPTIONS,
  },
});

/**
 * The keys allowed to reach disk, as an explicit structural predicate.
 *
 * Catalog-shaped reads only — the ones a returning tab would otherwise
 * re-fetch in full, and the ones that carry nothing a second tenant must not
 * see. Everything else is excluded rather than filtered by field, because a
 * denylist is the thing that drifts:
 *
 * - `usageAnalytics.requestDetail` and `usageAnalytics.requests` hold request
 *   and response payload bodies.
 * - `apiKeys.*` and `sharedKeys` hold credential material and share links.
 * - `audit.*` is the operator's own activity log.
 * - `providers.accounts` carries credentials, `quota.*` and `modelBans.*` are
 *   per-tenant enforcement state, and `healthEvents` is failure detail.
 * - `network.pools` carries egress addresses.
 *
 * `providers.models(id)` is included because it is the largest catalog read on
 * the dashboard and the reason this store is IndexedDB rather than
 * `localStorage`.
 *
 * Privacy mode in `lib/privacy-mode.ts` masks at display only, so a persisted
 * snapshot would hold the unmasked bytes at rest — which is why every surface
 * containing those values is on the excluded side above.
 *
 * The predicate is written against the key's *shape* rather than a serialized
 * prefix, so adding a key cannot silently join the allowlist.
 */
function isPersistable(query: Query): boolean {
  const [head, second, third] = query.queryKey;
  if (head !== "console") return false;
  if (second === "session") return true;
  if (second === "providers") {
    // `["console","providers"]` (the catalog) and
    // `["console","providers",<id>,"models"]` (one provider's model list).
    if (third === undefined) return true;
    return query.queryKey[3] === "models";
  }
  if (second === "settings") return third === "runtime";
  if (second === "cli-tools") return third === "registry";
  return false;
}

/**
 * Restores the persisted catalog reads before the first fetch.
 *
 * Called at app mount so the dashboard paints from last session's catalog
 * instead of showing skeletons while the network answers. A failure or an
 * absent snapshot is a normal cold start.
 */
export async function restorePersistedCache(): Promise<void> {
  const state = await restoreClient();
  if (state === undefined) return;
  hydrate(queryClient, state);
}

/**
 * Drops the persisted snapshot.
 *
 * Called on the same three paths that call {@link queryClient.clear} — logout,
 * 401, 403 — because `clear()` only empties memory. Without this, a reload
 * after a logout would rehydrate the previous tenant's catalog from disk,
 * which is exactly the leak `clear()` exists to prevent.
 */
export function clearPersistedCache(): void {
  void removeClient();
}

/**
 * Persists the allowlisted reads as they settle.
 *
 * Coalesced: one dashboard poll burst settles many queries within a few
 * milliseconds, and dehydrating the whole cache per query would serialize the
 * entire catalog once per query in the burst.
 */
export function startPersisting(): () => void {
  const PERSIST_DEBOUNCE_MS = 2_000;
  let pending: ReturnType<typeof setTimeout> | undefined;
  const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    // Only a settled state change can alter what would be stored: an observer
    // added or removed means a component mounted, not that data arrived.
    if (event.type !== "updated") return;
    if (event.action.type !== "success" && event.action.type !== "error") return;
    if (pending !== undefined) return;
    pending = setTimeout(() => {
      pending = undefined;
      void persistClient(dehydrate(queryClient, { shouldDehydrateQuery: isPersistable }));
    }, PERSIST_DEBOUNCE_MS);
  });
  return () => {
    if (pending !== undefined) clearTimeout(pending);
    unsubscribe();
  };
}
