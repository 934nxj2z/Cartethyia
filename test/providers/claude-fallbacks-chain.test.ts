/**
 * Claude server-side `fallbacks` chain + served-by-fallback detection.
 *
 * Research rank #7 (effort M) from
 * the provider comparison research → "## Claude Code":
 * the donor sends a `fallbacks` chain (≤3 models, per-attempt settings) behind
 * the `server-side-fallback-2026-06-01` beta, and detects that a fallback
 * answered from `usage.iterations[].type == "fallback_message"`.
 *
 * Unit-level: no network, no environment mutation. The payload builder is called
 * directly and the SSE decoder is fed an in-memory stream.
 */
import { describe, expect, test } from "bun:test";

import {
  CANONICAL_SERVED_BY_FALLBACK_KEY,
  CLAUDE_FALLBACK_ITERATION_TYPE,
  CLAUDE_SERVED_BY_FALLBACK_CAPABILITY,
  claudeResponseToEvents,
  claudeServedByFallback,
  parseClaudeSseStream,
  withClaudeFallbackSignal,
} from "../../src/protocol/response/messages";
import {
  CLAUDE_FALLBACKS_CHAIN_LIMIT,
  CLAUDE_FALLBACKS_OPTION,
  canonicalToClaudeMessagesPayload,
  claudeFallbacksChain,
} from "../../src/protocol/request/messages";
import { ANTHROPIC_BETA_CAPABILITIES } from "../../src/providers/integrations/claude/claude-betas";
import type {
  CanonicalEvent,
  CanonicalRequest,
  CanonicalTerminalEvent,
} from "../../src/protocol/canonical-model";

/** Builds an SSE byte stream from provider event objects. */
function sseStream(events: readonly Record<string, unknown>[]): ReadableStream<Uint8Array> {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
}

