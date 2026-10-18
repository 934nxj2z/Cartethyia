-- Adds `gemini` to the wire_family CHECK constraints (Lite / SQLite).
--
-- Factory serves Gemini models on a native generateContent wire
-- (`/api/llm/g/v1/generate`), not the chat wire, so a Gemini id routed onto
-- `chat` posts to an endpoint that does not serve it.
--
-- SQLite cannot alter a CHECK constraint in place, so both tables that carry a
-- wire family are rebuilt.
--
-- The runner already wraps each migration in a transaction, so this file must
-- NOT issue BEGIN/COMMIT — doing so fails with "cannot commit - no transaction
-- is active". For the same reason `PRAGMA foreign_keys = OFF` is unusable: that
-- pragma is a no-op inside a transaction. Instead the rebuild uses
-- `defer_foreign_keys`, which IS settable inside a transaction and postpones
-- enforcement to commit time, so dropping and recreating a parent table does
-- not trip child rows mid-rebuild.
--
-- NOTE: `lite-sqlite3/0000_baseline.sql` is GENERATED
-- (`scripts/generate/sqlite-ddl.ts`) and must not be edited by hand. Forward
-- migrations like this one are hand-authored; that is the documented split.

PRAGMA defer_foreign_keys = ON;

-- providers: rebuild with the widened CHECK.
CREATE TABLE "providers__new" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text,
  "wire_family_default" text,
  "capability_profile" text,
  "base_url" text,
  "compatibility_profile" text,
  "enabled" integer DEFAULT true NOT NULL CHECK ("enabled" IN (0, 1)),
  "requires_account" integer DEFAULT true NOT NULL CHECK ("requires_account" IN (0, 1)),
  CONSTRAINT "providers_wire_family_default_enum_check" CHECK ("wire_family_default" IS NULL OR "wire_family_default" IN ('chat', 'responses', 'messages', 'gemini')),
  CONSTRAINT "providers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade
);
INSERT INTO "providers__new" SELECT "id", "tenant_id", "wire_family_default", "capability_profile", "base_url", "compatibility_profile", "enabled", "requires_account" FROM "providers";
DROP TABLE "providers";
ALTER TABLE "providers__new" RENAME TO "providers";

-- models: rebuild with the widened CHECK.
CREATE TABLE "models__new" (
  "id" text PRIMARY KEY NOT NULL,
  "provider_id" text NOT NULL,
  "model_id" text NOT NULL,
  "wire_family" text NOT NULL,
  "service_kind" text DEFAULT 'llm' NOT NULL,
  "endpoint_path" text NOT NULL,
  "context_limit" integer,
  "output_limit" integer,
  "modalities" text,
  "reasoning" integer DEFAULT false NOT NULL CHECK ("reasoning" IN (0, 1)),
  "tool_call" integer DEFAULT false NOT NULL CHECK ("tool_call" IN (0, 1)),
  "cost" text,
  "source" text,
  "source_updated_at" text,
  "enabled" integer DEFAULT true NOT NULL CHECK ("enabled" IN (0, 1)),
  CONSTRAINT "models_wire_family_enum_check" CHECK ("wire_family" IS NULL OR "wire_family" IN ('chat', 'responses', 'messages', 'gemini')),
  CONSTRAINT "models_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE cascade
);
INSERT INTO "models__new" SELECT "id", "provider_id", "model_id", "wire_family", "service_kind", "endpoint_path", "context_limit", "output_limit", "modalities", "reasoning", "tool_call", "cost", "source", "source_updated_at", "enabled" FROM "models";
DROP TABLE "models";
ALTER TABLE "models__new" RENAME TO "models";

-- Enforcement resumes at commit; if the rebuild left a dangling reference the
-- commit fails and startup aborts rather than persisting a broken schema.
PRAGMA defer_foreign_keys = OFF;
