-- Provider-scoped probe verdict, persisted beside the pool's other last-known
-- facts (`egress_ip`, `last_latency_ms`, the speed-test columns).
--
-- It lived in the browser's `localStorage` first, which made it decorative: the
-- verdict was visible to the operator who ran it and to nobody else — not to
-- another machine, not to the gateway, and not to admission. A pool could read
-- "OpenCode blocked" on screen while dispatch kept sending traffic through it,
-- because nothing outside that one browser had ever heard the verdict.
--
-- Every column is nullable: `NULL` means never probed, and every existing row
-- keeps exactly that meaning. `provider_probe_endpoint` records the address the
-- verdict was measured against, so an edited endpoint reports "never probed"
-- rather than showing a verdict about a proxy that no longer exists.
ALTER TABLE "network_pools"
  ADD COLUMN "provider_probe_provider_id" text;
ALTER TABLE "network_pools"
  ADD COLUMN "provider_probe_status" text;
ALTER TABLE "network_pools"
  ADD COLUMN "provider_probe_http_status" integer;
ALTER TABLE "network_pools"
  ADD COLUMN "provider_probe_reason" text;
ALTER TABLE "network_pools"
  ADD COLUMN "provider_probe_latency_ms" integer;
ALTER TABLE "network_pools"
  ADD COLUMN "provider_probe_at" text;
ALTER TABLE "network_pools"
  ADD COLUMN "provider_probe_endpoint" text;
