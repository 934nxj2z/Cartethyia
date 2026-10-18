/**
 * One VS Code Copilot session, read by every surface.
 *
 * Copilot Chat 0.70.0 (VS Code 1.142.0) sends a tool call as a chat
 * `tool_calls` entry, a Messages `tool_use` block, or a Responses
 * `function_call` item, and it addresses a namespaced call by `namespace` on
 * the next turn. The same conversation must survive being parsed on one
 * surface and re-encoded on another: the call, its result, the reasoning that
 * rode with it, and the namespace all come back.
 */
import { describe, expect, test } from "bun:test";
import { chatAdapter } from "../../src/transport/surface/chat/adapter";
import { messagesAdapter } from "../../src/transport/surface/messages/adapter";
import { responsesAdapter } from "../../src/transport/surface/responses/adapter";
import { encodeWireRequest } from "../../src/protocol/registry";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";

const NAMESPACE = "mcp_server_filesystem";
const CALL_ID = "call_read_file_1";
const REASONING = "The user asked for the file, so read it.";

function toolCall(request: CanonicalRequest) {
  for (const message of request.messages) {
    for (const part of message.content) {
      if (part.kind === "toolCall") return part;
    }
  }
  return undefined;
}

describe("one VS Code tool session across surfaces", () => {
  test("a Responses function_call keeps its namespace, reasoning, and repaired arguments", async () => {
    const parsed = responsesAdapter.parse({
      model: "gpt-5",
      input: [
        {
          type: "function_call",
          call_id: CALL_ID,
          name: "read_file",
          namespace: NAMESPACE,
          arguments: '{"path":"a.ts",}',
        },
        { type: "reasoning", summary: [{ type: "summary_text", text: REASONING }] },
        { type: "function_call_output", call_id: CALL_ID, output: "contents" },
      ],
    });

    const call = toolCall(parsed);
    expect(call?.namespace).toBe(NAMESPACE);
    expect(parsed.messages.some((message) => message.content.some((part) => part.kind === "reasoning"))).toBe(true);

    const replayed = await encodeWireRequest("responses", parsed);
    const items = replayed["input"] as Array<Record<string, unknown>>;
    const replayedCall = items.find((item) => item["type"] === "function_call");
    expect(replayedCall?.["namespace"]).toBe(NAMESPACE);
    expect(JSON.parse(String(replayedCall?.["arguments"]))).toEqual({ path: "a.ts" });
    expect(items.some((item) => item["type"] === "function_call_output" && item["call_id"] === CALL_ID)).toBe(true);
  });

  test("the same call survives a hop through chat and messages", async () => {
    const parsed = responsesAdapter.parse({
      model: "gpt-5",
      input: [
        {
          type: "function_call",
          call_id: CALL_ID,
          name: "read_file",
          namespace: NAMESPACE,
          arguments: '{"path":"a.ts"}',
        },
      ],
    });

    const asChat = await encodeWireRequest("chat", parsed);
    const chatMessages = asChat["messages"] as Array<Record<string, unknown>>;
    const chatCall = (chatMessages[0]?.["tool_calls"] as Array<Record<string, unknown>>)[0];
    expect((chatCall?.["function"] as Record<string, unknown>)["namespace"]).toBe(NAMESPACE);

    const reread = chatAdapter.parse({ model: "gpt-5", messages: chatMessages });
    expect(toolCall(reread)?.namespace).toBe(NAMESPACE);

    const asMessages = await encodeWireRequest("messages", reread);
    const blocks = (asMessages["messages"] as Array<Record<string, unknown>>)[0]?.["content"] as Array<Record<string, unknown>>;
    const toolUse = blocks.find((block) => block["type"] === "tool_use");
    expect(toolUse?.["namespace"]).toBe(NAMESPACE);

    const fromMessages = messagesAdapter.parse({
      model: "claude",
      max_tokens: 1024,
      messages: asMessages["messages"],
    });
    expect(toolCall(fromMessages)?.namespace).toBe(NAMESPACE);
  });
});
