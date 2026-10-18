-- Indexes `providers.tenant_id` on its own; see the identically named
-- PostgreSQL migration for why. Both backends must apply the same behavior,
-- and SQLite mirrors the PostgreSQL spelling here because the schema is shared.
CREATE INDEX IF NOT EXISTS "providers_tenant_id_idx" ON "providers" ("tenant_id");
