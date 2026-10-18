import { describe, expect, test } from "bun:test";
import type {
  ProviderDispatchContext,
  ProviderDispatchTarget,
} from "../../src/providers/provider-contracts";
import { githubAdapter } from "../../src/providers/integrations/github/github";

import type { CanonicalRequest } from "../../src/protocol/canonical-model";

const candidate = {
  provider_id: "github",
  model_id: "gpt-4.1",
  wire_family: "chat",
  endpoint_path: "/chat/completions",
  capabilities: {},
} as unknown as ProviderDispatchTarget;

const baseRequest = {
  model: "gpt-4.1",
  messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
  generation_controls: {},
  stream: false,
} as unknown as CanonicalRequest;

interface CapturedRequest {
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

async function capture(request: CanonicalRequest, credential = "account-a"): Promise<CapturedRequest> {
  let captured: CapturedRequest | undefined;
  const outboundFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    captured = {
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    };
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    }), { headers: { "content-type": "application/json" } });
  }) as unknown as ProviderDispatchContext["outbound_fetch"];
  const stream = githubAdapter.dispatch(request, candidate, {
    credential: {
      provider_id: "github",
      credential_kind: "oauth",
      secret: new TextEncoder().encode(JSON.stringify({
        access: "copilot-access",
        apiHost: "copilot.example",
        github: credential,
      })),
    },
    deadline: Date.now() + 30_000,
    abort_signal: new AbortController().signal,
    outbound_fetch: outboundFetch,
    request_id: "gateway-request-123",
  } as unknown as ProviderDispatchContext);
  try {
    for await (const _event of stream) void _event;
  } catch {
    // The captured outbound request is the assertion; response decoding is irrelevant here.
  }
  expect(captured).toBeDefined();
  return captured!;
}

describe("GitHub Copilot request context", () => {
  test("adds initiator, image, and stable correlation headers only to inference requests", async () => {
    const userRequest = await capture(baseRequest);
    expect(userRequest.headers.get("x-github-api-version")).toBe("2026-08-01");
    expect(userRequest.headers.get("editor-version")).toBe("vscode/1.142.0");
    expect(userRequest.headers.get("editor-plugin-version")).toBe("copilot-chat/0.70.0");
    expect(userRequest.headers.get("editor-device-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(userRequest.headers.get("x-initiator")).toBe("user");
    expect(userRequest.headers.get("copilot-vision-request")).toBeNull();
    expect(userRequest.headers.get("x-request-id")).toBe("gateway-request-123");
    expect(userRequest.headers.get("x-agent-task-id")).toBe("gateway-request-123");
    expect(userRequest.headers.get("openai-intent")).toBe("conversation-agent");
    expect(userRequest.headers.get("x-interaction-type")).toBe("conversation-agent");

    const agentRequest = await capture({
      ...baseRequest,
      messages: [{ role: "assistant", content: [{ kind: "text", text: "continuing" }] }],
    } as unknown as CanonicalRequest);
    expect(agentRequest.headers.get("x-initiator")).toBe("agent");

    const toolResultRequest = await capture({
      ...baseRequest,
      messages: [{
        role: "user",
        content: [{
          kind: "toolResult",
          call_id: "call-1",
          content: [{ kind: "image", payload: { data: "tool-image" } }],
        }],
      }],
    } as unknown as CanonicalRequest);
    expect(toolResultRequest.headers.get("x-initiator")).toBe("agent");
    expect(toolResultRequest.headers.get("copilot-vision-request")).toBe("true");

    const imageRequest = await capture({
      ...baseRequest,
      messages: [{
        role: "user",
        content: [{ kind: "image", payload: { data: "image-data" } }],
      }],
    } as unknown as CanonicalRequest);
    expect(imageRequest.headers.get("copilot-vision-request")).toBe("true");
    expect(agentRequest.headers.get("editor-device-id")).toBe(
      userRequest.headers.get("editor-device-id"),
    );
  });

  test("does not invent a context tier on the chat body", async () => {
    const captured = await capture(baseRequest);
    expect(captured.body.contextTier).toBeUndefined();
  });

  test("caps a reasoning effort above high at high", async () => {
    for (const effort of ["max", "xhigh"]) {
      const captured = await capture({
        ...baseRequest,
        reasoning: { effort },
      } as unknown as CanonicalRequest);
      expect(captured.body.reasoning_effort).toBe("high");
    }
    const kept = await capture({
      ...baseRequest,
      reasoning: { effort: "medium" },
    } as unknown as CanonicalRequest);
    expect(kept.body.reasoning_effort).toBe("medium");
  });
});
