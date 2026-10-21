-- Whether the provider publishes this model as free.
--
-- Qoder states `is_free` per row in its own model directory, so the tier is a
-- fact the provider reports rather than something we have to infer. That is the
-- opposite of `pro_only`, which exists because CodeBuddy publishes nothing that
-- predicts plan access and only the refusal itself is a signal.
--
-- Nullable three-valued on purpose, matching `pro_only`: `true` is free,
-- `false` is billed, and `NULL` is "the provider did not state it". Qoder omits
-- the field entirely for several rows, and collapsing that absence into `false`
-- would assert a measured fact for models nobody measured. Absence must also
-- stay distinct from `false` on the surface, or a row that simply predates this
-- column would render as a billed model.
ALTER TABLE "models"
  ADD COLUMN IF NOT EXISTS "free_tier" boolean;
