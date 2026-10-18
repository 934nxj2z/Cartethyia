-- Adds `buddy_usage_snapshots`: per-day, per-model credit deductions read from
-- the buddy billing meter's usage-detail endpoint.
--
-- The console's usage view used to have no number behind it — the only activity
-- we reported was the synthetic `/v2/report` events we send ourselves. This
-- table is where the *real* figure is stored, so a page open renders a stored
-- value instead of re-hitting the billing endpoint for every account, and a
-- failed read still shows the last number obtained rather than nothing.
--
-- A snapshot rather than a ledger: the upstream is the source of truth and
-- answers the whole window on every call, so rows are upserted, never appended.
-- The composite PK is the upsert's conflict target.
--
-- `CREATE TABLE IF NOT EXISTS` keeps the file idempotent: a database built from
-- a newer baseline that already carries the table must not fail startup.
CREATE TABLE IF NOT EXISTS "buddy_usage_snapshots" (
  "account_id" uuid NOT NULL REFERENCES "provider_accounts"("id") ON DELETE cascade,
  "day_key" text NOT NULL,
  "model" text NOT NULL,
  "credit" numeric(14, 4) NOT NULL,
  "synced_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "buddy_usage_snapshots_account_id_day_key_model_pk" PRIMARY KEY("account_id","day_key","model")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "buddy_usage_snapshots_day_idx" ON "buddy_usage_snapshots" USING btree ("day_key");
