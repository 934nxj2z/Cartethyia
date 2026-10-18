-- Rename the three OpenCode provider ids so the free tier is `opencode`
-- rather than `opencodeft`:
--
--   opencodeft  -> opencode
--   opencodezen -> opencode-zen
--   opencodego  -> opencode-go
--
-- Mirrors the PostgreSQL migration. The obvious form — `UPDATE "providers"
-- SET "id" = ...` — cannot work: every dependent table references
-- `providers.id` with `ON DELETE CASCADE` and no `ON UPDATE`, so moving the
-- parent row violates the constraint before any child can follow.
--
-- The row is copied under its new id, the children are repointed, and the old
-- row is dropped last. The runner applies each file in one transaction, so the
-- rename lands whole or not at all.
--
-- A database that never had these ids is unaffected — every statement matches
-- zero rows. If both spellings somehow exist, the repoint merges them onto the
-- new id, which is the correct outcome for one provider with two names.

-- opencodeft -> opencode
INSERT INTO "providers" (
  "id", "tenant_id", "wire_family_default", "capability_profile", "base_url",
  "compatibility_profile", "enabled", "requires_account"
)
SELECT
  'opencode', "tenant_id", "wire_family_default", "capability_profile", "base_url",
  "compatibility_profile", "enabled", "requires_account"
FROM "providers"
WHERE "id" = 'opencodeft'
ON CONFLICT ("id") DO NOTHING;

-- Drop rows the repoint would collide with on a unique index.
DELETE FROM "models"
  WHERE "provider_id" = 'opencodeft'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'opencode')
    AND EXISTS (
      SELECT 1 FROM "models" AS keep
      WHERE keep."provider_id" = 'opencode'
        AND keep."model_id" = "models"."model_id"
        AND keep."endpoint_path" = "models"."endpoint_path"
    );
DELETE FROM "tenant_disabled_models"
  WHERE "provider_id" = 'opencodeft'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'opencode')
    AND EXISTS (
      SELECT 1 FROM "tenant_disabled_models" AS keep
      WHERE keep."provider_id" = 'opencode'
        AND keep."tenant_id" = "tenant_disabled_models"."tenant_id"
        AND keep."model_id" = "tenant_disabled_models"."model_id"
        AND keep."endpoint_path" = "tenant_disabled_models"."endpoint_path"
    );
DELETE FROM "provider_accounts"
  WHERE "provider_id" = 'opencodeft'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'opencode')
    AND EXISTS (
      SELECT 1 FROM "provider_accounts" AS keep
      WHERE keep."provider_id" = 'opencode'
        AND keep."tenant_id" IS "provider_accounts"."tenant_id"
        AND keep."credential_fingerprint" IS "provider_accounts"."credential_fingerprint"
    );
DELETE FROM "provider_routing_settings"
  WHERE "provider_id" = 'opencodeft'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'opencode')
    AND EXISTS (
      SELECT 1 FROM "provider_routing_settings" AS keep
      WHERE keep."provider_id" = 'opencode'
        AND keep."tenant_id" IS "provider_routing_settings"."tenant_id"
    );

UPDATE "provider_accounts" SET "provider_id" = 'opencode'
  WHERE "provider_id" = 'opencodeft'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'opencode');
UPDATE "models" SET "provider_id" = 'opencode'
  WHERE "provider_id" = 'opencodeft'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'opencode');
UPDATE "tenant_disabled_models" SET "provider_id" = 'opencode'
  WHERE "provider_id" = 'opencodeft'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'opencode');
UPDATE "provider_routing_settings" SET "provider_id" = 'opencode'
  WHERE "provider_id" = 'opencodeft'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'opencode');
UPDATE "telemetry_events" SET "provider_id" = 'opencode'
  WHERE "provider_id" = 'opencodeft'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'opencode');

DELETE FROM "providers"
  WHERE "id" = 'opencodeft'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'opencode');

-- opencodezen -> opencode-zen
INSERT INTO "providers" (
  "id", "tenant_id", "wire_family_default", "capability_profile", "base_url",
  "compatibility_profile", "enabled", "requires_account"
)
SELECT
  'opencode-zen', "tenant_id", "wire_family_default", "capability_profile", "base_url",
  "compatibility_profile", "enabled", "requires_account"
FROM "providers"
WHERE "id" = 'opencodezen'
ON CONFLICT ("id") DO NOTHING;

-- Drop rows the repoint would collide with on a unique index.
DELETE FROM "models"
  WHERE "provider_id" = 'opencodezen'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'opencode-zen')
    AND EXISTS (
      SELECT 1 FROM "models" AS keep
      WHERE keep."provider_id" = 'opencode-zen'
        AND keep."model_id" = "models"."model_id"
        AND keep."endpoint_path" = "models"."endpoint_path"
    );
