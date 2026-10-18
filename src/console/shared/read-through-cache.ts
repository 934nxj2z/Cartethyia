/**
 * Shared read-through cache for console responses.
 *
 * Answering several console endpoints parses the retained telemetry window,
 * which is the console's dominant cost and runs on the event loop that serves
 * the gateway. Redis is configured on every deployment and this store only ever
 * pinged it, so the same window was re-parsed per instance, per poll, per
 * endpoint. A short TTL makes that once per window across the whole fleet.
 *
 * A Redis that is slow or down must never fail a request: every cache step
 * falls through to computing the answer, which is exactly what the request
 * would have done before there was a cache.
 */

/** The slice of Redis this cache needs, so it can be tested without a server. */
export interface ReadThroughCacheClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", ttlSeconds: number): Promise<unknown>;
}

/**
 * Default lifetime of a cached response. Callers whose underlying data changes
 * more often pass a shorter TTL; this value suits the dashboard's polling
 * cadence and the append-only telemetry log.
 */
export const READ_THROUGH_DEFAULT_TTL_SECONDS = 10;

/** `undefined` when the row was never cached, so a computed `null` is cacheable. */
export async function cachedRead<T>(
  client: ReadThroughCacheClient | undefined,
  key: string,
  compute: () => Promise<T>,
  ttlSeconds: number = READ_THROUGH_DEFAULT_TTL_SECONDS,
): Promise<T> {
  if (client === undefined) return compute();
  try {
    const hit = await client.get(key);
    if (hit !== null) return JSON.parse(hit) as T;
  } catch {
    return compute();
  }
  const value = await compute();
  try {
    await client.set(key, JSON.stringify(value), "EX", ttlSeconds);
  } catch {
    // A cache write must never fail a request that already has its answer.
  }
  return value;
}
