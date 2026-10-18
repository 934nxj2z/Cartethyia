-- Adds `buddy_usage_snapshots` (Lite / SQLite) — see the identically named
-- PostgreSQL migration for why. Both backends must apply the same behavior;
-- SQLite stores `uuid` as text, `numeric` as-is, and `timestamptz` as text.
--
-- Idempotency here comes from the migration ledger, not from the statement:
-- SQLite has no `CREATE TABLE IF NOT EXISTS` with a PK in the same shape the
-- generator emits, and the runner records the file inside the same transaction,
-- so a file that has already run is never re-executed. The baseline is
-- generated from `0000_baseline.sql` alone and does not carry this table, so a
-- fresh database always reaches this file with it still absent.
--
-- NOTE: the runner already wraps each migration in a transaction, so this file
-- must NOT issue BEGIN/COMMIT.
CREATE TABLE "buddy_usage_snapshots" (
  "account_id" text NOT NULL,
  "day_key" text NOT NULL,
  "model" text NOT NULL,
  "credit" numeric(14, 4) NOT NULL,
  "synced_at" text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT "buddy_usage_snapshots_account_id_provider_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "provider_accounts"("id") ON DELETE cascade,
  CONSTRAINT "buddy_usage_snapshots_account_id_day_key_model_pk" PRIMARY KEY("account_id","day_key","model")
);
--> statement-breakpoint
CREATE INDEX "buddy_usage_snapshots_day_idx" ON "buddy_usage_snapshots" ("day_key");
