/**
 * OpenCode Free rewrites the canonical request before it is encoded.
 *
 * A free-model dispatch with no tools is backfilled with the agent's full tool
 * set, and the wire body is forced to stream — the gate refuses a tool-less or
 * non-streaming free dispatch with 403 FreeTierError.
 */
import { describe, expect, test } from "bun:test";
import {
  FREE_AGENT_TOOL_NAMES,
  OPENCODE_FREE_SPEC,
} from "../../src/providers/integrations/opencode/provider";
import { OPENCODE_TOOL_DEFINITIONS } from "../../src/providers/integrations/opencode/tool-definitions";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";
import { encodeWireRequest } from "../../src/protocol/registry";
import type { ProviderDispatchTarget } from "../../src/providers/provider-contracts";

function request(model: string, temperature: number | undefined): CanonicalRequest {
  return {
    model,
    messages: [],
    stream: true,
    tools: [],
    generation_controls: temperature === undefined ? {} : { temperature },
  } as unknown as CanonicalRequest;
}

const prepare = OPENCODE_FREE_SPEC.prepareRequest!;

describe("OpenCode Free request preparation", () => {
  test("builds and forwards the default agent tools when the client sends none", async () => {
    const prepared = prepare({
      ...request("opencode/big-pickle", undefined),
      stream: false,
      tools: [],
    });
    const candidate: ProviderDispatchTarget = {
      provider_id: "opencode",
      model_id: "big-pickle",
      wire_family: "responses",
      endpoint_path: "/v1/responses",
      capabilities: {},
    };
    const payload = await encodeWireRequest("responses", prepared);
    OPENCODE_FREE_SPEC.prePayload?.(payload, prepared, candidate);

    // The gate refuses stream:false on free models, so the wire body is forced
    // to stream regardless of what the caller asked for. The client-visible
    // contract is left alone, which is why prepared.stream stays false.
    expect(payload.stream).toBe(true);
    // The full agent set, not just two: the free-tier gate reads the set, and a
    // five-tool subset still answered 403. Asserted against the source list so
    // the two cannot drift apart.
    expect(prepared.tools?.map((tool) => tool.name)).toEqual([...FREE_AGENT_TOOL_NAMES]);
    // The gate compares a recognised tool's definition, not just its name, so
    // the backfill must carry the captured description and schema rather than
    // a generic stub — a stub with the right name is refused.
    const sent = payload.tools as { type: string; name: string; description: string; parameters: unknown }[];
    expect(sent.map((tool) => tool.name)).toEqual([...FREE_AGENT_TOOL_NAMES]);
    for (const tool of sent) {
      const definition = OPENCODE_TOOL_DEFINITIONS[tool.name];
      if (definition === undefined) throw new Error(`no captured definition for ${tool.name}`);
      expect(tool.description).toBe(definition.description);
      expect(tool.parameters).toEqual(definition.parameters);
    }
    expect(payload.store).toBe(false);
  });

});
