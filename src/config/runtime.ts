/**
 * HTTP listener, dashboard runtime, and graceful-shutdown drain resolvers.
 */

import { CONFIG_SPEC, readInt, readOptionalText, readText } from "./spec";
import { resolvePackagePath } from "./package-paths";

/** Resolves the HTTP listener port from the process environment. */
export function resolvePort(): number {
  return readInt("PORT", CONFIG_SPEC.PORT);
}

/** Resolves the dashboard static asset directory. */
export function resolveDashboardDist(): string {
  if (!process.env.DASHBOARD_DIST?.trim()) return resolvePackagePath("dist", "dashboard");
  return readText("DASHBOARD_DIST", CONFIG_SPEC.DASHBOARD_DIST);
}

/**
 * Resolves the configured default gateway API key (`CARTETHYIA_API_KEY`), if
 * one is set. Consumers that need the raw secret — first-boot seeding and the
 * console's legacy-key recovery — read it here instead of probing
 * `process.env` directly.
 */
export function resolveDefaultGatewayApiKey(): string | undefined {
  return readOptionalText("CARTETHYIA_API_KEY", CONFIG_SPEC.CARTETHYIA_API_KEY);
}

/** Resolves the request-body ceiling shared by the Bun listener and ingress middleware. */
export function resolveMaxBodyBytes(): number {
  return readInt("CARTETHYIA_SERVER_MAX_BODY_BYTES", CONFIG_SPEC.CARTETHYIA_SERVER_MAX_BODY_BYTES);
}

/** Resolves the listener idle-socket timeout (seconds). */
export function resolveIdleTimeout(): number {
  return readInt("CARTETHYIA_SERVER_IDLE_TIMEOUT", CONFIG_SPEC.CARTETHYIA_SERVER_IDLE_TIMEOUT);
}

/** Resolves the graceful-shutdown drain window: time for in-flight requests to finish before abort. */
export function resolveShutdownDrainWindowMs(): number {
  return readInt(
    "CARTETHYIA_SHUTDOWN_DRAIN_WINDOW_MS",
    CONFIG_SPEC.CARTETHYIA_SHUTDOWN_DRAIN_WINDOW_MS,
  );
}

/** Resolves the operator drain token, or `undefined` when the drain route is disabled. */
export function resolveDrainToken(): string | undefined {
  const raw = process.env.CARTETHYIA_DRAIN_TOKEN?.trim();
  return raw !== undefined && raw.length > 0 ? raw : undefined;
}

/**
 * Whether Elysia precompiles route handlers at startup (AOT).
 *
 * Precompilation takes the eager validator branch, which calls TypeBox's
 * `SchemaCompile(schema)` and then reads `.buildResult.external` off the
 * result. In a source-run process that field is absent — the lazy
 * `require("typebox/schema")` resolves to a namespace that does not carry it —
 * and the process dies at the first schema-bearing route with
 * `undefined is not an object (evaluating 'this.tb.buildResult.external')`.
 * `scripts/binary/aot.ts` avoids this by rewriting the call site and bundling
 * the namespaces statically, so only the built artifact can actually take the
 * eager path.
 *
 * So: precompilation is on for production *builds*, and off for a source run
 * even when `NODE_ENV=production`. A deployment that runs
 * `bun run src/main.ts` must not be pushed onto the eager branch.
 *
 * `CARTETHYIA_SOURCE_RUN` marks a source run explicitly. It is set by
 * `scripts/deploy/*.sh`, which are the only supported way to run from source.
 */
export function resolveElysiaPrecompile(): boolean {
  if (process.env.CARTETHYIA_SOURCE_RUN === "1") return false;
  return process.env.NODE_ENV === "production";
}
