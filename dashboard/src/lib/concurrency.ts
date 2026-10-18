/**
 * Bounded concurrency for bulk dashboard actions.
 *
 * `Promise.allSettled(items.map(...))` fires every request at once. Against a
 * provider's own endpoints that is indistinguishable from a burst: token and
 * quota endpoints rate-limit exactly that shape, so "Test all" failed accounts
 * that pass individually — and the failures were the operator's own fan-out,
 * not the accounts.
 *
 * Workers keep a fixed number in flight instead. Order is preserved, so the
 * caller can zip results back to the items that produced them, and a rejected
 * item never aborts the rest (the caller gets the settled outcome, like
 * `Promise.allSettled`).
 */

/**
 * Runs `worker` over `items` with at most `limit` in flight.
 *
 * Results are in input order. Each is the settled outcome, never a throw.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<readonly PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  const width = Math.max(1, Math.min(limit, items.length));
  let next = 0;

  const runOne = async (): Promise<void> => {
    // Each worker pulls the next index rather than receiving a slice: a slow
    // item does not idle its worker's remaining items behind it.
    for (;;) {
      const index = next;
      if (index >= items.length) return;
      next += 1;
      try {
        results[index] = { status: "fulfilled", value: await worker(items[index]!, index) };
      } catch (error) {
        results[index] = { status: "rejected", reason: error };
      }
    }
  };

  await Promise.all(Array.from({ length: width }, runOne));
  return results;
}
