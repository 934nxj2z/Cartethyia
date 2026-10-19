/**
 * Wires Elysia's TypeBox bridge statically, for a source-run process.
 *
 * Elysia's compiled-route path reaches TypeBox through
 * `import.meta.require("typebox/value")`. That works when `NODE_ENV` is not
 * `production`, because the validator defers compilation and never takes the
 * synchronous-loader branch. Under `NODE_ENV=production` it compiles eagerly,
 * the lazy require resolves to a partial namespace, and the process dies at
 * the first route with:
 *
 *   TypeError: undefined is not an object (evaluating 'this.tb.buildResult.external')
 *
 * The bundled binary does not hit this because `scripts/binary/aot.ts` patches
 * Elysia's `SchemaCompile(this.schema)` call and bundles the namespaces
 * statically. A server running `bun run src/main.ts` has neither, so it needs
 * the same wiring done explicitly — which is what `setupTypebox` is for.
 *
 * Verified: without this, `NODE_ENV=production` fails at boot; with it, the
 * gateway serves 200 on /health. Keep this import first in `main.ts` so it runs
 * before any module builds a route.
 */
import { setupTypebox } from "elysia";
import * as typeboxType from "typebox";
import * as typeboxCompile from "typebox/compile";
import * as typeboxSchema from "typebox/schema";
import * as typeboxSystem from "typebox/system";
import * as typeboxValue from "typebox/value";

setupTypebox({
  typebox: {
    // The type side (`type` + `system`) and the value side (`value` + `schema`
    // + `compile`) must both be complete; Elysia rejects a partial set because
    // a half-wired bridge fails later with a less obvious error.
    type: typeboxType,
    system: typeboxSystem,
    value: typeboxValue,
    schema: typeboxSchema,
    compile: typeboxCompile,
  },
});
