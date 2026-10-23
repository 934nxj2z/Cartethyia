/**
 * A restore can be narrowed to the tables the operator selected.
 *
 * A backup file carries every section it was exported with, and "restore"
 * used to mean all of it — so bringing back one table meant overwriting the
 * rest with the file's older copy. The dashboard now inspects the file first
 * and sends the checklist; this pins the server side of that contract.
 *
 * The two properties that matter:
 *
 * - **A selection is a filter, not a rewrite.** A table that was not named is
 *   left exactly as it was — not cleared, not touched.
 * - **"Everything" is the default.** An absent or empty selection restores the
 *   whole file, which is what the API did before selection existed, so an
 *   older client cannot silently get a partial restore.
 */
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb } from "../../src/persistence/boot";
import { BackupService } from "../../src/console/backup/service";
import { exportBackup } from "../../src/console/backup/store";
import { tablesForSection } from "../../src/console/backup/contracts";
import { dbDescribe, requireDatabase } from "../helpers/database";
import { createWorld } from "../helpers/fixtures";

requireDatabase();

/**
 * Creates the tenant a partial restore writes into.
 *
 * The tenant row rides along with any config selection (it is not a table of
 * either section, so it never appears on the checklist), but it is inserted
 * with `onConflictDoNothing` and restores nothing when the selection names
 * only a table whose parent has to pre-exist. A partial restore into a tenant
 * that does not exist yet is a foreign-key error, not a filtering bug, so the
 * tests create the row first.
 */
async function ensureTenant(tenantId: string): Promise<void> {
  const db = getDb();
  await db.execute(
    sql`insert into tenants (id, name, status) values (${tenantId}, 'restore target', 'active') on conflict (id) do nothing`,
  );
}

/**
 * Drops the exporting tenant's own rows after the payload has been taken.
 *
 * Same reason as the portability suite: primary keys are global, not
 * per-tenant, so a source row that still exists collides with the payload's
 * copy of itself the moment that payload lands in another tenant of the *same*
 * database. A real migration never hits this — the receiving install is a
 * different database holding none of these ids.
 */
async function dropSourceRows(tenantId: string): Promise<void> {
  const db = getDb();
  await db.execute(sql`delete from api_keys where tenant_id = ${tenantId}`);
  await db.execute(sql`delete from provider_accounts where tenant_id = ${tenantId}`);
}

dbDescribe("restore selection", () => {
  test("only the selected tables are written", async () => {
    const db = getDb();
    const world = await createWorld();
    await world.addAccount({ tenantId: world.tenantId, credential: "sk-a", credentialKind: "api_key" });

    const { payload } = await exportBackup(db, tablesForSection("config"), world.tenantId);
    await dropSourceRows(world.tenantId);
    const shape = payload as unknown as {
      readonly sections: { readonly config: Record<string, readonly unknown[]> };
    };
    const present = Object.keys(shape.sections.config);
    expect(present.length).toBeGreaterThan(1);

    const service = new BackupService({ db, verifyPassword: async () => true });
    const tenantId = randomUUID();
    await ensureTenant(tenantId);
    // Exactly one table, and one the file actually carries.
    const only = present[0]!;
    const result = await service.restore("pw", payload, tenantId, { tables: [only] });

    const written = Object.keys(result.restored).filter((table) => table !== "tenants");
    expect(written).toEqual([only]);
    // The whole point: every other table in the file was left alone.
    for (const table of present.slice(1)) {
      if (table === "tenants") continue;
      expect(written).not.toContain(table);
    }
  });

  test("an absent selection restores the whole file", async () => {
    // The default, and the pre-existing behavior: an API client that knows
    // nothing about selection must still get a complete restore.
    const db = getDb();
    const world = await createWorld();
    await world.addAccount({ tenantId: world.tenantId, credential: "sk-b", credentialKind: "api_key" });

    const { payload } = await exportBackup(db, tablesForSection("config"), world.tenantId);
    await dropSourceRows(world.tenantId);
    const service = new BackupService({ db, verifyPassword: async () => true });
    const tenantId = randomUUID();
    await ensureTenant(tenantId);
    const result = await service.restore("pw", payload, tenantId);

    const shape = payload as unknown as {
      readonly sections: { readonly config: Record<string, readonly unknown[]> };
    };
    for (const [table, rows] of Object.entries(shape.sections.config)) {
      if (table === "tenants" || rows.length === 0) continue;
      expect(result.restored[table]).toBe(rows.length);
    }
  });

  test("a selection naming a table the file lacks is not an error", async () => {
    // The checklist comes from an inspection of one file, but a selection is
    // validated as names only. Refusing to restore anything over one stale
    // name would be worse than ignoring it.
    const db = getDb();
    const world = await createWorld();
    await world.addAccount({ tenantId: world.tenantId, credential: "sk-c", credentialKind: "api_key" });

    const { payload } = await exportBackup(db, tablesForSection("config"), world.tenantId);
    await dropSourceRows(world.tenantId);
    const service = new BackupService({ db, verifyPassword: async () => true });
    // A table the file actually carries rows for, so "restored" is a real
    // count and not the zero an empty table would legitimately report.
    const config = (payload as unknown as { sections: { config: Record<string, readonly unknown[]> } })
      .sections.config;
    const real = Object.entries(config).find(([, rows]) => rows.length > 0)?.[0]!;

    const tenantId = randomUUID();
    await ensureTenant(tenantId);
    const result = await service.restore("pw", payload, tenantId, {
      tables: [real, "table_that_does_not_exist"],
    });
    expect(result.restored[real]).toBeGreaterThan(0);
    expect(result.restored["table_that_does_not_exist"]).toBeUndefined();
  });

  test("an empty selection restores the whole file too", async () => {
    // `[]` is what "Select none" would send if it got through; the guard is
    // that it must not be read as "restore nothing" and silently no-op.
    const db = getDb();
    const world = await createWorld();
    await world.addAccount({ tenantId: world.tenantId, credential: "sk-d", credentialKind: "api_key" });

    const { payload } = await exportBackup(db, tablesForSection("config"), world.tenantId);
    await dropSourceRows(world.tenantId);
    const service = new BackupService({ db, verifyPassword: async () => true });
    const tenantId = randomUUID();
    await ensureTenant(tenantId);
    const result = await service.restore("pw", payload, tenantId, { tables: [] });
    expect(Object.keys(result.restored).length).toBeGreaterThan(0);
  });
});
