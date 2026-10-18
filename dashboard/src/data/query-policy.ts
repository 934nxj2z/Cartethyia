/**
 * Shared server-state policy for dashboard queries and mutations.
 *
 * Keeping these defaults in one module prevents a hook from silently drifting
 * from the application-wide cache behavior. Sensitive data remains opt-in at
 * each hook and is never prefetched by this policy.
 */

/**
 * 60 s, not 10 s. The dashboard polls live surfaces on its own cadence
 * (`POLL` below) and every mutating hook invalidates, so `staleTime` is not
 * what keeps data fresh — it is what stops a remount, a tab focus, or a route
 * change from re-fetching a list that has not moved. At 10 s nearly every hook
 * overrode it upward, which is the signal that the default was the outlier.
 */
export const DASHBOARD_QUERY_OPTIONS = {
  staleTime: 60_000,
  gcTime: 120_000,
  retry: false,
  refetchOnWindowFocus: false,
} as const;

export const DASHBOARD_MUTATION_OPTIONS = {
  retry: 0,
} as const;

/**
 * Stale window for a read that only changes through its own mutation.
 *
 * A tool registry is shipped with the build and a runtime setting changes only
 * when the operator saves it — and both of those invalidate. Five minutes is
 * long enough that navigating between pages never re-fetches either.
 */
export const CACHE = {
  /** Immutable for the lifetime of a deployment, bar its own mutation. */
  effectivelyImmutable: 300_000,
} as const;


/**
 * How often a live surface re-reads. The number is the contract: a counter
 * the operator is watching moves every few seconds, a list that changes on
 * mutation can wait a minute. Name the cadence at the call site instead of
 * inlining the milliseconds, so two hooks watching the same kind of thing
 * cannot drift apart unnoticed.
 */
export const POLL = {
  /** A page that is filling in and should converge within a second or two. */
  warming: 2_000,
  /** A counter or feed the operator is watching right now. */
  live: 5_000,
  /** Health and status that should feel current but is not a ticker. */
  status: 10_000,
  /** A catalog or overview that changes on mutation, polled as a backstop. */
  catalog: 60_000,
} as const;
