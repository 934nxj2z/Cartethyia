-- Indexes `models.model_id` on its own; see the identically named PostgreSQL
-- migration for why. Both backends must apply the same behavior, and SQLite
-- mirrors the PostgreSQL spelling here because the schema is shared.
CREATE INDEX IF NOT EXISTS "models_model_id_idx" ON "models" ("model_id");
