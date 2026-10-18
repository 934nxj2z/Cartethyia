-- Per-pool inflight ceiling for one provider.
--
-- `provider_routing_settings.max_inflight` bounds a single account, and
-- `network_pools.max_inflight` bounds a pool across every provider. Neither can
-- say "this proxy may carry at most N concurrent requests *for this provider*",
-- which is the limit that keeps one provider from saturating an egress — and,
-- for a provider that flags source IPs under load, the limit that keeps the
-- address alive.
--
-- Nullable with no default on purpose. NULL means unlimited, so every existing
-- row keeps its exact behaviour and no deployment gains a cap it did not ask
-- for. The column is additive: nothing is backfilled, nothing is rewritten.
ALTER TABLE "provider_routing_settings"
  ADD COLUMN "max_inflight_per_proxy" integer;
