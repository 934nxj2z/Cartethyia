/**
 * Factory Gemini wire (#5).
 *
 * The bug this pins: Gemini ids were catalogued as `chat`, so their requests
 * were posted to Factory's OpenAI chat endpoint, which does not serve them.
 * The donor settles the real shape — `/api/llm/g/v1/generate` with
 * `x-api-provider: google` and a native generateContent body.
 */
import { describe, expect, test } from "bun:test";
import { factoryAdapter } from "../../src/providers/integrations/factory/factory";
import { FACTORY_GEMINI_ENDPOINT_PATH } from "../../src/providers/integrations/factory/factory-models";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";
import type {
  ProviderDispatchContext,
  ProviderDispatchTarget,
} from "../../src/providers/provider-contracts";
import { encodeFactoryDroidCredential } from "../../src/security/credential-codec";

const TARGET: ProviderDispatchTarget = {
  provider_id: "factory",
  model_id: "gemini-3.7-flash",
  wire_family: "gemini",
  endpoint_path: FACTORY_GEMINI_ENDPOINT_PATH,
  capabilities: {},
} as unknown as ProviderDispatchTarget;

function request(): CanonicalRequest {
  return {
    model: "gemini-3.7-flash",
    messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
    generation_controls: {},
    stream: false,
    source_surface: "chat_completions",
  } as unknown as CanonicalRequest;
}

interface Capture {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

async function capture(
  respond: () => Response,
): Promise<Capture> {
  let seen: Capture | undefined;
  const fetcher = (async (url: unknown, init?: RequestInit): Promise<Response> => {
    seen = {
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    };
    return respond();
  }) as unknown as typeof fetch;

  const secret = encodeFactoryDroidCredential({
    accessToken: "tok",
    orgId: "org-1",
  } as never);
  const context = {
    outbound_fetch: fetcher,
    deadline: Date.now() + 60_000,
    abort_signal: new AbortController().signal,
    credential: {
      credential_id: "c1",
      provider_id: "factory",
      credential_kind: "oauth",
      secret,
    },
    user_agent: "test",
  } as unknown as ProviderDispatchContext;

  for await (const _event of factoryAdapter.dispatch(request(), TARGET, context)) {
    void _event;
  }
  if (seen === undefined) throw new Error("no request captured");
  return seen;
}

function generateOk(): Response {
  return new Response(
    JSON.stringify({
      candidates: [
        {
          content: { role: "model", parts: [{ text: "hello" }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("Factory Gemini wire", () => {
  test("posts to the generate endpoint, not the chat endpoint", async () => {
    const seen = await capture(generateOk);
    expect(seen.url).toContain("/api/llm/g/v1/generate");
    expect(seen.url).not.toContain("/chat/completions");
  });

  test("selects the google upstream", async () => {
    // Without this header Factory routes by its own default, which does not
    // serve generateContent.
    const seen = await capture(generateOk);
    expect(seen.headers["x-api-provider"]).toBe("google");
  });

  test("sends a native generateContent body, not a chat body", async () => {
    const seen = await capture(generateOk);
    expect(seen.body).toHaveProperty("contents");
    // A chat body would carry `messages`; generateContent must not.
    expect(seen.body).not.toHaveProperty("messages");
  });

  test("still sends Factory's client identity and auth", async () => {
    const seen = await capture(generateOk);
    expect(seen.headers["authorization"]).toContain("Bearer");
    expect(seen.headers["X-Factory-Client"]).toBe("cli");
  });

  test("decodes the response into canonical events", async () => {
    const events: unknown[] = [];
    const fetcher = (async (): Promise<Response> => generateOk()) as unknown as typeof fetch;
    const secret = encodeFactoryDroidCredential({
      accessToken: "tok",
      orgId: "org-1",
    } as never);
    const context = {
      outbound_fetch: fetcher,
      deadline: Date.now() + 60_000,
      abort_signal: new AbortController().signal,
      credential: {
        credential_id: "c1",
        provider_id: "factory",
        credential_kind: "oauth",
        secret,
      },
      user_agent: "test",
    } as unknown as ProviderDispatchContext;
    for await (const event of factoryAdapter.dispatch(request(), TARGET, context)) {
      events.push(event);
    }
    const types = (events as Array<{ type?: string }>).map((e) => e.type);
    expect(types).toContain("response_start");
    expect(types).toContain("content_delta");
    expect(types).toContain("terminal");
  });
});
