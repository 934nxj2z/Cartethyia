-- The model the upstream named in its own response, verbatim.
--
-- `requested_model` records what the client asked for. This records what the
-- provider said it ran, and the two are not the same field: a provider that
-- answers a `muse-spark` request as `deepseek-v4.1-flash` is telling the
-- operator something, and filling in the ask where the response carried none
-- would report the ask as if it were the answer.
--
-- Nullable with no default: NULL means the response named no model, which is a
-- real state for providers that omit the field. Nothing is backfilled — an
-- existing row never observed this value, so inventing one would be a claim.
ALTER TABLE "telemetry_events"
  ADD COLUMN "reported_model" text;
