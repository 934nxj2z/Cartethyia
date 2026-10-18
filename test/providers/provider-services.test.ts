import { describe, expect, test } from "bun:test";
import { BUNDLED_PROVIDER_METADATA, providerServiceKinds } from "../../src/providers/provider-metadata";
import { buildCapabilityProfile } from "../../src/transport/routing/route-catalog";
import { sanitizeProviderResponse } from "../../src/console/providers/catalog/provider-operations";
import { createDefaultProviderRegistry } from "../../src/providers/default-registry";

const registry = createDefaultProviderRegistry();
describe("provider service taxonomy", () => {
  test("declares real search surfaces and keeps bundled providers explicit", () => {
    expect(providerServiceKinds("openai")).toEqual(["llm"]);
    expect(providerServiceKinds("gemini")).toEqual(["llm", "websearch", "imageGeneration"]);
    expect(providerServiceKinds("codex")).toEqual(["llm", "websearch", "imageGeneration"]);
    expect(providerServiceKinds("antigravity")).toEqual(["llm", "websearch", "imageGeneration"]);
    expect(providerServiceKinds("exa")).toEqual(["websearch"]);
    expect(providerServiceKinds("parallel")).toEqual(["websearch"]);
    // A bundled provider without a declaration serves LLM only — the
    // declaration is authoritative, so `llm` is not read as "everything".
    expect(providerServiceKinds("cbcn")).toEqual(["llm"]);
    expect(providerServiceKinds("workbuddycn")).toEqual(["llm", "imageGeneration", "videoGeneration"]);
    for (const provider of BUNDLED_PROVIDER_METADATA)
      expect(provider.serviceKinds).not.toContain("all");
  });

  test("a custom provider may serve every media surface", () => {
    // A BYOK provider has no manifest row. It is read as able to serve the
    // generation surfaces too, because the operator chose its base URL and the
    // upstream — not the gateway — is what decides whether it can answer. A
    // bundled provider is still explicit: `llm` alone means LLM only.
    expect(providerServiceKinds("custom-provider")).toEqual([
      "llm",
      "imageGeneration",
      "videoGeneration",
    ]);
  });

  test("WorkBuddy CN is wired through the provider composition root", async () => {
    const adapter = await registry.resolve("workbuddycn");
    const authentication = await registry.resolveAuthentication("workbuddycn");
    const quotaCollector = await registry.resolveQuotaCollector("workbuddycn");

    expect(adapter?.provider_id).toBe("workbuddycn");
    expect(registry.hasModelDiscovery("workbuddycn")).toBe(true);
    expect(authentication?.client).toBeDefined();
    expect(authentication?.refresher).toBeDefined();
    expect(quotaCollector).toBeDefined();
  });
  test("a chat model never advertises search", () => {
    expect(buildCapabilityProfile({
      modalities: undefined,
      reasoning: true,
      toolCall: true,
      providerId: "codex",
    }).webSearch).toBe(false);
  });

  test("sanitized custom provider responses never expose an all category", () => {
    const response = sanitizeProviderResponse({
      providerId: "custom-provider",
      enabled: true,
      isBuiltIn: false,
      requiresAccount: true,
    });
    // The kinds are derived from the taxonomy, so a custom provider reports the
    // media surfaces it may serve — never a literal "all", which would be an
    // undeclared capability.
    expect(response.serviceKinds).toEqual([
      "llm",
      "imageGeneration",
      "videoGeneration",
    ]);
    expect(response.serviceKinds).not.toContain("all");
  });
});
