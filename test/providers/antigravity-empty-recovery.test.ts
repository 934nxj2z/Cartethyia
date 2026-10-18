/**
 * Antigravity empty-stream recovery wiring.
 *
 * The point of these tests: the helper is now called from the adapter's stream
 * leg, and the danger of that wiring is a *second* upstream fetch on every
 * healthy request (double metering). The peek must be a bounded read of a
 * clone, and a healthy stream must never trigger a replay.
 */
import { describe, expect, test } from "bun:test";
import { AntigravityAdapter } from "../../src/providers/integrations/antigravity/antigravity";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";
import type { ProviderDispatchContext, ProviderDispatchTarget } from "../../src/providers/provider-contracts";

/** SSE body carrying one text delta, then [DONE]. */
function healthySse(): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const chunk = (obj: unknown): Uint8Array =>
    encoder.encode(`data: ${JSON.stringify(obj)}\n\n`);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(
        chunk({
          candidates: [
            { content: { role: "model", parts: [{ text: "hello" }] }, finishReason: "STOP" },
          ],
        }),
      );
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

/** SSE body that opens with nothing meaningful: a data event with no content. */
function silentSse(): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      // Valid SSE that decodes to a candidate with no text/calls/thought —
      // exactly the "200 with nothing in it" shape the recovery targets.
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            candidates: [{ content: { role: "model", parts: [] } }],
          })}\n\n`,
        ),
      );
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

function makeContext(impl: typeof fetch): ProviderDispatchContext {
  return {
    outbound_fetch: impl,
    deadline: Date.now() + 60_000,
    abort_signal: new AbortController().signal,
    credential: {
      credential_id: "c1",
      provider_id: "antigravity",
      credential_kind: "oauth",
      kind: "oauth",
      secret: new TextEncoder().encode("test-token"),
    },
    user_agent: "test",
  } as unknown as ProviderDispatchContext;
}

function makeTarget(): ProviderDispatchTarget {
  return {
    provider_id: "antigravity",
    wire_family: "chat",
    endpoint_path: "/v1internal:generateContent",
    credential: {
      credential_id: "c1",
      provider_id: "antigravity",
      credential_kind: "oauth",
      kind: "oauth",
      secret: new TextEncoder().encode("test-token"),
    },
  } as unknown as ProviderDispatchTarget;
}

function makeRequest(): CanonicalRequest {
  return {
    model: "gemini-3-flash-agent",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    stream: true,
    generation_controls: {},
    source_surface: "test",
  } as unknown as CanonicalRequest;
}

describe("Antigravity empty-stream recovery wiring", () => {
  test("healthy stream issues exactly ONE upstream fetch (no double metering)", async () => {
    // The wiring bug this guards: calling the helper unconditionally would
    // always fetch once for the peek, doubling every request's upstream cost.
    const calls: string[] = [];
    const fetcher = (async (url: unknown): Promise<Response> => {
      const urlString = String(url);
      calls.push(urlString);
      // Control-plane project lookup is a separate concern; answer it so the
      // only dispatch-path call we count is the generateContent one.
      if (!urlString.toLowerCase().includes("generatecontent")) {
        // Control-plane (loadCodeAssist / onboardUser): return a shape that
        // satisfies the lookup — a currentTier so onboardUser is skipped and a
        // project id so extraction succeeds.
        return new Response(
          JSON.stringify({
            currentTier: { id: "free-tier" },
            cloudaicompanionProject: "projects/p1",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(healthySse(), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    const adapter = new AntigravityAdapter();
    const events: unknown[] = [];
    for await (const event of adapter.dispatch(
      makeRequest(),
      makeTarget(),
      makeContext(fetcher),
    )) {
      events.push(event);
    }
    const generateCalls = calls.filter((c) =>
      c.toLowerCase().includes("generatecontent"),
    );
    expect(generateCalls.length).toBe(1);
  });

  test("silent first burst triggers a replay (more than one fetch)", async () => {
    let generateCalls = 0;
    const seen: string[] = [];
    const fetcher = (async (url: unknown): Promise<Response> => {
      const urlString = String(url);
      seen.push(urlString);
      if (!urlString.toLowerCase().includes("generatecontent")) {
        return new Response(
          JSON.stringify({ cloudaicompanionProject: "projects/p1" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      generateCalls++;
      // Always silent: peek says empty, replays exhaust, helper throws.
      return new Response(silentSse(), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    const adapter = new AntigravityAdapter();
    try {
      for await (const _event of adapter.dispatch(
        makeRequest(),
        makeTarget(),
        makeContext(fetcher),
      )) {
        void _event;
      }
    } catch {
      // Exhaustion throws; that is the expected terminal for all-silent.
    }
    if (generateCalls <= 1) {
      throw new Error(`expected replays, saw ${generateCalls} calls: ${seen.join(", ")}`);
    }
    expect(generateCalls).toBeGreaterThan(1);
  });

  test("healthy stream still yields the text delta to the caller", async () => {
    const fetcher = (async (url: unknown): Promise<Response> => {
      if (!String(url).toLowerCase().includes("generatecontent")) {
        return new Response(
          JSON.stringify({
            currentTier: { id: "free-tier" },
            cloudaicompanionProject: "projects/p1",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(healthySse(), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    const adapter = new AntigravityAdapter();
    let sawText = false;
    for await (const event of adapter.dispatch(
      makeRequest(),
      makeTarget(),
      makeContext(fetcher),
    )) {
      const e = event as { type?: string; content?: { text?: string } };
      if (e.type === "content_delta" && e.content?.text === "hello") sawText = true;
    }
    expect(sawText).toBe(true);
  });
});
