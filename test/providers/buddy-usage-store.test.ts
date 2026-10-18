/**
 * The stored usage snapshots.
 *
 * The console renders a *stored* figure rather than hitting the billing endpoint
 * on every page open, so the store has to behave the way a snapshot does:
 *
 * 1. **A re-read replaces, never accumulates.** The upstream's number for a
 *    bucket is authoritative, so syncing a partial window twice must not
 *    double-count the days it saw both times.
 * 2. **A bucket that exists is a bucket that was billed.** An unparseable
 *    credit is reported as 0, not dropped — dropping it would make an account
 *    that spent credits look like one that spent fewer.
 * 3. **No data is not zero data.** A read for an account with no snapshot
 *    returns nothing at all, which is what lets the page distinguish "not synced
 *    yet" from "spent nothing".
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySqliteMigrations, buildSqliteHandle, createSqliteDatabase } from "../../src/persistence/db-sqlite";
import {
  pruneBuddyUsageSnapshots,
  readBuddyUsageSnapshots,
  saveBuddyUsageSnapshots,
} from "../../src/providers/integrations/buddy/buddy-usage-store";
import type { CartethyiaDatabase } from "../../src/persistence/db-handle";

async function fresh(): Promise<{ db: CartethyiaDatabase; sqlite: Database }> {
  const dir = mkdtempSync(join(tmpdir(), "cart-usage-"));
  const sqlite = createSqliteDatabase(join(dir, "u.sqlite"));
  await applySqliteMigrations(sqlite);
  const { db } = buildSqliteHandle(sqlite);
  sqlite.exec("INSERT INTO tenants (id, name, status) VALUES ('t', 'A', 'active')");
  sqlite.exec("INSERT INTO providers (id) VALUES ('cbcn')");
  sqlite.exec(
    "INSERT INTO provider_accounts (id, provider_id, label, credential_kind) VALUES ('a1','cbcn','L','oauth')",
  );
  return { db, sqlite };
}

describe("buddy usage snapshots", () => {
  test("a second sync replaces the bucket instead of accumulating it", async () => {
    const { db, sqlite } = await fresh();
    await saveBuddyUsageSnapshots(db, "a1", [
      { day: "2026-10-15", model: "glm-5.2", credit: 4 },
      { day: "2026-10-15", model: "hy3", credit: 1 },
    ]);
    // The same day re-read after one more request landed on glm-5.2.
    await saveBuddyUsageSnapshots(db, "a1", [{ day: "2026-10-15", model: "glm-5.2", credit: 6 }]);

    const rows = (await readBuddyUsageSnapshots(db, ["a1"])).get("a1") ?? [];
    expect(rows).toHaveLength(2);
    const glm = rows.find((row) => row.model === "glm-5.2");
    // Replaced, not summed: 6, not 10.
    expect(glm?.credit).toBe(6);
    sqlite.close();
  });

  test("reads buckets newest day first and totals them per model", async () => {
    const { db, sqlite } = await fresh();
    await saveBuddyUsageSnapshots(db, "a1", [
      { day: "2026-10-14", model: "glm-5.2", credit: 2 },
      { day: "2026-10-15", model: "glm-5.2", credit: 3 },
      { day: "2026-10-15", model: "hy3", credit: 1.5 },
    ]);
    const rows = (await readBuddyUsageSnapshots(db, ["a1"])).get("a1") ?? [];
    expect(rows[0]?.day).toBe("2026-10-15");
    const total = rows.reduce((sum, row) => sum + row.credit, 0);
    expect(total).toBe(6.5);
    sqlite.close();
  });

  test("an account with no snapshot reads as no data, not zero", async () => {
    const { db, sqlite } = await fresh();
    const result = await readBuddyUsageSnapshots(db, ["a1"]);
    expect(result.get("a1")).toBeUndefined();
    sqlite.close();
  });

  test("a snapshot survives its account being re-read alongside another", async () => {
    const { db, sqlite } = await fresh();
    sqlite.exec(
      "INSERT INTO provider_accounts (id, provider_id, label, credential_kind) VALUES ('a2','cbcn','M','oauth')",
    );
    await saveBuddyUsageSnapshots(db, "a1", [{ day: "2026-10-15", model: "glm-5.2", credit: 5 }]);
    await saveBuddyUsageSnapshots(db, "a2", [{ day: "2026-10-15", model: "hy3", credit: 7 }]);
    const result = await readBuddyUsageSnapshots(db, ["a1", "a2"]);
    expect(result.get("a1")?.[0]?.credit).toBe(5);
    expect(result.get("a2")?.[0]?.credit).toBe(7);
    sqlite.close();
  });

  test("pruning drops days older than the upstream window", async () => {
    const { db, sqlite } = await fresh();
    await saveBuddyUsageSnapshots(db, "a1", [
      { day: "2026-01-01", model: "glm-5.2", credit: 1 },
      { day: "2026-10-15", model: "glm-5.2", credit: 2 },
    ]);
    await pruneBuddyUsageSnapshots(db, new Date("2026-10-16T00:00:00Z"));
    const rows = (await readBuddyUsageSnapshots(db, ["a1"])).get("a1") ?? [];
    expect(rows.map((row) => row.day)).toEqual(["2026-10-15"]);
    sqlite.close();
  });

  test("a write failure returns 0 rather than throwing", async () => {
    // A snapshot that could not be stored is a stale display, not an error the
    // sync has to handle — throwing there would take the whole pass down.
    const broken = {
      insert: () => {
        throw new Error("write failed");
      },
    } as unknown as CartethyiaDatabase;
    const written = await saveBuddyUsageSnapshots(broken, "a1", [
      { day: "2026-10-15", model: "glm-5.2", credit: 1 },
    ]);
    expect(written).toBe(0);
  });
});
