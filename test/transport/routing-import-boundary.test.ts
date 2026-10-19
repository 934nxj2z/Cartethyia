/**
 * The routing layer must not pull provider integrations in eagerly.
 *
 * `route-catalog.ts` builds the route snapshot on every catalog change. It used
 * to open with two bare side-effect imports of the Claude and Codex OAuth
 * clients, with no comment saying why — and neither module has any side effect
 * to install. The only cost was pulling both OAuth client graphs, and their
 * transitive imports, into every snapshot rebuild regardless of configuration.
 *
 * Those clients are loaded on demand by `default-registry.ts` through
 * `oauthCapability(() => import(...))`, so removing the imports changes
 * nothing except the boot cost.
 *
 * This is a grep-shaped guard, mirroring
 * `test/providers/generic-provider-completeness.test.ts`: it pins the layering
 * rule so a future "it works if I import it here" fix cannot quietly
 * reintroduce the eager edge.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const PROJECT_ROOT = resolve(import.meta.dir, "..", "..");
const ROUTING_DIR = join(PROJECT_ROOT, "src", "transport", "routing");

/** Every `.ts` file under `src/transport/routing`, recursively. */
function routingFiles(dir: string = ROUTING_DIR): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...routingFiles(full));
      continue;
    }
    if (entry.endsWith(".ts")) found.push(full);
  }
  return found;
}

/** True for a static import of a provider integration that exists only for side effects. */
function importsIntegrations(source: string): boolean {
  const patterns = [
    // A bare side-effect import: `import ".../providers/integrations/..."`.
    // This is the exact shape that was removed, and the shape that pulls an
    // entire client graph in for a registration nobody asked for.
    /^\s*import\s+["'][^"']*providers\/integrations\/[^"']*["']/m,
    // Any import of an OAuth client module, named or not. Those graphs are
    // reached through `default-registry.ts`'s `oauthCapability(() => import(…))`
    // and must stay lazy.
    /^\s*import\s[^;]*?from\s+["'][^"']*providers\/integrations\/[^"']*oauth[^"']*["']/m,
    /^\s*export\s[^;]*?from\s+["'][^"']*providers\/integrations\/[^"']*oauth[^"']*["']/m,
  ];
  return patterns.some((pattern) => pattern.test(source));
}

describe("routing layer import boundaries", () => {
  test("no routing module statically imports a provider integration", () => {
    const offenders: string[] = [];
    for (const file of routingFiles()) {
      const source = readFileSync(file, "utf8");
      if (importsIntegrations(source)) offenders.push(relative(PROJECT_ROOT, file));
    }
    // The message names the file so the failure is actionable rather than a
    // bare "expected [] to equal [...]".
    expect(offenders).toEqual([]);
  });

  test("the guard actually detects the shape it exists to catch", () => {
    // A guard that cannot fail is not a guard: these are the two shapes that
    // were removed, plus the forms it must allow.
    expect(importsIntegrations(`import "../../providers/integrations/claude/claude-oauth";`)).toBe(true);
    expect(
      importsIntegrations(`import { claudeOAuthClient } from "../../providers/integrations/claude/claude-oauth";`),
    ).toBe(true);
    expect(
      importsIntegrations(`import type { X } from "../../providers/integrations/codex/codex-oauth";`),
    ).toBe(true);
    // A named import of a non-OAuth integration helper is a real dependency,
    // not a side effect — `router.ts` legitimately uses the slow-lane registry.
    expect(
      importsIntegrations(`import { sharedClaudeSlowLanes } from "../../providers/integrations/claude/claude-slow-lane";`),
    ).toBe(false);
    // Dynamic imports are the sanctioned lazy path and must not trip the guard.
    expect(importsIntegrations(`const m = await import("../../providers/integrations/claude/claude-oauth");`)).toBe(
      false,
    );
    expect(importsIntegrations(`import { eq } from "drizzle-orm";`)).toBe(false);
  });
});
