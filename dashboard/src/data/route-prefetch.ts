import { isCancelledError, type QueryClient } from "@tanstack/react-query";
import { consoleRequest } from "./api";
import { assertApiKeys, assertNetworkPools, assertProviders, querySignal } from "./assert";
import { DASHBOARD_QUERY_OPTIONS } from "./query-policy";
import { queryKeys } from "./query-keys";

const ROUTE_PREFETCH_FAILURE_COOLDOWN_MS = 5_000;

// This state is intentionally scoped to each browser-side QueryClient. It is a
// bounded negative cache for the allowlisted route-prefetch reads and does not
// affect the normal query or mutation paths that use the same QueryClient.
const routePrefetchFailureUntil = new WeakMap<QueryClient, number>();

/** One read a destination's first paint depends on. */
interface PrefetchTarget {
  readonly queryKey: readonly unknown[];
  readonly read: (signal: AbortSignal) => Promise<unknown>;
}

/**
 * What each destination actually renders.
 *
 * Hover prefetches the reads the page's first paint depends on, so the data is
 * already in the cache when the route mounts:
 *
 * - `/` — runtime settings and the key list.
 * - `/providers` — the provider catalog.
 * - `/proxy` — the network pools.
 *
 * The previous mapping prefetched `system.health` for all three, none of which
 * render it, so every hover paid for a read nobody displayed.
 *
 * Deliberately absent, and never to be added here: `/quota/overview`,
 * `/api-keys` credential or share reads, request detail, and any payload read.
 * Those are privileged or upstream-bound, and intent is not consent — a hover
 * must not trigger them. The catalog-shaped half of this list is mirrored by
 * the persister's `shouldDehydrate` in `query-client.ts`; change one and change
 * the other.
 */
const PREFETCH_BY_ROUTE: Record<string, readonly PrefetchTarget[]> = {
  "/": [
    { queryKey: queryKeys.settings.runtime, read: (signal) => consoleRequest<unknown>("/settings/runtime", { signal }) },
    {
      queryKey: queryKeys.apiKeys.all,
      read: (signal) => consoleRequest<unknown>("/api-keys", { signal }).then(assertApiKeys),
    },
  ],
  "/providers": [
    {
      queryKey: queryKeys.providers.all,
      read: (signal) => consoleRequest<unknown>("/providers", { signal }).then(assertProviders),
    },
  ],
  "/proxy": [
    {
      queryKey: queryKeys.network.pools,
      read: (signal) => consoleRequest<unknown>("/network/pools", { signal }).then(assertNetworkPools),
    },
  ],
};

/** Prefetches a destination's first-paint reads, on hover only. */
export function prefetchRouteIntent(queryClient: QueryClient, pathname: string): Promise<void> {
  const targets = PREFETCH_BY_ROUTE[pathname];
  if (targets === undefined) return Promise.resolve();

  const now = Date.now();
  const failureUntil = routePrefetchFailureUntil.get(queryClient);
  if (failureUntil !== undefined) {
    if (failureUntil > now) return Promise.resolve();
    routePrefetchFailureUntil.delete(queryClient);
  }

  // Together, so one slow read cannot leave the other half unprimed; and
  // settled, so a rejection from one does not strand the other's fetch.
  return Promise.allSettled(
    targets.map((target) =>
      queryClient.fetchQuery({
        queryKey: target.queryKey,
        queryFn: (context) => target.read(querySignal(context)),
        ...DASHBOARD_QUERY_OPTIONS,
      }),
    ),
  ).then((outcomes) => {
    const failed = outcomes.some(
      (outcome) => outcome.status === "rejected" && !isCancelledError(outcome.reason),
    );
    if (failed) {
      routePrefetchFailureUntil.set(queryClient, Date.now() + ROUTE_PREFETCH_FAILURE_COOLDOWN_MS);
      return;
    }
    routePrefetchFailureUntil.delete(queryClient);
  });
}