async function collect(
  stream: AsyncIterable<CanonicalEvent>,
): Promise<readonly CanonicalEvent[]> {
  const events: CanonicalEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

/** The single terminal event closing a decoded stream. */
function terminalOf(
  events: readonly CanonicalEvent[],
): CanonicalTerminalEvent | undefined {
  return events.find(
    (event): event is CanonicalTerminalEvent => event.type === "terminal",
  );
}

function baseRequest(
  overrides: Partial<CanonicalRequest> = {},
): CanonicalRequest {
  return {
    model: "claude-opus-4-7",
    messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
    generation_controls: {},
    stream: false,
    source_surface: "messages",
    ...overrides,
  };
}

function withFallbacks(declared: unknown): CanonicalRequest {
  return baseRequest({
    provider_options: { [CLAUDE_FALLBACKS_OPTION]: declared },
  });
}

// ─── 1. Beta vocabulary ────────────────────────────────────────────────────

describe("1. server-side-fallback beta", () => {
  test("is in the beta vocabulary (was already present)", () => {
    expect(ANTHROPIC_BETA_CAPABILITIES["server-side-fallback-2026-06-01"]).toContain(
      "server_side_fallback",
    );
  });

  test("resolves to the capability name the chain hooks to", () => {
    expect(CLAUDE_SERVED_BY_FALLBACK_CAPABILITY).toBe("server_side_fallback");
  });

  test("the exported alias still matches the beta table", () => {
    // The constant duplicates the table's first alias; pin the agreement so a
    // rename on either side has to update both.
    expect(ANTHROPIC_BETA_CAPABILITIES["server-side-fallback-2026-06-01"]?.[0]).toBe(
      CLAUDE_SERVED_BY_FALLBACK_CAPABILITY,
    );
  });
});

// ─── 2. Request side: chain is opt-in ──────────────────────────────────────

describe("2. fallbacks chain is opt-in only", () => {
  test("absent when the caller declares nothing", () => {
    expect(canonicalToClaudeMessagesPayload(baseRequest())).not.toHaveProperty(
      "fallbacks",
    );
  });

  test("absent when provider_options carries an unrelated key", () => {
    expect(
      canonicalToClaudeMessagesPayload(
        baseRequest({ provider_options: { something_else: ["x"] } }),
      ),
    ).not.toHaveProperty("fallbacks");
  });

  test("absent when the declared value is not an array", () => {
    for (const value of ["model", 42, null, true, { model: "x" }]) {
      expect(
        canonicalToClaudeMessagesPayload(withFallbacks(value)),
      ).not.toHaveProperty("fallbacks");
    }
  });

  test("absent when the declared array is empty", () => {
    expect(canonicalToClaudeMessagesPayload(withFallbacks([]))).not.toHaveProperty(
      "fallbacks",
    );
  });

  test("does not disturb the rest of the payload", () => {
    const plain = canonicalToClaudeMessagesPayload(baseRequest());
    const chained = canonicalToClaudeMessagesPayload(
      withFallbacks(["claude-sonnet-4-6"]),
    );
    expect(chained["model"]).toBe(plain["model"]);
    expect(chained["max_tokens"]).toBe(plain["max_tokens"]);
    expect(chained["messages"]).toEqual(plain["messages"]);
  });
});

// ─── 3. Request side: chain shape ──────────────────────────────────────────

describe("3. fallbacks chain shape", () => {
  test("accepts bare model-id strings", () => {
    const payload = canonicalToClaudeMessagesPayload(
      withFallbacks(["claude-sonnet-4-6", "claude-haiku-4-5"]),
    );
    expect(payload["fallbacks"]).toEqual([
      { model: "claude-sonnet-4-6" },
      { model: "claude-haiku-4-5" },
    ]);
  });

  test("accepts objects carrying a model id", () => {
    const payload = canonicalToClaudeMessagesPayload(
      withFallbacks([{ model: "claude-sonnet-4-6" }]),
    );
    expect(payload["fallbacks"]).toEqual([{ model: "claude-sonnet-4-6" }]);
  });

  test("carries per-attempt max_tokens through", () => {
    // UNCONFIRMED field, but named by the research — see the note on
    // `claudeFallbacksChain`. Pinned so a rename is deliberate.
    const payload = canonicalToClaudeMessagesPayload(
      withFallbacks([{ model: "claude-sonnet-4-6", max_tokens: 4096 }]),
    );
    expect(payload["fallbacks"]).toEqual([
      { model: "claude-sonnet-4-6", max_tokens: 4096 },
    ]);
  });

  test("carries per-attempt thinking and output_config through", () => {
    const payload = canonicalToClaudeMessagesPayload(
      withFallbacks([
        {
          model: "claude-sonnet-4-6",
          thinking: { type: "enabled", budget_tokens: 1024 },
          output_config: { effort: "low" },
        },
      ]),
    );
    expect(payload["fallbacks"]).toEqual([
      {
        model: "claude-sonnet-4-6",
        thinking: { type: "enabled", budget_tokens: 1024 },
        output_config: { effort: "low" },
      },
    ]);
  });

  test("carries the captured speed value through", () => {
    const payload = canonicalToClaudeMessagesPayload(
      withFallbacks([{ model: "claude-sonnet-4-6", speed: "fast" }]),
    );
    expect(payload["fallbacks"]).toEqual([
      { model: "claude-sonnet-4-6", speed: "fast" },
    ]);
  });

  test("drops a speed value the research does not capture", () => {
    // Only "fast" is documented; anything else is not invented onto the wire.
    const payload = canonicalToClaudeMessagesPayload(
      withFallbacks([{ model: "claude-sonnet-4-6", speed: "standard" }]),
    );
    expect(payload["fallbacks"]).toEqual([{ model: "claude-sonnet-4-6" }]);
  });

  test("drops per-attempt values of the wrong type", () => {
    const payload = canonicalToClaudeMessagesPayload(
      withFallbacks([
        { model: "claude-sonnet-4-6", max_tokens: -1, thinking: "enabled" },
      ]),
    );
    expect(payload["fallbacks"]).toEqual([{ model: "claude-sonnet-4-6" }]);
  });

  test("drops entries with no usable model id", () => {
    const payload = canonicalToClaudeMessagesPayload(
      withFallbacks(["", "   ", 42, null, {}, ["claude-sonnet-4-6"]]),
    );
    expect(payload).not.toHaveProperty("fallbacks");
  });

  test("keeps only the entries that survive", () => {
    const payload = canonicalToClaudeMessagesPayload(
      withFallbacks([42, "claude-sonnet-4-6", {}]),
    );
    expect(payload["fallbacks"]).toEqual([{ model: "claude-sonnet-4-6" }]);
  });

  test("trims whitespace around a declared model id", () => {
    const payload = canonicalToClaudeMessagesPayload(
      withFallbacks(["  claude-sonnet-4-6  "]),
    );
    expect(payload["fallbacks"]).toEqual([{ model: "claude-sonnet-4-6" }]);
  });
});

// ─── 4. Request side: ≤3 model cap ─────────────────────────────────────────

describe("4. fallbacks chain cap", () => {
  test("the documented cap is 3", () => {
    expect(CLAUDE_FALLBACKS_CHAIN_LIMIT).toBe(3);
  });

  test("a 3-entry chain is kept whole", () => {
    const chain = claudeFallbacksChain({
      [CLAUDE_FALLBACKS_OPTION]: ["a", "b", "c"],
    });
    expect(chain?.length).toBe(3);
  });

  test("a longer chain is trimmed to the cap", () => {
    const chain = claudeFallbacksChain({
      [CLAUDE_FALLBACKS_OPTION]: ["a", "b", "c", "d", "e"],
    });
    expect(chain).toEqual([{ model: "a" }, { model: "b" }, { model: "c" }]);
  });

  test("the primary model is not counted against the chain", () => {
    // The cap is on fallbacks, so a primary plus three fallbacks is legal.
    const payload = canonicalToClaudeMessagesPayload(
      baseRequest({
        model: "claude-opus-4-7",
        provider_options: {
          [CLAUDE_FALLBACKS_OPTION]: ["a", "b", "c"],
        },
      }),
    );
    expect(payload["model"]).toBe("claude-opus-4-7");
    expect((payload["fallbacks"] as unknown[]).length).toBe(3);
  });
});

// ─── 5. Response side: served-by-fallback detection ────────────────────────

describe("5. claudeServedByFallback", () => {
  test("false when there is no usage at all", () => {
    expect(claudeServedByFallback(undefined)).toBe(false);
    expect(claudeServedByFallback({ input_tokens: 10, output_tokens: 5 })).toBe(false);
  });

  test("false when iterations is absent or not an array", () => {
    expect(claudeServedByFallback({ iterations: null })).toBe(false);
    expect(claudeServedByFallback({ iterations: "fallback_message" })).toBe(false);
  });

  test("true when an iteration carries the fallback type", () => {
    expect(
      claudeServedByFallback({
        input_tokens: 10,
        output_tokens: 5,
        iterations: [{ type: "fallback_message" }],
      }),
    ).toBe(true);
  });

  test("true even when a non-fallback iteration comes first", () => {
    expect(
      claudeServedByFallback({
        iterations: [{ type: "retry" }, { type: "fallback_message" }],
      }),
    ).toBe(true);
  });

  test("false for an unrelated iteration type", () => {
    expect(claudeServedByFallback({ iterations: [{ type: "retry" }] })).toBe(false);
  });

  test("tolerates malformed iteration entries", () => {
    expect(
      claudeServedByFallback({ iterations: [null, "x", 42, {}] }),
    ).toBe(false);
  });

  test("the pinned type matches the research value", () => {
    expect(CLAUDE_FALLBACK_ITERATION_TYPE).toBe("fallback_message");
  });
});

// ─── 6. Response side: signal on the terminal event ────────────────────────

describe("6. served_by_fallback on the terminal event", () => {
  test("the key is namespaced so an upstream field cannot be shadowed", () => {
    expect(CANONICAL_SERVED_BY_FALLBACK_KEY).toBe("served_by_fallback");
  });

  test("set on a non-streaming response that reports the iteration", () => {
    const terminal = terminalOf(
      claudeResponseToEvents(
        {
          id: "msg_test",
          type: "message",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            iterations: [{ type: "fallback_message" }],
          },
        },
        baseRequest(),
      ),
    );
    expect(terminal?.stop_details?.[CANONICAL_SERVED_BY_FALLBACK_KEY]).toBe(true);
  });

  test("absent on a non-streaming response where the primary answered", () => {
    const terminal = terminalOf(
      claudeResponseToEvents(
        {
          id: "msg_test",
          type: "message",
          model: "claude-opus-4-7",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
        baseRequest(),
      ),
    );
    expect(terminal?.stop_details?.[CANONICAL_SERVED_BY_FALLBACK_KEY]).toBeUndefined();
  });

  test("coexists with upstream stop details rather than replacing them", () => {
    const terminal = terminalOf(
      claudeResponseToEvents(
        {
          id: "msg_test",
          type: "message",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "refusal",
          stop_details: { reason: "classifier_blocked" },
          usage: { input_tokens: 1, output_tokens: 1, iterations: [{ type: "fallback_message" }] },
        },
        baseRequest(),
      ),
    );
    expect(terminal?.stop_details).toEqual({
      reason: "classifier_blocked",
      served_by_fallback: true,
    });
  });

  test("set on a streaming response that reports the iteration", async () => {
    // Anthropic never repeats input-side counts in `message_delta`, so a
    // fallback iteration reported on either frame must still be seen.
    const terminal = terminalOf(
      await collect(
        parseClaudeSseStream(
          sseStream([
            {
              type: "message_start",
              message: {
                model: "claude-sonnet-4-6",
                usage: { input_tokens: 10, iterations: [{ type: "fallback_message" }] },
              },
            },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
            { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
            { type: "message_stop" },
          ]),
        ),
      ),
    );
    expect(terminal?.stop_details?.[CANONICAL_SERVED_BY_FALLBACK_KEY]).toBe(true);
    expect(terminal?.usage?.input_tokens).toBe(10);
    expect(terminal?.usage?.output_tokens).toBe(5);
  });

  test("set when the iteration arrives on the delta frame", async () => {
    const terminal = terminalOf(
      await collect(
        parseClaudeSseStream(
          sseStream([
            {
              type: "message_start",
              message: { model: "claude-opus-4-7", usage: { input_tokens: 10 } },
            },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
            {
              type: "message_delta",
              delta: { stop_reason: "end_turn" },
              usage: { output_tokens: 5, iterations: [{ type: "fallback_message" }] },
            },
            { type: "message_stop" },
          ]),
        ),
      ),
    );
    expect(terminal?.stop_details?.[CANONICAL_SERVED_BY_FALLBACK_KEY]).toBe(true);
  });

  test("absent on a stream where the primary answered", async () => {
    const terminal = terminalOf(
      await collect(
        parseClaudeSseStream(
          sseStream([
            {
              type: "message_start",
              message: { model: "claude-opus-4-7", usage: { input_tokens: 10 } },
            },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
            { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
            { type: "message_stop" },
          ]),
        ),
      ),
    );
    expect(terminal?.stop_details?.[CANONICAL_SERVED_BY_FALLBACK_KEY]).toBeUndefined();
  });

  test("never overwrites an explicit upstream served_by_fallback value", () => {
    // The provider's own value wins: this fold only fills a gap, it never
    // asserts a verdict over one the upstream already stated.
    expect(
      withClaudeFallbackSignal(
        { served_by_fallback: false },
        { iterations: [{ type: "fallback_message" }] },
      ),
    ).toEqual({ served_by_fallback: false });
  });

  test("the served model is the one the upstream reported, not the requested primary", () => {
    // The whole point of the signal: `usage.iterations[].type` tells accounting
    // that `model` below is a fallback, not the model the caller asked for.
    const requested = baseRequest({ model: "claude-opus-4-7" });
    const events = claudeResponseToEvents(
      {
        id: "msg_test",
        type: "message",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1, iterations: [{ type: "fallback_message" }] },
      },
      requested,
    );
    const start = events.find((event) => event.type === "message_start");
    expect(start).toBeDefined();
    expect((start as { model?: string }).model).toBe("claude-sonnet-4-6");
    expect(terminalOf(events)?.stop_details?.[CANONICAL_SERVED_BY_FALLBACK_KEY]).toBe(true);
  });
});

// ─── 7. Request and response sides are independent ─────────────────────────

describe("7. the two halves do not leak into each other", () => {
  test("declaring a chain does not invent a served_by_fallback signal", () => {
    // The request side only emits `fallbacks[]`; the signal is read from the
    // response, never assumed from having asked.
    const payload = canonicalToClaudeMessagesPayload(
      withFallbacks(["claude-sonnet-4-6"]),
    );
    expect(payload["fallbacks"]).toBeDefined();
    expect(payload).not.toHaveProperty("served_by_fallback");
  });

  test("a fallback response is detected without any declared chain", () => {
    // The upstream can serve a fallback on its own; detection must not depend
    // on the caller having opted in.
    const terminal = terminalOf(
      claudeResponseToEvents(
        {
          id: "msg_test",
          type: "message",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1, iterations: [{ type: "fallback_message" }] },
        },
        baseRequest(),
      ),
    );
    expect(terminal?.stop_details?.[CANONICAL_SERVED_BY_FALLBACK_KEY]).toBe(true);
    expect(baseRequest().provider_options).toBeUndefined();
  });
});
