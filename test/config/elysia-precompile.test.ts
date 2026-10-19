import { afterEach, describe, expect, test } from "bun:test";
import { resolveElysiaPrecompile } from "../../src/config/runtime";

/**
 * Guards the source-run `NODE_ENV=production` crash.
 *
 * Precompilation takes Elysia's eager validator branch, which reads
 * `this.tb.buildResult.external` off a TypeBox compile result. On a source run
 * that field is absent, so the process dies at the first schema-bearing route
 * with `undefined is not an object (evaluating
 * 'this.tb.buildResult.external')`. Only the bundled artifact can take the
 * eager path, because `scripts/binary/aot.ts` rewrites the call site and
 * bundles the namespaces statically.
 *
 * The guard is what keeps a source-run deployment off that branch. Without it
 * every `NODE_ENV=production` deployment that runs `bun run src/main.ts` fails
 * to boot — which is the default shape of a systemd deployment.
 */
describe("Elysia precompile mode", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalSourceRun = process.env.CARTETHYIA_SOURCE_RUN;

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;

    if (originalSourceRun === undefined) delete process.env.CARTETHYIA_SOURCE_RUN;
    else process.env.CARTETHYIA_SOURCE_RUN = originalSourceRun;
  });

  test("is off in development", () => {
    process.env.NODE_ENV = "development";
    delete process.env.CARTETHYIA_SOURCE_RUN;
    expect(resolveElysiaPrecompile()).toBe(false);
  });

  test("is on for a production build", () => {
    process.env.NODE_ENV = "production";
    delete process.env.CARTETHYIA_SOURCE_RUN;
    expect(resolveElysiaPrecompile()).toBe(true);
  });

  test("is off for a production source run", () => {
    // The crash this prevents: `NODE_ENV=production` alone used to force the
    // eager branch onto a process that cannot satisfy it.
    process.env.NODE_ENV = "production";
    process.env.CARTETHYIA_SOURCE_RUN = "1";
    expect(resolveElysiaPrecompile()).toBe(false);
  });

  test("only the exact marker disables it", () => {
    // A deployment that typos the variable must not silently lose AOT on a
    // build that can take it.
    process.env.NODE_ENV = "production";
    process.env.CARTETHYIA_SOURCE_RUN = "true";
    expect(resolveElysiaPrecompile()).toBe(true);
  });
});
