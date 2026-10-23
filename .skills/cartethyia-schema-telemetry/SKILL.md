---
name: cartethyia-schema-telemetry
description: "Schema and telemetry changes: update the canonical schema and generated baselines, restore mappings, or add a usage/telemetry field. Use for database baselines, telemetry_events/usage_totals, and combo-strategy renames."
---

# Schema and telemetry

Use for a schema change, a baseline update, or a new usage/telemetry field.

## Schema changes

The repository ships one baseline per backend plus the numbered files after it.
A fresh database builds from `0000_baseline.sql` and then applies **every**
forward file in order, on both backends (`src/persistence/db-sqlite.ts`,
`src/persistence/db-pg.ts`), and gets tables that only a numbered file creates.
Do not restate the file count here — it grows with every migration and rots
silently. Read `migrations/full-postgres/` (and `lite-sqlite3/`) instead; the
one place the list is legitimately written out is the pinned baseline test.

**Treat `0000_baseline.sql` as append-only history.** It is pinned by a content
hash: `baselineSchemaMarker()` records `sha256` of the file into
`cartethyia_schema_migrations`, and `assertMigrationHistorySupported()` rejects
any database whose recorded marker no longer matches the file on disk. So
editing the baseline does not upgrade existing databases — it makes them refuse
to boot, with "Create a fresh database and restore from a backup". A fresh
install gets forward-file changes anyway, so folding a change into the baseline
buys nothing and costs every existing deployment.

1. Update `src/persistence/schema.ts`.
2. Add the next numbered file to **both** `migrations/full-postgres/` and
   `migrations/lite-sqlite3/`. The statement must be a no-op on a database the
   current baseline already created, because a fresh install runs the baseline
   and then every later file. `0008_add_models_route_unique_index.sql` is the
   shape: the bundled model seed upserts on an index a pre-baseline database
   does not have, and boot dies without it.
3. Regenerate the SQLite baseline with `bun scripts/generate/sqlite-ddl.ts`
   **only** when the canonical schema itself changed in a way the SQLite
   derivation has to follow (a new table or column). `test/persistence/sqlite-baseline.test.ts`
   fails when the two disagree. Do not edit the SQLite baseline by hand.
   Do not touch `0000_baseline.sql` for a forward-only change.
4. Update backup validation and restore mapping for old column names, enum
   values, defaults, or required data that must survive recreation.
5. Test the fresh schema, the numbered file against a database created before
   it, and legacy backup restoration. Never test against a live development
   or production database.

Two consequences worth knowing before you touch `migrations/`:

- A schema edit that no migration covers is invisible until runtime. Run
  `bun run check:migrations` — it builds two throwaway databases (one from the
  committed SQL, one from the DDL Drizzle derives from `schema.ts`) and diffs
  their real catalogs. `drizzle-kit check` cannot do this: it compares against
  `migrations/**/meta/` snapshots, which this project never generates because
  the migrations are hand-written, so it reports "Everything's fine" even after
  a whole new table is added to the schema with no migration.
- Never run `drizzle-kit generate` against `migrations/`: it rewrites every
  committed baseline.

Drizzle numeric columns may require string persistence. Use bigint number mode
for absolute epoch milliseconds. Manual migrations are not applied by the boot
ledger; report them separately.

## Persisted telemetry fields

Per-request events are appended to one file per UTC day,
`<YYYY-MM-DD>.events.jsonl`, under the data dir's `telemetry-events/`
(`src/observability/event-log.ts`). The day's file is append-only and is never
rewritten while the day is open.

Beside it sits `<YYYY-MM-DD>.index.json`, written by
`src/observability/event-day-index.ts`. It carries running totals per
tenant/key, the per-name breakdown sums, per-hour slots for the traffic chart,
and a byte watermark of how much of the event file has been folded in. Usage,
breakdown and chart reads go to the index — **not** to the event files — so a
usage query does not parse the period's requests. Only the request list and the
detail drawer read the events, and they read backwards from the tail.

Folding is incremental and idempotent: bytes below the watermark are counted,
bytes above are not, and an unterminated line is left for the next pass rather
than counted as an event. The watermark is the whole point — deciding which file
was still open by comparing file *names* is what let the previous scheme fold
and unlink a file the writer was still appending to.

Retention deletes whole days: the event file and its index together. Never one
without the other.

The database keeps aggregates in `telemetry_usage_totals` only; do not add a
reader back onto `telemetry_events`. Payload capture stays a separate
append-only file under `data/telemetry-payloads/`.

A new usage field must pass through canonical usage, normalization, the file
writer, **the day index bucket**, console contract/store, dashboard validator,
and Usage UI. Reject invalid upstream values; do not silently clamp them.
An aggregate that must survive retention needs the schema and both baselines.
Update restore mapping when old backups do not carry the field or use a retired
representation.

Costs arrive as strings from `numeric` columns and from restored rows. Coerce
before summing: `0 + "0.000966"` concatenates instead of adding.

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
