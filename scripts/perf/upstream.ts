/**
 * A minimal OpenAI-compatible upstream for load measurement.
 *
 * The audit measures the gateway's own work — auth, routing, admission, lease,
 * attempt bookkeeping, telemetry, release — so the upstream must succeed fast
 * and predictably. A real provider's latency would dominate the p99 and hide
 * the thing under test. It returns one short answer with a plausible usage
 * block and supports both streaming and non-streaming, because the two paths
 * release resources differently.
 *
 * Usage: bun run scripts/perf/upstream.ts [--port 9911]
 */
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { port: { type: "string", default: "9911" } } });
const port = Number(values.port);

const encoder = new TextEncoder();

/** One non-streaming chat completion, sized like a real short answer. */
function completion(model: string): unknown {
  return {
    id: "chatcmpl-perf",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Hello from Cartethyia." },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
  };
}

/** A two-chunk SSE stream, so the streaming release path is exercised too. */
function sseFrames(model: string): string[] {
  const base = {
    id: "chatcmpl-perf",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
  };
  return [
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: " from Cartethyia." }, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
  ];
}

const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== "POST") return new Response("not found", { status: 404 });
    let body: { model?: string; stream?: boolean } = {};
    try {
      body = (await request.json()) as { model?: string; stream?: boolean };
    } catch {
      // An empty body is fine; the model id is only echoed back.
    }
    const model = body.model ?? "perf-model";
    // Counted by the harness only; the upstream stays silent so it does not
    // pollute the gateway's own logging measurements.
    if (url.pathname.includes("count_tokens")) {
      return new Response(JSON.stringify({ input_tokens: 12 }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (body.stream === true) {
      const frames = sseFrames(model);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const frame of frames) controller.enqueue(encoder.encode(frame));
          controller.close();
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
      });
    }
    return new Response(JSON.stringify(completion(model)), {
      headers: { "content-type": "application/json" },
    });
  },
});

console.log(`[upstream] listening on http://127.0.0.1:${server.port}`);
