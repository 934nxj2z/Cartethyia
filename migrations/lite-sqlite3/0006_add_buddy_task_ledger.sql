-- Adds `buddy_task_ledger` (Lite / SQLite) — see the identically named
-- PostgreSQL migration for why. Both backends must apply the same behavior;
-- SQLite stores `uuid` as text and `timestamptz` as text.
--
-- Idempotency comes from the migration ledger, not from the statement: the
-- runner records the file inside the same transaction, so a file that has
-- already run is never re-executed. The baseline is generated from
-- `0000_baseline.sql` alone and does not carry this table.
--
-- NOTE: the runner already wraps each migration in a transaction, so this file
-- must NOT issue BEGIN/COMMIT.
CREATE TABLE "buddy_task_ledger" (
  "day_key" text NOT NULL,
  "account_id" text NOT NULL,
  "task" text NOT NULL,
  "claimed_at" text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT "buddy_task_ledger_account_id_provider_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "provider_accounts"("id") ON DELETE cascade,
  CONSTRAINT "buddy_task_ledger_day_key_account_id_task_pk" PRIMARY KEY("day_key","account_id","task")
);
--> statement-breakpoint
CREATE INDEX "buddy_task_ledger_account_idx" ON "buddy_task_ledger" ("account_id");