DELETE FROM "tenant_disabled_models"
  WHERE "provider_id" = 'opencodezen'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'opencode-zen')
    AND EXISTS (
      SELECT 1 FROM "tenant_disabled_models" AS keep
      WHERE keep."provider_id" = 'opencode-zen'
        AND keep."tenant_id" = "tenant_disabled_models"."tenant_id"
        AND keep."model_id" = "tenant_disabled_models"."model_id"
        AND keep."endpoint_path" = "tenant_disabled_models"."endpoint_path"
    );
DELETE FROM "provider_accounts"
  WHERE "provider_id" = 'opencodezen'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'opencode-zen')
    AND EXISTS (
      SELECT 1 FROM "provider_accounts" AS keep
      WHERE keep."provider_id" = 'opencode-zen'
        AND keep."tenant_id" IS "provider_accounts"."tenant_id"
        AND keep."credential_fingerprint" IS "provider_accounts"."credential_fingerprint"
    );
DELETE FROM "provider_routing_settings"
  WHERE "provider_id" = 'opencodezen'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'opencode-zen')
    AND EXISTS (
      SELECT 1 FROM "provider_routing_settings" AS keep
      WHERE keep."provider_id" = 'opencode-zen'
        AND keep."tenant_id" IS "provider_routing_settings"."tenant_id"
    );

UPDATE "provider_accounts" SET "provider_id" = 'opencode-zen'
  WHERE "provider_id" = 'opencodezen'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'opencode-zen');
UPDATE "models" SET "provider_id" = 'opencode-zen'
  WHERE "provider_id" = 'opencodezen'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'opencode-zen');
UPDATE "tenant_disabled_models" SET "provider_id" = 'opencode-zen'
  WHERE "provider_id" = 'opencodezen'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'opencode-zen');
UPDATE "provider_routing_settings" SET "provider_id" = 'opencode-zen'
  WHERE "provider_id" = 'opencodezen'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'opencode-zen');
UPDATE "telemetry_events" SET "provider_id" = 'opencode-zen'
  WHERE "provider_id" = 'opencodezen'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'opencode-zen');

DELETE FROM "providers"
  WHERE "id" = 'opencodezen'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'opencode-zen');

-- opencodego -> opencode-go
INSERT INTO "providers" (
  "id", "tenant_id", "wire_family_default", "capability_profile", "base_url",
  "compatibility_profile", "enabled", "requires_account"
)
SELECT
  'opencode-go', "tenant_id", "wire_family_default", "capability_profile", "base_url",
  "compatibility_profile", "enabled", "requires_account"
FROM "providers"
WHERE "id" = 'opencodego'
ON CONFLICT ("id") DO NOTHING;

-- Drop rows the repoint would collide with on a unique index.
DELETE FROM "models"
  WHERE "provider_id" = 'opencodego'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'opencode-go')
    AND EXISTS (
      SELECT 1 FROM "models" AS keep
      WHERE keep."provider_id" = 'opencode-go'
        AND keep."model_id" = "models"."model_id"
        AND keep."endpoint_path" = "models"."endpoint_path"
    );
DELETE FROM "tenant_disabled_models"
  WHERE "provider_id" = 'opencodego'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'opencode-go')
    AND EXISTS (
      SELECT 1 FROM "tenant_disabled_models" AS keep
      WHERE keep."provider_id" = 'opencode-go'
        AND keep."tenant_id" = "tenant_disabled_models"."tenant_id"
        AND keep."model_id" = "tenant_disabled_models"."model_id"
        AND keep."endpoint_path" = "tenant_disabled_models"."endpoint_path"
    );
DELETE FROM "provider_accounts"
  WHERE "provider_id" = 'opencodego'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'opencode-go')
    AND EXISTS (
      SELECT 1 FROM "provider_accounts" AS keep
      WHERE keep."provider_id" = 'opencode-go'
        AND keep."tenant_id" IS "provider_accounts"."tenant_id"
        AND keep."credential_fingerprint" IS "provider_accounts"."credential_fingerprint"
    );
DELETE FROM "provider_routing_settings"
  WHERE "provider_id" = 'opencodego'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'opencode-go')
    AND EXISTS (
      SELECT 1 FROM "provider_routing_settings" AS keep
      WHERE keep."provider_id" = 'opencode-go'
        AND keep."tenant_id" IS "provider_routing_settings"."tenant_id"
    );

UPDATE "provider_accounts" SET "provider_id" = 'opencode-go'
  WHERE "provider_id" = 'opencodego'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'opencode-go');
UPDATE "models" SET "provider_id" = 'opencode-go'
  WHERE "provider_id" = 'opencodego'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'opencode-go');
UPDATE "tenant_disabled_models" SET "provider_id" = 'opencode-go'
  WHERE "provider_id" = 'opencodego'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'opencode-go');
UPDATE "provider_routing_settings" SET "provider_id" = 'opencode-go'
  WHERE "provider_id" = 'opencodego'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'opencode-go');
UPDATE "telemetry_events" SET "provider_id" = 'opencode-go'
  WHERE "provider_id" = 'opencodego'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'opencode-go');

DELETE FROM "providers"
  WHERE "id" = 'opencodego'
    AND EXISTS (SELECT 1 FROM "providers" WHERE "id" = 'opencode-go');
