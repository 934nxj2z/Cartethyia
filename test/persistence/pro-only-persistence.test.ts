/**
 * The two columns the plan gate reads, as the database actually stores them.
 *
 * `models.pro_only` and `provider_accounts.quota_plan` exist because routing
 * has to answer one question per (account, model) pair: does this upstream
 * refuse this model on this account's plan? CodeBuddy is the case — it refuses
 * six models on a free plan, nothing in its model directory predicts which, and
 * the account's own plan is the only signal.
 *
 * Both columns are nullable three-valued, and that is the property worth
 * pinning: `NULL` means nobody established the value, and a read that collapses
 * it into `false` turns "unknown" into "free", which would send pro-only
 * traffic to an account that may well be refused.
 *
 * SQLite in memory rather than a service: both columns are created by the same
 * numbered migration on both backends, and the baseline test already pins that
 * the two backends carry the same file set.
 */
import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { applySqliteMigrations, createSqliteDatabase } from "../../src/persistence/db-sqlite";

async function boot(): Promise<Database> {
  const sqlite = createSqliteDatabase(":memory:");
  await applySqliteMigrations(sqlite);
  return sqlite;
}

test("models.pro_only exists and is nullable three-valued", async () => {
  const sqlite = await boot();
  sqlite.exec("INSERT INTO providers (id) VALUES ('cb')");
  sqlite.exec(
    `INSERT INTO models (id, provider_id, model_id, wire_family, endpoint_path, pro_only)
     VALUES ('m-1', 'cb', 'gpt-5.5', 'chat', '/v2/chat/completions', 1)`,
  );
  sqlite.exec(
    `INSERT INTO models (id, provider_id, model_id, wire_family, endpoint_path, pro_only)
     VALUES ('m-2', 'cb', 'hy3', 'chat', '/v2/chat/completions', 0)`,
  );
  // A row written before the column existed, and every row on every provider
  // that publishes nothing about plan access.
  sqlite.exec(
    `INSERT INTO models (id, provider_id, model_id, wire_family, endpoint_path)
     VALUES ('m-3', 'cb', 'glm-5.3', 'chat', '/v2/chat/completions')`,
  );

  const rows = sqlite
    .query("SELECT model_id, pro_only FROM models WHERE provider_id = 'cb' ORDER BY model_id")
    .all() as Array<{ model_id: string; pro_only: number | null }>;
  expect(rows).toEqual([
    { model_id: "glm-5.3", pro_only: null },
    { model_id: "gpt-5.5", pro_only: 1 },
    { model_id: "hy3", pro_only: 0 },
  ]);
});

test("provider_accounts.quota_plan exists and defaults to unknown, not free", async () => {
  const sqlite = await boot();
  sqlite.exec("INSERT INTO providers (id) VALUES ('cb')");
  sqlite.exec(
    `INSERT INTO provider_accounts (id, provider_id, label, credential_kind)
     VALUES ('acct-1', 'cb', 'cb', 'oauth')`,
  );

  const before = sqlite
    .query("SELECT quota_plan FROM provider_accounts WHERE id = 'acct-1'")
    .get() as { quota_plan: string | null };
  // The value routing must read as "unknown", never as "free".
  expect(before.quota_plan).toBeNull();

  sqlite.exec("UPDATE provider_accounts SET quota_plan = 'Free Plan Subscription' WHERE id = 'acct-1'");
  const after = sqlite
    .query("SELECT quota_plan FROM provider_accounts WHERE id = 'acct-1'")
    .get() as { quota_plan: string | null };
  expect(after.quota_plan).toBe("Free Plan Subscription");
});

test("a quota_plan survives alongside the health columns it shares a row with", async () => {
  // The concern is not the column but the write: the quota refresh updates
  // health fields on every pass, and a plan recorded one pass must not be
  // clobbered by the next one's health update.
  const sqlite = await boot();
  sqlite.exec("INSERT INTO providers (id) VALUES ('cb')");
  sqlite.exec(
    `INSERT INTO provider_accounts (id, provider_id, label, credential_kind, quota_plan)
     VALUES ('acct-1', 'cb', 'cb', 'oauth', 'Pro Plan')`,
  );
  sqlite.exec(
    `UPDATE provider_accounts
     SET last_success_at = '2026-10-19T00:00:00Z', consecutive_failures = 0
     WHERE id = 'acct-1'`,
  );

  const row = sqlite
    .query("SELECT quota_plan, consecutive_failures FROM provider_accounts WHERE id = 'acct-1'")
    .get() as { quota_plan: string | null; consecutive_failures: number };
  expect(row.quota_plan).toBe("Pro Plan");
  expect(row.consecutive_failures).toBe(0);
});
