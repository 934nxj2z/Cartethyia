/**
 * Wires Elysia's TypeBox bridge statically, for a source-run process.
 *
 * Elysia reaches TypeBox through a lazy `require("typebox/schema")` that
 * resolves to a partial namespace outside a bundler. The bridge supplies all
 * five namespaces explicitly so the lookup never has to happen.
 *
 * This is necessary but **not sufficient** for `NODE_ENV=production`: it does
 * not stop the eager validator branch from reading
 * `this.tb.buildResult.external`, which is still absent on a source run. That
 * half is owned by `resolveElysiaPrecompile()`, which turns precompilation off
 * for a source run. Keep both — wiring the bridge without the precompile guard
 * still crashes, and the guard without the bridge leaves the lazy require in
 * place for anything else that needs it.
 *
 * Keep this import first in `main.ts` so it runs before any module builds a
 * route.
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
