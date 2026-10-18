---
name: cartethyia-schema-telemetry
description: "Schema and telemetry changes: update the canonical schema and generated baselines, restore mappings, or add a usage/telemetry field. Use for database baselines, telemetry_events/usage_totals, and combo-strategy renames."
---

# Schema and telemetry

Use for a schema change, a baseline update, or a new usage/telemetry field.

## Schema changes

The repository ships one baseline per backend plus the numbered files that
have not yet been folded into it. A fresh database builds from
`0000_baseline.sql`. An existing database applies every later numbered file
whose id is absent from `cartethyia_schema_migrations`, in order, on both
backends (`src/persistence/db-sqlite.ts`, `src/persistence/db-pg.ts`). A
database whose ledger names a file that no longer exists is rejected: recreate
it and restore from backup. Do not rewrite a released baseline.

1. Update `src/persistence/schema.ts`.
2. For a change an existing database must receive, add the next numbered file
   to **both** `migrations/full-postgres/` and `migrations/lite-sqlite3/`. The
   statement must be a no-op on a database the current baseline already
   created, because a fresh install runs the baseline and then every later
   file. `0008_add_models_route_unique_index.sql` is the shape: the bundled
   model seed upserts on an index a pre-baseline database does not have, and
   boot dies without it.
3. Fold the change into `migrations/full-postgres/0000_baseline.sql` as well,
   so a fresh database is born with it. Regenerate the SQLite baseline with
   `bun scripts/generate/sqlite-ddl.ts`; `test/persistence/sqlite-baseline.test.ts`
   fails when the two disagree. Do not edit the SQLite baseline by hand.
4. Update backup validation and restore mapping for old column names, enum
   values, defaults, or required data that must survive recreation.
5. Test the fresh schema, the numbered file against a database created before
   it, and legacy backup restoration. Never test against a live development
   or production database.

Drizzle numeric columns may require string persistence. Use bigint number mode
for absolute epoch milliseconds. Manual migrations are not applied by the boot
ledger; report them separately.

## Persisted telemetry fields

Per-request events are hourly JSONL under `./data/telemetry-events`
(`src/observability/event-log.ts`). The database keeps aggregates in
`telemetry_usage_totals` only; do not add a reader back onto `telemetry_events`.
Payload capture stays a separate append-only file under
`data/telemetry-payloads/`.

A new usage field must pass through canonical usage, normalization, the file
writer, console contract/store, dashboard validator, and Usage UI. Reject invalid
upstream values; do not silently clamp them. An aggregate that must survive
retention also needs the schema and both baselines. Update restore mapping when
old backups do not carry the field or use a retired representation.

## Renames and strategy removal

Change the canonical enum/model, router, console contract/store, validation,
catalog snapshot, schema, both baselines, backup mapping, dashboard
contract/hook/card, and docs. No alias fields.

Combo strategies are `fallback` and `round_robin`. There is no fusion strategy
and no minimum-balance floor: do not reintroduce
`model_combo_strategy.fusion`, `credit_limit`, or the account remaining-balance
stamps. The fresh baseline must exclude retired enum values; normalize legacy
backup rows to the current strategy during restore.

## Verify

The gate list is `cartethyia-engineering/references/verification.md`; run those,
plus `bun run test:backend`.

The boundary specific to this skill is the database: exercise the fresh
baseline and legacy backup mappings. Never reset production data — use the
disposable database configured with `CARTETHYIA_TEST_DATABASE_URL` in the local
`.env` or shell (`bun run test-db:up/check/down`).
