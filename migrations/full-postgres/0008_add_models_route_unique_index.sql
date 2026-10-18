-- The model seed upserts on (provider_id, model_id, endpoint_path). A database
-- created before the baseline carried that unique index has no constraint for
-- the ON CONFLICT clause to match, so boot fails with "ON CONFLICT clause does
-- not match any PRIMARY KEY or UNIQUE constraint" and never finishes seeding.
-- Creating it here converges those databases; a fresh baseline already has it,
-- so the statement is a no-op there.
CREATE UNIQUE INDEX IF NOT EXISTS "models_provider_model_route_uidx"
  ON "models" ("provider_id", "model_id", "endpoint_path");
