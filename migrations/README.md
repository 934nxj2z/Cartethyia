# Database baselines

Cartethyia keeps one SQL baseline per database backend:

- `full-postgres/0000_baseline.sql` defines the foundational PostgreSQL schema
  for a new database.
- `lite-sqlite3/0000_baseline.sql` is generated from the PostgreSQL baseline by
  `scripts/generate/sqlite-ddl.ts`; do not edit it by hand.

The startup runner applies the baseline and numbered forward migrations,
recording them in `cartethyia_schema_migrations` along with a hash marker for
the exact baseline contents. Released baselines are immutable so existing
installations keep matching their marker; numbered migrations bring that
foundational schema up to the current schema. Each backend's migrations must
have matching behavior. Startup fails with a recovery instruction for a
database with unsupported retired migration history instead of treating it as
current.

## Recovering an existing installation

1. Export a backup from the existing installation before switching it to a
   release with unsupported migration history.
2. Create a fresh database and point the application at it.
3. Start the application so it creates the baseline schema.
4. Restore the backup through the console restore flow.

Restore normalizes legacy values that no longer satisfy current constraints,
including `bypass_proxy` → `skip_proxy`, `bridge` → `https`, the retired
provider User-Agent default, Cline's skip-proxy default, and `fusion` →
`fallback`. Unknown or retired columns are reported and skipped according to
the backup contract.

Do not point tests or recovery steps at development or production databases.
The startup path runs `ensureMigrated()` before provider/catalog seeding. Full
mode uses `src/persistence/db-pg.ts` and an advisory lock; Lite uses
`src/persistence/db-sqlite.ts`. Readiness compares the ledger to the available baseline and forward migration
files. A failed migration aborts startup and is not recorded.

Migrations are package assets, not resolved from the process working directory:
`src/config/package-paths.ts` resolves them from the package root. `package.json`
includes `migrations/` in the published files, and the Dockerfile copies the
migration directories into `/app/migrations`.

## Next schema change

1. Update `src/persistence/schema.ts` and add matching numbered migrations to
   both backends. Preserve released baseline files so existing baseline markers
   remain valid.
2. Update backup validation/mapping when old exported rows need normalization
   or new required values.
3. Run focused migration, restore, and typecheck tests. Validate against an
   isolated database only.
