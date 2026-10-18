import { describe, expect, test } from "bun:test";
import {
  checkinAttemptedToday,
  checkinDayKey,
  ledgerKey,
  markCheckinAttempted,
} from "../../src/workers/daily-checkin";
import type { CartethyiaDatabase } from "../../src/persistence/db-handle";
import type { RedisClient } from "../../src/persistence/redis";

/**
 * A manual check-in deliberately bypasses the day marker on the way in — an
 * operator pressing "check in now" must not be refused by it — but it still has
 * to leave the marker behind.
 *
 * Without the stamp the sweep spends a second claim on the same account later
 * that day, and the console reads "Check-in due" for an account that was
 * checked in minutes ago, because "attempted today" is read from that marker
 * and only the sweep ever wrote it.
 */

const NOW = new Date("2026-07-08T03:00:00Z");

/** Minimal Redis double: only the commands the ledger uses. */
function fakeRedis(): RedisClient & { readonly store: Map<string, string> } {
  const store = new Map<string, string>();
  const client = {
    store,
    set: async (key: string, value: string, ...rest: unknown[]) => {
      const nx = rest.includes("NX");
      if (nx && store.has(key)) return null;
      store.set(key, value);
      return "OK";
    },
    del: async (key: string) => {
      const had = store.delete(key);
      return had ? 1 : 0;
    },
    get: async (key: string) => store.get(key) ?? null,
  };
  return client as unknown as RedisClient & { readonly store: Map<string, string> };
}

/** Minimal database double recording ledger inserts and answering reads. */
function fakeDb(): CartethyiaDatabase & {
  readonly inserted: { dayKey: string; accountId: string }[];
} {
  const inserted: { dayKey: string; accountId: string }[] = [];
  const db = {
    inserted,
    insert: () => ({
      values: (row: { dayKey: string; accountId: string }) => ({
        onConflictDoNothing: async () => {
          inserted.push(row);
          return [];
        },
      }),
    }),
    // Mirrors the real chain: select().from().where(...).limit(1). The day key
    // and account id must both match, so a row from another day answers nothing.
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () =>
            inserted.some((row) => row.dayKey === checkinDayKey(NOW))
              ? [{ dayKey: checkinDayKey(NOW) }]
              : [],
        }),
      }),
    }),
  };
  return db as unknown as CartethyiaDatabase & {
    readonly inserted: { dayKey: string; accountId: string }[];
  };
}

describe("markCheckinAttempted — a manual attempt leaves today's marker", () => {
  test("writes the Redis day marker the sweep and the console read", async () => {
    const redis = fakeRedis();
    await markCheckinAttempted({ db: undefined, redis, accountId: "acct-1", now: () => NOW });
    expect(redis.store.has(ledgerKey(checkinDayKey(NOW), "acct-1"))).toBe(true);
  });

  test("writes the ledger row when Redis is absent, so Lite records it too", async () => {
    // The manual button used to read the marker from Redis only. Without Redis
    // the marker lives in `daily_checkin_ledger`, so a Redis-only read answered
    // "not attempted" for every Lite deployment.
    const db = fakeDb();
    await markCheckinAttempted({ db, redis: undefined, accountId: "acct-2", now: () => NOW });
    expect(db.inserted).toEqual([{ dayKey: checkinDayKey(NOW), accountId: "acct-2" }]);
  });

  test("overwrites an existing marker without needing it to be absent", async () => {
    // The sweep's own reserve uses SET NX because it must not claim twice; a
    // stamp from a manual attempt asserts "settled for today" and must win
    // whether or not a marker was already there.
    const redis = fakeRedis();
    redis.store.set(ledgerKey(checkinDayKey(NOW), "acct-3"), "1");
    await markCheckinAttempted({ db: undefined, redis, accountId: "acct-3", now: () => NOW });
    expect(redis.store.get(ledgerKey(checkinDayKey(NOW), "acct-3"))).toBe("1");
  });

  test("never releases a slot: a stamp is not a retry", async () => {
    // Mirrors the sweep's rule that only a transient error frees the day. A
    // caller who attempted the check-in is asserting the day is settled.
    const redis = fakeRedis();
    await markCheckinAttempted({ db: undefined, redis, accountId: "acct-4", now: () => NOW });
    expect(redis.store.has(ledgerKey(checkinDayKey(NOW), "acct-4"))).toBe(true);
    await markCheckinAttempted({ db: undefined, redis, accountId: "acct-4", now: () => NOW });
    expect(redis.store.has(ledgerKey(checkinDayKey(NOW), "acct-4"))).toBe(true);
  });

  test("is a no-op with no ledger at all rather than throwing", async () => {
    // One process needs no distributed guard; the stamp is bookkeeping and must
    // not fail the operator's request.
    await expect(
      markCheckinAttempted({ db: undefined, redis: undefined, accountId: "acct-5", now: () => NOW }),
    ).resolves.toBeUndefined();
  });

  test("a failing Redis is logged, not thrown", async () => {
    const redis = {
      set: async () => {
        throw new Error("redis down");
      },
    } as unknown as RedisClient;
    await expect(
      markCheckinAttempted({ db: undefined, redis, accountId: "acct-6", now: () => NOW }),
    ).resolves.toBeUndefined();
  });
});

describe("checkinAttemptedToday — the read follows the write", () => {
  test("reads the Redis marker when Redis is present", async () => {
    const redis = fakeRedis();
    await markCheckinAttempted({ db: undefined, redis, accountId: "acct-1", now: () => NOW });
    expect(await checkinAttemptedToday({ db: undefined, redis, accountId: "acct-1", now: () => NOW })).toBe(true);
  });

  test("reads the ledger row when Redis is absent", async () => {
    // The bug this closes: the manual report button read the Redis key only, so
    // on a Lite deployment — where the sweep writes the ledger row — it answered
    // "not attempted" all day and let the report be re-sent every press.
    const db = fakeDb();
    await markCheckinAttempted({ db, redis: undefined, accountId: "acct-2", now: () => NOW });
    expect(await checkinAttemptedToday({ db, redis: undefined, accountId: "acct-2", now: () => NOW })).toBe(true);
  });

  test("answers false for an account with no marker", async () => {
    // Unknown, never "claimed": the sweep may simply not have reached it.
    const db = fakeDb();
    expect(await checkinAttemptedToday({ db, redis: undefined, accountId: "acct-9", now: () => NOW })).toBe(false);
  });

  test("a failing read is unknown, not a claim", async () => {
    const redis = {
      get: async () => {
        throw new Error("redis down");
      },
    } as unknown as RedisClient;
    expect(await checkinAttemptedToday({ db: undefined, redis, accountId: "acct-1", now: () => NOW })).toBe(false);
  });
});
