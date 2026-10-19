# Known schema drift — do not auto-generate

`bun run check:migrations` (`scripts/ci/check-migrations.ts`) currently fails.
The drift is **pre-existing**, present since the initial 2.3.0 release, and is
recorded here rather than fixed by generation: `drizzle-kit generate` would
rewrite all 15 committed baselines.

Three differences, all between `src/persistence/schema.ts` and
`migrations/full-postgres/0000_baseline.sql`:

## 1. `api_keys_one_default_per_tenant_uidx` — in the SQL, not in the schema

The baseline creates it:

```sql
CREATE UNIQUE INDEX "api_keys_one_default_per_tenant_uidx" ON "api_keys"
  USING btree ("tenant_id") WHERE "is_default" = true AND "revoked_at" IS NULL;
```

`schema.ts` has no matching `uniqueIndex(...).where(...)`.

This index is **load-bearing**: it is the only thing enforcing "one live
default key per tenant" at the database level, and
`test/persistence/sqlite-baseline.test.ts` pins it by name. The SQLite baseline
carries it too. So the SQL is right and the *schema* is the one that is
incomplete — the fix is to add the index to `schema.ts`, not to drop it from
the migrations. Dropping it would silently remove the constraint.

## 2. `health_events_account_model_created_idx` — `DESC` in SQL, ascending in schema

```sql
-- baseline
CREATE INDEX "health_events_account_model_created_idx" ON "health_events"
  USING btree ("account_id", "model_id", "created_at" DESC);
```

`schema.ts:490` declares it without a direction:

```ts
index("health_events_account_model_created_idx").on(table.accountId, table.modelId, table.createdAt),
```

The SQLite baseline (derived from the Postgres baseline) has no `DESC` either,
so the two backends already disagree with each other. Either the `DESC` is a
deliberate hot-path choice (newest-first scans for health history) that should
be expressed in the schema, or it is an accident that should be dropped.
Deciding needs to know whether any query plan depends on the ordering — an
ascending index can still serve `ORDER BY created_at DESC` via a backward scan,
so this may be cosmetic. **Not resolved here.**

## 3. Naming differences — not drift

`_pkey` vs `_tenant_id_tool_id_api_key_id_pk`, `_fkey` vs
`_account_id_provider_accounts_id_fk`, and similar. The two generators name the
same object differently. `check-migrations.ts` normalizes these away.

---

## Resolving

1. Add the missing `uniqueIndex(...).where(...)` for (1) to `schema.ts`, then
   add a forward migration that creates it idempotently
   (`CREATE UNIQUE INDEX IF NOT EXISTS`) so databases that already have it
   from the baseline are unaffected.
2. Decide (2) explicitly, then make the schema and both baselines agree.
3. Re-run `bun run check:migrations`; it must print `OK`.

Until then the check is expected to fail, and that failure is the record of
this debt — do not weaken the check to make it green.
