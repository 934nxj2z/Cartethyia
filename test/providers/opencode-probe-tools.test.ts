/**
 * A backfilled free-tier tool must carry a non-empty parameter schema.
 *
 * The free-tier gate reads the tool set, and an empty `properties` object is
 * not agent-shaped: an otherwise-correct dispatch carrying eleven such tools
 * returned 403 `FreeTierError`, while the same dispatch with one declared
 * property returned 200 (verified live 2026-10-15). The probe builds a
 * tool-less request, so every tool it sends is backfilled — which is why the
 * probe failed while a replay of a real client's tools did not.
 */
import { describe, expect, test } from "bun:test";
import { OPENCODE_FREE_SPEC } from "../../src/providers/integrations/opencode/provider";
import { encodeWireRequest } from "../../src/protocol/registry";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";
import type { ProviderDispatchTarget } from "../../src/providers/provider-contracts";

function probeRequest(): CanonicalRequest {
  return {
    model: "big-pickle",
    messages: [{ role: "user", content: [{ kind: "text", text: "Reply with exactly: PONG" }] }],
    stream: true,
    source_surface: "chat",
    generation_controls: {},
  } as unknown as CanonicalRequest;
}

describe("OpenCode free probe — backfilled tools are agent-shaped", () => {
  test("every backfilled tool declares at least one property", async () => {
    const request = OPENCODE_FREE_SPEC.prepareRequest?.(probeRequest()) ?? probeRequest();
    const payload = await encodeWireRequest("chat", request);
    const candidate: ProviderDispatchTarget = {
      provider_id: "opencode",
      model_id: "big-pickle",
      wire_family: "chat",
      endpoint_path: "/inference/v1/chat/completions",
      capabilities: {},
    };
    OPENCODE_FREE_SPEC.prePayload?.(payload, request, candidate);

    // Responses puts `parameters` on the tool; chat nests it under `function`.
    const tools = payload.tools as {
      parameters?: { properties: Record<string, unknown> };
      function?: { parameters?: { properties: Record<string, unknown> } };
    }[];
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      const parameters = tool.parameters ?? tool.function?.parameters;
      expect(Object.keys(parameters?.properties ?? {}).length).toBeGreaterThan(0);
    }
  });
});
