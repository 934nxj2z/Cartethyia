-- The plan the provider reports for this account, last seen by a quota read.
--
-- Routing needs it because some upstreams gate models on it. CodeBuddy
-- refuses a set of models on a free plan with `11158 "model [X] is not allowed
-- for user type [personal_free_user]"`, and nothing in its model directory
-- predicts which — only the account's own plan does. Without a persisted plan
-- the router cannot tell a pro account from a free one and would keep sending
-- pro-only traffic to an account that is certain to be refused.
--
-- Persisted rather than read from the quota cache: the cache is a 900 second
-- in-process TTL and empty on a cold start, so an account's plan would be
-- unknown exactly when a freshly booted process makes its first decisions.
-- The row is the only place that survives a restart.
--
-- Nullable: most providers report no plan at all, and an account whose plan
-- was never read must say so rather than inventing one.
ALTER TABLE "provider_accounts"
  ADD COLUMN "quota_plan" text;
