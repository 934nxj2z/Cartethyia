/**
 * Where the buddy usage-detail read is stored and read back.
 *
 * The upstream billing meter is the source of truth and answers a whole window
 * on every call, so rows are *snapshots*: upserted, never appended. What that
 * buys the console is a stored figure — without it, every page open would
 * re-hit the billing endpoint once per account, and a read that failed would
 * render as "no usage at all" instead of the last number obtained.
 *
 * Deliberately not a request-path store: this is written by a maintenance pass
 * and read by the console. Nothing here can fail a dispatch.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../../persistence/db-handle";
import { buddyUsageSnapshots } from "../../../persistence/schema";
import type { BuddyUsageRow } from "./buddy-usage-shared";

/** One stored (day, model) bucket, as the console renders it. */
export interface BuddyUsageSnapshotRow extends BuddyUsageRow {
  readonly syncedAt: string | null;
}

/** Days of usage retained. The upstream's own window is 30. */
const RETENTION_DAYS = 30;

/**
 * Upserts one account's usage buckets.
 *
 * One statement for every row rather than one per row: a 30-day window on an
 * active account is a few hundred buckets, and the sweep walks accounts.
 * `credit` is replaced, not accumulated — the upstream's number for a bucket is
 * authoritative, so re-reading a partial window must not double-count it.
 *
 * Returns the number of rows written; a failure returns 0 rather than throwing,
 * because a snapshot that could not be stored is a stale display, not an error
 * the caller must handle.
 */
export async function saveBuddyUsageSnapshots(
  db: CartethyiaDatabase,
  accountId: string,
  rows: readonly BuddyUsageRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const now = new Date();
  try {
    await db
      .insert(buddyUsageSnapshots)
      .values(
        rows.map((row) => ({
          accountId,
          dayKey: row.day,
          model: row.model,
          credit: String(row.credit),
          syncedAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [
          buddyUsageSnapshots.accountId,
          buddyUsageSnapshots.dayKey,
          buddyUsageSnapshots.model,
        ],
        set: {
          credit: sql`excluded."credit"`,
          syncedAt: sql`excluded."synced_at"`,
        },
      });
    return rows.length;
  } catch {
    return 0;
  }
}

/**
 * Reads one account's stored usage, newest day first.
 *
 * `numeric` comes back from the driver as a string, so the credit is parsed
 * rather than trusted; an unparseable row is reported as 0 instead of being
 * dropped, because a bucket that exists is a bucket that was billed.
 */
export async function readBuddyUsageSnapshots(
  db: CartethyiaDatabase,
  accountIds: readonly string[],
  limitPerAccount = 30,
): Promise<Map<string, readonly BuddyUsageSnapshotRow[]>> {
  const result = new Map<string, BuddyUsageSnapshotRow[]>();
  if (accountIds.length === 0) return result;
  let rows: {
    accountId: string;
    dayKey: string;
    model: string;
    credit: string | number | null;
    syncedAt: Date | string | null;
  }[];
  try {
    rows = await db
      .select({
        accountId: buddyUsageSnapshots.accountId,
        dayKey: buddyUsageSnapshots.dayKey,
        model: buddyUsageSnapshots.model,
        credit: buddyUsageSnapshots.credit,
        syncedAt: buddyUsageSnapshots.syncedAt,
      })
      .from(buddyUsageSnapshots)
      .where(inArray(buddyUsageSnapshots.accountId, [...accountIds]))
      .orderBy(desc(buddyUsageSnapshots.dayKey));
  } catch {
    return result;
  }
  for (const row of rows) {
    const bucket = result.get(row.accountId) ?? [];
    // Ordered by day, so the first `limitPerAccount` distinct days win and a
    // model that ran every day does not crowd out the rest of the window.
    if (bucket.length >= limitPerAccount && bucket[bucket.length - 1]?.day !== row.dayKey) continue;
    bucket.push({
      day: row.dayKey,
      model: row.model,
      credit: Number(row.credit ?? 0) || 0,
      syncedAt: row.syncedAt instanceof Date ? row.syncedAt.toISOString() : (row.syncedAt ?? null),
    });
    result.set(row.accountId, bucket);
  }
  return result;
}

/** Drops buckets older than the upstream's own window. Best-effort. */
export async function pruneBuddyUsageSnapshots(
  db: CartethyiaDatabase,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  try {
    const deleted = await db
      .delete(buddyUsageSnapshots)
      .where(and(eq(buddyUsageSnapshots.dayKey, cutoff)))
      .returning({ accountId: buddyUsageSnapshots.accountId });
    // Days strictly older than the cutoff, which a single equality cannot reach.
    await db
      .delete(buddyUsageSnapshots)
      .where(sql`${buddyUsageSnapshots.dayKey} < ${cutoff}`);
    return deleted.length;
  } catch {
    return 0;
  }
}
