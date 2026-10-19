/**
 * Every model a CLI tool's registry advertises must actually be routable.
 *
 * The failure this guards is silent: `TOOL_REGISTRY` drives the setup wizard
 * and the per-tool settings files, so a `defaultModels` entry naming a model id
 * that no bundled provider serves is written into a client's config verbatim.
 * The client then sends a request the gateway cannot route, and the operator
 * sees a model-resolution failure for a model the console itself recommended.
 *
 * `opencode`, `droid`, `copilot` and `qwen` all shipped `gpt-5.1` this way. It
 * was not a typo that failed loudly: `gpt-5.1` exists in the upstream
 * models.dev *metadata* catalog, so a metadata lookup finds it — but no bundled
 * provider roster contains it, so nothing can serve it. The real id is
 * `gpt-5.6-sol`.
 *
 * The assertion therefore checks routability (a bundled provider roster), not
 * metadata presence, because metadata presence is exactly what made the bug
 * invisible.
 *
 * An id may also be qualified as `provider/model`. Those are deliberately NOT
 * asserted here: `grok/grok-4` and `deepseek/deepseek-chat|deepseek-reasoner`
 * are also absent from the bundled rosters (which serve `grok-4.7` and
 * `deepseek-v4-pro`), but whether a qualified id is meant to name a routable
 * model or a client-side preference is a product decision, not a mechanical
 * one. Fixing them here would have meant guessing.
 */
import { describe, expect, test } from "bun:test";
import { TOOL_REGISTRY } from "../../src/console/cli-tools/contracts";
import { PROVIDER_CAPABILITIES } from "../../src/providers/default-registry";

/** Every model id any bundled provider can serve, and the provider set. */
async function routableIds(): Promise<{ ids: Set<string>; providers: Set<string> }> {
  const ids = new Set<string>();
  const providers = new Set<string>();
  for (const [providerId, capabilities] of Object.entries(PROVIDER_CAPABILITIES)) {
    const loadModels = (capabilities as { loadModels?: () => Promise<readonly { modelId?: string }[]> })
      .loadModels;
    if (loadModels === undefined) continue;
    providers.add(providerId);
    for (const model of await loadModels()) {
      if (typeof model.modelId === "string") ids.add(model.modelId);
    }
  }
  return { ids, providers };
}

/** Gateway-level model families the router resolves (`route-catalog.ts`). */
const CLAUDE_MODEL_FAMILIES = new Set(["opus", "sonnet", "haiku", "fable", "mythos"]);

describe("CLI tool registry model ids", () => {
  test("every unqualified defaultModels id is routable", async () => {
    const { ids } = await routableIds();
    // Guard the guard: an empty roster would make every assertion pass
    // vacuously.
    expect(ids.size).toBeGreaterThan(0);

    const unresolvable: string[] = [];
    for (const [toolId, tool] of Object.entries(TOOL_REGISTRY)) {
      for (const model of tool.defaultModels) {
        // Provider-qualified ids are a separate, pre-existing question (see
        // the note below) — this test covers the unqualified shape that
        // `gpt-5.1` shipped as.
        if (model.id.includes("/")) continue;
        if (CLAUDE_MODEL_FAMILIES.has(model.id)) continue;
        if (!ids.has(model.id)) unresolvable.push(`${toolId}: ${model.id}`);
      }
    }
    // Names the offending tool and id so the failure is actionable.
    expect(unresolvable).toEqual([]);
  });

  test("a phantom id would be caught", async () => {
    // A guard that cannot fail is not a guard. `gpt-5.1` is the exact id that
    // shipped and is present in the models.dev *metadata* catalog, so this
    // proves the check tests routability rather than metadata presence.
    const { ids } = await routableIds();
    expect(ids.has("gpt-5.1")).toBe(false);
    expect(ids.has("gpt-5.6-sol")).toBe(true);
  });
});
