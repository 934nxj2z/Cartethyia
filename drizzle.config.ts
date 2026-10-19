import { defineConfig } from "drizzle-kit";

/**
 * Drizzle Kit configuration — used only for `check`, never for `generate`.
 *
 * The committed SQL under `migrations/full-postgres/` is the runtime source of
 * truth and is hand-written; `generate` would rewrite it. `check` compares the
 * Drizzle schema against that baseline and fails when a schema edit has no
 * matching migration, which is the drift that silently broke deployments.
 *
 * Only the PostgreSQL baseline is checked. `migrations/lite-sqlite3/` is a
 * parallel hand-maintained set for the embedded SQLite mode, and a single
 * config cannot check two dialects at once; the Postgres one is the Full mode
 * most deployments run.
 */
export default defineConfig({
  schema: "./src/persistence/schema.ts",
  out: "./migrations/full-postgres",
  dialect: "postgresql",
});
