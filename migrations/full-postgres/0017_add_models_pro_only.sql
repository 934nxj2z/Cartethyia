-- Whether the upstream refuses this model on a free plan.
--
-- CodeBuddy is why this is a column and not a derived rule. Its console
-- directory publishes no field that predicts access: `credits` and `vendor`
-- were both measured against real dispatches and neither correlates — one model
-- billed at `x1.62` is served on a free account while one billed at `x0.14` is
-- refused. The only signal is the refusal itself, `11158 "model [X] is not
-- allowed for user type [personal_free_user]"`, so the answer has to be
-- recorded per model rather than computed from the catalog.
--
-- Nullable three-valued on purpose. `true` is refused on a free plan and
-- `false` is served there; `NULL` is "nobody established it", which is the
-- state of every model on every provider that publishes nothing about plan
-- access. Collapsing that into `false` would assert, for thousands of rows, a
-- fact nobody measured — and would make a pro-only row that predates this
-- column indistinguishable from a genuinely free one.
ALTER TABLE "models"
  ADD COLUMN IF NOT EXISTS "pro_only" boolean;
