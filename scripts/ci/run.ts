/**
 * The single entry point for every test invocation.
 *
 * A bare `bun test` is not enough for this suite, and the reasons are worth
 * stating so the flags are not "helpfully" removed later:
 *
 * - The local `.env` is shared with the test subprocesses. Database suites
 *   only run when `CARTETHYIA_TEST_DATABASE_URL` points to a disposable
 *   database; when present, the runner routes `DATABASE_URL` there and selects
 *   Full mode so tests cannot accidentally write to the runtime database.
 * - **`--timeout` is a hang detector, not a budget.** 15 s is far longer than
 *   any legitimate test in this suite; it exists so a deadlocked test fails
 *   with a name instead of stalling CI. A test that needs to wait is written
 *   against `helpers/clock.ts` instead of sleeping.
 * - **`--parallel` is default.** Files are isolated per worker, so the database
 *   suites must scope their rows — which `helpers/fixtures.ts` does by
 *   construction. Serializing the run instead would hide a leak that the
 *   parallel run catches.
 *
 * `--scope` picks a tree: `backend` (`test/`), `dashboard` (`dashboard/test/`),
 * or `all`. `--watch` re-runs on change. Anything else is forwarded to
 * `bun test`, so `bun run test -- --test-name-pattern admission` works.
 *
 * The scope is passed as an explicit PATH rather than as the working directory,
 * because running `bun test` from the repo root discovers `dashboard/test/`
 * too — `dashboard` is not excluded from root discovery, so the "backend" scope
 * was silently running the dashboard suites a second time. The paths below are
 * the single definition of what each scope covers.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_ROOT = join(import.meta.dir, "..", "..");
const DASHBOARD_ROOT = join(PROJECT_ROOT, "dashboard");
const BACKEND_TESTS = join(PROJECT_ROOT, "test");
const DASHBOARD_TESTS = join(DASHBOARD_ROOT, "test");
const SCRIPTS_TESTS = join(PROJECT_ROOT, "test", "cli");

const rawArgs = process.argv.slice(2);

/**
 * Reads a dotenv file into the test environment. Explicit shell variables win.
 */
function loadEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key) values[key] = value;
  }
  return values;
}

const scopeIndex = rawArgs.indexOf("--scope");
const scope = scopeIndex >= 0 ? rawArgs[scopeIndex + 1] : "all";
if (scope !== "all" && scope !== "backend" && scope !== "dashboard" && scope !== "scripts") {
  console.error(`[test] unknown --scope "${scope}"; expected backend, dashboard, scripts, or all`);
  process.exit(1);
}

const passthrough = rawArgs.filter((_arg, index) => {
  // Drop the `--scope <value>` pair; everything else is forwarded to `bun test`.
  if (scopeIndex < 0) return true;
  return index !== scopeIndex && index !== scopeIndex + 1;
});
const watch = passthrough.includes("--watch");
const testArgs = passthrough.filter((arg) => arg !== "--watch");

const sharedEnv = {
  ...loadEnvFile(join(PROJECT_ROOT, ".env")),
  ...process.env,
};

/**
 * Trusts the loopback TLS fixture without touching a production path.
 *
 * `test/network/outbound-http2.test.ts` stands up a real self-signed HTTP/2
 * server, and the binding it exercises pins `rejectUnauthorized: true` — which
 * is correct and must not be weakened to accommodate a fixture. The supported
 * way to trust a private CA is `NODE_EXTRA_CA_CERTS`, and it is read when the
 * TLS root store is first built, so it has to be set on the subprocess rather
 * than inside the test file (by then the store is already built).
 *
 * Two traps make this a merge and not an assignment:
 *
 * - Node replaces the extra-CA list rather than appending, so pointing the
 *   variable at the fixture alone would silently untrust whatever the machine
 *   already relied on — this workstation, for instance, carries a corporate
 *   MITM root there.
 * - A `ca` option on the socket would mean editing the production dial to
 *   accept a per-caller override, which is the weakening this avoids.
 *
 * PEM bundles concatenate, so the existing file's contents are prefixed with
 * the fixture and written to one temp file per run.
 */
function mergedExtraCaCerts(): Record<string, string> {
  const fixture = join(PROJECT_ROOT, "test", "fixtures", "localhost-cert.pem");
  if (!existsSync(fixture)) return {};
  const existing = sharedEnv.NODE_EXTRA_CA_CERTS?.trim();
  const parts = [readFileSync(fixture, "utf8")];
  if (existing && existsSync(existing)) parts.push(readFileSync(existing, "utf8"));
  const bundle = join(tmpdir(), `cartethyia-extra-ca-${process.pid}.pem`);
  writeFileSync(bundle, parts.join("\n"));
  return { NODE_EXTRA_CA_CERTS: bundle };
}

const testDatabaseUrl = sharedEnv.CARTETHYIA_TEST_DATABASE_URL?.trim();
if (testDatabaseUrl) {
  sharedEnv.CARTETHYIA_DB_MODE = "full";
  sharedEnv.DATABASE_URL = testDatabaseUrl;
} else if (scope === "all" || scope === "backend") {
  console.error(
    "[test] set CARTETHYIA_TEST_DATABASE_URL in the local .env or shell before running backend tests; " +
      "the development DATABASE_URL is never used as a test fallback",
  );
  process.exit(1);
}

/**
 * One `bun test` invocation.
 *
 * `paths` are the explicit test roots for the scope. They are what keeps the
 * scopes disjoint; see the header comment. `cwd` still matters because each tree
 * has its own `tsconfig.json` and dependency resolution (the dashboard has its
 * own `package.json`).
 */
function runTests(cwd: string, label: string, paths: readonly string[]): Promise<number> {
  const proc = Bun.spawn(
    [
      "bun",
      "test",
      ...(watch ? ["--watch"] : []),
      "--timeout",
      "15000",
      "--parallel",
      ...paths,
      ...testArgs,
    ],
    {
      cwd,
      env: { ...sharedEnv, ...mergedExtraCaCerts() },
      stdio: ["inherit", "inherit", "inherit"],
    },
  );
  return proc.exited.then((code) => {
    if (code !== 0) console.error(`[test] ${label} failed with exit code ${code}`);
    return code;
  });
}

let exitCode = 0;
if (scope === "all" || scope === "backend") {
  exitCode = await runTests(PROJECT_ROOT, "backend", [BACKEND_TESTS]);
}
if (exitCode === 0 && (scope === "all" || scope === "dashboard")) {
  exitCode = await runTests(DASHBOARD_ROOT, "dashboard", [DASHBOARD_TESTS]);
}
if (exitCode === 0 && (scope === "all" || scope === "scripts")) {
  exitCode = await runTests(PROJECT_ROOT, "scripts", [SCRIPTS_TESTS]);
}
process.exit(exitCode);
