/**
 * The dialect helpers produce SQL the backend they target can actually run.
 *
 * Each helper is exercised twice: once with the mode forced to lite, against
 * a real SQLite database, and once with it forced to full, where the rendered
 * SQL is checked for the PostgreSQL spelling. The PostgreSQL spelling is not
 * executed here — the suite that runs against PostgreSQL does that. What this
 * pins is that the branch is real: a helper that returned the same SQL for
 * both modes would fail one of the two.
 */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
  caseInsensitiveLike,
  currentTimestamp,
  differsFrom,
  laterOf,
  mergeJson,
  pruneExpiredCooldowns,
  sqliteDialect,
} from "../../src/persistence/dialect";

function render(query: ReturnType<typeof sql>): string {
  const chunks = (query as unknown as { queryChunks: { value?: string[] }[] }).queryChunks;
  return chunks.flatMap((chunk) => chunk.value ?? []).join("?");
}

/**
 * Forces the mode for one test and puts the previous value back.
 *
 * Both tests below used to end by *deleting* `CARTETHYIA_DB_MODE`. The runner
 * shares one process across files, so that deleted a mode the process was
 * actually configured with: every later file in the same worker that read it —
 * `sqlite-boot.test.ts` among them — failed with "CARTETHYIA_DB_MODE is
 * required" depending only on which files that worker happened to run first.
 */
function withMode<T>(mode: "lite" | "full", body: () => T): T {
  const previous = process.env.CARTETHYIA_DB_MODE;
  process.env.CARTETHYIA_DB_MODE = mode;
  try {
    return body();
  } finally {
    if (previous === undefined) delete process.env.CARTETHYIA_DB_MODE;
    else process.env.CARTETHYIA_DB_MODE = previous;
  }
}

test("lite mode renders SQLite spellings and they execute", () => {
  withMode("lite", () => {
    expect(sqliteDialect()).toBe(true);

    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (prefs text, cooldowns text, name text, at text, blob blob)");
    db.exec("INSERT INTO t VALUES ('{\"a\":1}', '{\"m\":\"2000-01-01T00:00:00.000Z\",\"n\":\"2099-01-01T00:00:00.000Z\"}', 'Alice', '2020-01-01T00:00:00.000Z', x'abcd')");

    const merged = render(mergeJson(sql`prefs`, sql`'{"b":2}'`));
    expect(merged).toContain("json_patch");
    expect(merged).not.toContain("::jsonb");
    db.exec(`UPDATE t SET prefs = json_patch(prefs, '{"b":2}')`);

    const pruning = pruneExpiredCooldowns(sql`cooldowns`, sql`'2026-01-01T00:00:00.000Z'`);
    expect(render(pruning.value)).toContain("json_each");
    expect(render(pruning.value)).not.toContain("jsonb_");
    const now = "2026-01-01T00:00:00.000Z";
    db.exec(
      `UPDATE t SET cooldowns = COALESCE((SELECT json_group_object(key, value) FROM json_each(cooldowns) WHERE value > '${now}'), '{}') ` +
        `WHERE json_valid(cooldowns) AND json_type(cooldowns) = 'object'`,
    );

    const like = render(caseInsensitiveLike(sql`name`, sql`'%ali%'`));
    expect(like).toContain("lower(");
    expect(like).not.toContain("ilike");

    expect(render(laterOf(sql`at`, sql`at`))).toContain("max(");
    expect(render(currentTimestamp())).toContain("strftime");
    expect(render(differsFrom(sql`name`, sql`name`))).toContain("IS NOT");
    expect(render(differsFrom(sql`name`, sql`name`))).not.toContain("DISTINCT");

    const row = db.prepare("SELECT prefs, cooldowns FROM t").get() as { prefs: string; cooldowns: string };
    expect(JSON.parse(row.prefs)).toEqual({ a: 1, b: 2 });
    expect(JSON.parse(row.cooldowns)).toEqual({ n: "2099-01-01T00:00:00.000Z" });
    db.close();
  });
});

test("full mode renders PostgreSQL spellings", () => {
  withMode("full", () => {
    expect(sqliteDialect()).toBe(false);

    expect(render(mergeJson(sql`prefs`, sql`'{}'`))).toContain("::jsonb");
    expect(render(pruneExpiredCooldowns(sql`c`, sql`'x'`).value)).toContain("jsonb_each_text");
    expect(render(caseInsensitiveLike(sql`name`, sql`'%a%'`))).toContain("ilike");
    expect(render(laterOf(sql`a`, sql`b`))).toContain("greatest");
    expect(render(currentTimestamp())).toBe("now()");
    expect(render(differsFrom(sql`a`, sql`b`))).toContain("IS DISTINCT FROM");
  });
});

/**
 * The handle path, which is the one a compiled binary takes.
 *
 * `mergeJson(column, patch, database)` derives the backend from the connection
 * rather than the environment, and it used to do that with
 * `dialect.constructor.name.startsWith("SQLite")`. A minified build renames
 * that class, so the check answered `false` for a real SQLite handle and the
 * compiled binary emitted `::jsonb` into SQLite — dying at boot in
 * `provider-seed` with `unrecognized token: ":"` while `bun run src/main.ts`
 * worked. The env-forced tests above never exercise this branch, and the mode
 * is forced to `full` here so an env-based check cannot pass by accident.
 *
 * The dialect's constructor is replaced with one named `m`, which is what
 * minification does. Detection that reads the *name* fails this; detection
 * that reads the prototype does not.
 */
test("a SQLite handle selects the SQLite spelling even when its dialect class is renamed", () => {
  withMode("full", () => {
    const sqlite = new Database(":memory:");
    // `dialect` and `session` are runtime properties Drizzle's public type does
    // not surface; this test is about what a real handle carries at runtime.
    const handle = drizzle(sqlite) as unknown as { dialect: object; session: object };
    const renamed = Object.create(Object.getPrototypeOf(handle.dialect)) as {
      constructor: unknown;
    };
    Object.defineProperty(renamed, "constructor", { value: { name: "m" } });
    const minified = { dialect: renamed, session: handle.session };

    expect(render(mergeJson(sql`prefs`, sql`'{"b":2}'`, minified))).toContain("json_patch");
    expect(render(mergeJson(sql`prefs`, sql`'{"b":2}'`, handle))).toContain("json_patch");
    sqlite.close();
  });
});
