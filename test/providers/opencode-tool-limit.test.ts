/**
 * OpenCode refuses a dispatch carrying more than 128 tool definitions.
 *
 * A live agent catalog (its own tools plus two MCP servers) was rejected with
 * `400 invalid_request_error`: `Invalid value for 'tools': maximum number of
 * items is 128`. The clamp keeps a definition the conversation already called,
 * then fills the remaining slots in the original order.
 */
import { describe, expect, test } from "bun:test";
import { OPENCODE_FREE_SPEC } from "../../src/providers/integrations/opencode/provider";
import { encodeWireRequest } from "../../src/protocol/registry";
import type { CanonicalRequest, ToolDefinition } from "../../src/protocol/canonical-model";
import type { ProviderDispatchTarget } from "../../src/providers/provider-contracts";

const CANDIDATE: ProviderDispatchTarget = {
  provider_id: "opencode",
  model_id: "glm-5.3-flash",
  wire_family: "chat",
  endpoint_path: "/inference/v1/chat/completions",
  capabilities: {},
};

function tool(name: string): ToolDefinition {
  return { name, description: name, jsonSchema: { type: "object", properties: {} } };
}

function request(count: number, called: readonly string[]): CanonicalRequest {
  return {
    model: "glm-5.3-flash",
    messages: [
      {
        role: "assistant",
        content: called.map((name) => ({ kind: "toolCall", call_id: `call-${name}`, name, arguments: {} })),
      },
    ],
    tools: Array.from({ length: count }, (_, index) => tool(`tool-${index}`)),
    stream: true,
    source_surface: "chat",
    generation_controls: {},
  } as unknown as CanonicalRequest;
}

function names(payload: Record<string, unknown>): string[] {
  const tools = payload["tools"] as { function: { name: string } }[];
  return tools.map((entry) => entry.function.name);
}

describe("OpenCode tool limit", () => {
  test("keeps a called tool and trims the rest to 128", async () => {
    const source = request(200, ["tool-190"]);
    const payload = await encodeWireRequest("chat", source);
    OPENCODE_FREE_SPEC.prePayload?.(payload, source, CANDIDATE);

    const kept = names(payload);
    expect(kept).toHaveLength(128);
    expect(kept[0]).toBe("tool-190");
    expect(kept).toContain("tool-0");
    expect(kept).not.toContain("tool-191");
  });

  test("leaves a list within the limit untouched", async () => {
    const source = request(3, []);
    const payload = await encodeWireRequest("chat", source);
    OPENCODE_FREE_SPEC.prePayload?.(payload, source, CANDIDATE);

    expect(names(payload)).toEqual(["tool-0", "tool-1", "tool-2"]);
  });

  test("keeps the free-tier fingerprint tools when a large client catalog fills the wire", async () => {
    // Reproduced 2026-10-16 from a 128-tool Claude Code session routed to a
    // free model: every tool was unreferenced by the conversation, so a clamp
    // that keeps only called tools dropped all 11 fingerprint tools and the
    // gate refused the dispatch with 403 FreeTierError. The clamp must treat
    // the fingerprint set as protected.
    const fingerprints = [
      "edit", "glob", "grep", "read", "shell", "skill", "subagent",
      "webfetch", "websearch", "write", "execute",
    ];
    const foreign = Array.from({ length: 128 }, (_, index) => tool(`cc-tool-${index}`));
    const source: CanonicalRequest = {
      ...request(0, []),
      tools: [...fingerprints.map(tool), ...foreign],
    };
    const payload = await encodeWireRequest("chat", source);
    OPENCODE_FREE_SPEC.prePayload?.(payload, source, CANDIDATE);

    const kept = names(payload);
    expect(kept).toHaveLength(128);
    for (const fingerprint of fingerprints) {
      expect(kept).toContain(fingerprint);
    }
  });
});
