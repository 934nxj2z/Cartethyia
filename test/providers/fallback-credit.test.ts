/**
 * Fallback-credit token cache + refusal redemption tests.
 *
 * Research item #2 (rank M) from
 * the provider comparison research. The wire shape is
 * taken from the reference client source (`packages/ai/src/providers/anthropic.ts`):
 * the redemption body is the refused body with `fallback_credit_token` set
 * **top-level** (`:1633-1646`), captured from a refusal's `stop_details`
 * (`:3295-3309`), forfeited and retried once without it on a 400 that names
 * the token (`:3469-3481`), and the beta is `fallback-credit-2026-06-01`
 * (`:242`). Donor-pinned by
 * `packages/ai/test/anthropic-stream-envelope.test.ts:2145-2211`.
 *
 * Unit-level: no network, no environment mutation. Cache and body helpers are
 * called directly; the adapter tests stub `fetch`, so nothing leaves the
 * process. The shared cache is cleared in `beforeEach` so the tests never
 * depend on each other's tokens.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  CLAUDE_FALLBACK_CREDIT_MODEL_OPTION,
  FALLBACK_CREDIT_BETA,
  FALLBACK_CREDIT_TTL_MS,
  FallbackCreditCache,
  fallbackCreditRequestBody,
  fallbackCreditTargetModel,
  hashBody,
  isFallbackCreditTokenRejection,
  refusalCreditToken,
  sharedFallbackCreditCache,
} from "../../src/providers/integrations/claude/fallback-credit";
import { ClaudeAdapter } from "../../src/providers/integrations/claude/claude";
import { GatewayError } from "../../src/protocol/gateway-error";
import type {
  CanonicalEvent,
  CanonicalRequest,
  GenerationControls,
} from "../../src/protocol/canonical-model";
import type {
  ProviderDispatchContext,
  ProviderDispatchTarget,
} from "../../src/providers/provider-contracts";

beforeEach(() => {
  sharedFallbackCreditCache.clear();
});

describe("hashBody", () => {
  test("produces stable hashes for identical bodies", () => {
    expect(hashBody('{"model":"claude-sonnet-4-6"}')).toBe(
      hashBody('{"model":"claude-sonnet-4-6"}'),
    );
  });

  test("produces different hashes for different bodies", () => {
    expect(hashBody('{"model":"a"}')).not.toBe(hashBody('{"model":"b"}'));
  });

  test("handles empty string", () => {
    // FNV-1a of empty string is the offset basis 0x811c9dc5
    expect(hashBody("")).toBe("ztntfp");
  });
});

describe("FallbackCreditCache", () => {
  test("stores and retrieves a token", () => {
    const cache = new FallbackCreditCache();
    cache.set("key1", "token-abc");
    expect(cache.get("key1")).toBe("token-abc");
  });

  test("returns undefined for missing key", () => {
    const cache = new FallbackCreditCache();
    expect(cache.get("missing")).toBeUndefined();
  });

  test("returns undefined for expired token", async () => {
    const cache = new FallbackCreditCache({ ttlMs: 50 });
    cache.set("key1", "token-abc");
    // Token is present immediately
    expect(cache.get("key1")).toBe("token-abc");
    // Wait for TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(cache.get("key1")).toBeUndefined();
  });

  test("evicts oldest entry when at capacity", () => {
    const cache = new FallbackCreditCache({ maxSize: 3 });
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3");
    expect(cache.size).toBe(3);
    cache.set("d", "4"); // should evict "a"
    expect(cache.size).toBe(3);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("d")).toBe("4");
  });

  test("refreshes LRU position on get", () => {
    const cache = new FallbackCreditCache({ maxSize: 3 });
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3");
    // Access "a" to refresh its position
    cache.get("a");
    // Add "d" — should evict "b" (now the oldest)
    cache.set("d", "4");
    expect(cache.get("a")).toBe("1");
    expect(cache.get("b")).toBeUndefined();
  });

  test("clear removes all entries", () => {
    const cache = new FallbackCreditCache();
    cache.set("a", "1");
    cache.set("b", "2");
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("a")).toBeUndefined();
  });

  test("overwriting an existing key does not grow size", () => {
    const cache = new FallbackCreditCache();
    cache.set("a", "1");
    cache.set("a", "2");
    expect(cache.size).toBe(1);
    expect(cache.get("a")).toBe("2");
  });

  test("delete removes a forfeited or spent token", () => {
    const cache = new FallbackCreditCache();
    cache.set("a", "1");
    expect(cache.delete("a")).toBe(true);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.delete("a")).toBe(false);
  });
});

// ─── 2. Capture: only a refusal carries a token ─────────────────────────────

describe("refusalCreditToken", () => {
  test("reads the token off a refusal's stop_details", () => {
    // Donor `anthropic.ts:3295`: `stopDetails?.type === "refusal" && stopDetails.fallback_credit_token`.
    expect(
      refusalCreditToken({ type: "refusal", fallback_credit_token: "fct_abc" }),
    ).toBe("fct_abc");
  });

  test("ignores a refusal with no token", () => {
    expect(refusalCreditToken({ type: "refusal" })).toBeUndefined();
  });

  test("ignores a non-refusal stop detail that carries the field", () => {
    // Only a refusal mints a credit; a `sensitive` stop naming the field is not
    // evidence of one.
    expect(
      refusalCreditToken({ type: "sensitive", fallback_credit_token: "fct_abc" }),
    ).toBeUndefined();
    expect(refusalCreditToken({ fallback_credit_token: "fct_abc" })).toBeUndefined();
  });

  test("ignores malformed stop details", () => {
    expect(refusalCreditToken(undefined)).toBeUndefined();
    expect(refusalCreditToken({})).toBeUndefined();
    expect(refusalCreditToken({ type: "refusal", fallback_credit_token: 42 })).toBeUndefined();
    expect(refusalCreditToken({ type: "refusal", fallback_credit_token: "" })).toBeUndefined();
    expect(refusalCreditToken({ type: "refusal", fallback_credit_token: null })).toBeUndefined();
  });
});

// ─── 3. Redemption body shape ───────────────────────────────────────────────

describe("fallbackCreditRequestBody", () => {
  const body = JSON.stringify({
    model: "claude-opus-4-7",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 1024,
  });

  test("sets the token TOP-LEVEL on the body, not inside stop_details", () => {
    // The whole point of the item: the donor writes
    // `body.fallback_credit_token = redemption.token` (`anthropic.ts:1640`).
    // An earlier draft of this module nested it under `stop_details`.
    const parsed = JSON.parse(fallbackCreditRequestBody(body, "fct_abc") ?? "{}") as Record<
      string,
      unknown
    >;
    expect(parsed["fallback_credit_token"]).toBe("fct_abc");
    expect(parsed).not.toHaveProperty("stop_details");
  });

  test("deletes fallbacks from the redemption body", () => {
    // `anthropic.ts:1641`: `delete body.fallbacks`. The token is bound to one
    // body; a chain would let it be spent on a hop it was not minted for.
    const chained = JSON.stringify({
      model: "claude-opus-4-7",
      messages: [{ role: "user", content: "hi" }],
      fallbacks: [{ model: "claude-sonnet-4-6" }],
    });
    const parsed = JSON.parse(fallbackCreditRequestBody(chained, "fct_abc") ?? "{}") as Record<
      string,
      unknown
    >;
    expect(parsed["fallback_credit_token"]).toBe("fct_abc");
    expect(parsed).not.toHaveProperty("fallbacks");
  });

  test("leaves everything else byte-identical", () => {
    const parsed = JSON.parse(fallbackCreditRequestBody(body, "fct_abc") ?? "{}") as Record<
      string,
      unknown
    >;
    expect(parsed["model"]).toBe("claude-opus-4-7");
    expect(parsed["max_tokens"]).toBe(1024);
    expect(parsed["messages"]).toEqual([{ role: "user", content: "hi" }]);
  });

  test("does not retarget the model when no target is declared", () => {
    // OMISSION, deliberate: the donor always retargets
    // (`body.model = targetModelId`, `:1639`) from catalog metadata this repo
    // does not have. Without a declared target the body keeps its own model
    // rather than inventing one.
    const parsed = JSON.parse(fallbackCreditRequestBody(body, "fct_abc") ?? "{}") as Record<
      string,
      unknown
    >;
    expect(parsed["model"]).toBe("claude-opus-4-7");
  });

  test("retargets only at a declared target model", () => {
    const parsed = JSON.parse(
      fallbackCreditRequestBody(body, "fct_abc", "claude-sonnet-4-6") ?? "{}",
    ) as Record<string, unknown>;
    expect(parsed["model"]).toBe("claude-sonnet-4-6");
    expect(parsed["fallback_credit_token"]).toBe("fct_abc");
  });

  test("returns undefined for a body it cannot parse", () => {
    // A token is never injected into a payload we could not read.
    expect(fallbackCreditRequestBody("not json", "fct_abc")).toBeUndefined();
    expect(fallbackCreditRequestBody("[1,2]", "fct_abc")).toBeUndefined();
    expect(fallbackCreditRequestBody("null", "fct_abc")).toBeUndefined();
  });
});

describe("fallbackCreditTargetModel", () => {
  test("reads the declared target model", () => {
    expect(
      fallbackCreditTargetModel({
        [CLAUDE_FALLBACK_CREDIT_MODEL_OPTION]: "claude-sonnet-4-6",
      }),
    ).toBe("claude-sonnet-4-6");
  });

  test("trims whitespace", () => {
    expect(
      fallbackCreditTargetModel({
        [CLAUDE_FALLBACK_CREDIT_MODEL_OPTION]: "  claude-sonnet-4-6  ",
      }),
    ).toBe("claude-sonnet-4-6");
  });

  test("ignores absent, empty, and non-string values", () => {
    // Never invent a fallback model: a value that names nothing is absent.
    expect(fallbackCreditTargetModel(undefined)).toBeUndefined();
    expect(fallbackCreditTargetModel({})).toBeUndefined();
    expect(
      fallbackCreditTargetModel({ [CLAUDE_FALLBACK_CREDIT_MODEL_OPTION]: "  " }),
    ).toBeUndefined();
    expect(
      fallbackCreditTargetModel({ [CLAUDE_FALLBACK_CREDIT_MODEL_OPTION]: 42 }),
    ).toBeUndefined();
    expect(
      fallbackCreditTargetModel({ [CLAUDE_FALLBACK_CREDIT_MODEL_OPTION]: null }),
    ).toBeUndefined();
  });

  test("the beta constant matches the donor string", () => {
    expect(FALLBACK_CREDIT_BETA).toBe("fallback-credit-2026-06-01");
  });
});

// ─── 4. 400 that names the token ────────────────────────────────────────────

describe("isFallbackCreditTokenRejection", () => {
  test("true for a 400 whose message names fallback_credit_token", () => {
    // Donor `anthropic.ts:3469`: `errMessage.includes("fallback_credit_token")`.
    expect(
      isFallbackCreditTokenRejection(
        new GatewayError("invalid_request", 400, "invalid fallback_credit_token expired"),
      ),
    ).toBe(true);
  });

  test("false for a 400 that says something else", () => {
    // A plain 400 is not evidence the token is bad; retrying it would double-bill.
    expect(
      isFallbackCreditTokenRejection(
        new GatewayError("invalid_request", 400, "max_tokens is too large"),
      ),
    ).toBe(false);
  });

  test("false for the same message at another status", () => {
    expect(
      isFallbackCreditTokenRejection(
        new GatewayError("platform_unavailable", 500, "bad fallback_credit_token"),
      ),
    ).toBe(false);
  });

  test("false for a non-GatewayError", () => {
    expect(isFallbackCreditTokenRejection(new Error("400 fallback_credit_token"))).toBe(false);
    expect(isFallbackCreditTokenRejection("fallback_credit_token")).toBe(false);
    expect(isFallbackCreditTokenRejection(undefined)).toBe(false);
  });
});

// ─── 5. Adapter: capture → replay → forfeit ─────────────────────────────────

const candidate: ProviderDispatchTarget = {
  provider_id: "claude",
  model_id: "claude-opus-4-7",
  wire_family: "messages",
  endpoint_path: "/v1/messages",
  capabilities: {},
};

function makeRequest(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: "claude-opus-4-7",
    messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
    stream: true,
    generation_controls: {} as GenerationControls,
    source_surface: "messages",
    ...overrides,
  };
}

function makeContext(): ProviderDispatchContext {
  return {
    credential: {
      provider_id: "claude",
      credential_kind: "oauth",
      secret: new TextEncoder().encode("test-oauth-token"),
      account_id: "00000000-0000-4000-8000-000000000000",
    },
    deadline: Date.now() + 30_000,
    abort_signal: AbortSignal.timeout(30_000),
  };
}

/** The SSE bytes for one refusal terminal carrying a credit token. */
function refusalSse(token: string): string {
  const frames = [
    { type: "message_start", message: { model: "claude-opus-4-7", usage: { input_tokens: 1 } } },
    {
      type: "message_delta",
      delta: {
        stop_reason: "refusal",
        stop_details: { type: "refusal", fallback_credit_token: token },
      },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ];
  return frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");
}

function successSse(): string {
  const frames = [
    { type: "message_start", message: { model: "claude-opus-4-7", usage: { input_tokens: 1 } } },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "ok" },
    },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ];
  return frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");
}

interface Attempt {
  readonly headers: Record<string, string>;
  readonly body: string;
}

/**
 * Runs one dispatch per supplied response against a stubbed fetch, and returns
 * everything the stub was called with.
 *
 * The redemption spans two dispatches by nature: the first is refused (and
 * banks the token), the second is the later identical request that spends it.
 * A forfeiting 400 makes the second dispatch send twice.
 */
async function dispatchCapturing(
  responses: readonly (() => Response)[],
  request: CanonicalRequest = makeRequest(),
  // One turn per response by default: the common shape here is "bank a token
  // on turn 1, spend it on turn 2", so each entry is its own dispatch.
  //
  // A single dispatch that retries internally (refusal → replay → 400 →
  // drop-and-retry) must pass `turns = 1` explicitly, or its attempt sequence
  // is misread as separate turns and the recorded fetch count is inflated.
  turns = responses.length,
): Promise<readonly Attempt[]> {
  const seen: Attempt[] = [];
  let index = 0;
  const fetchStub = (async (_url: unknown, init?: RequestInit) => {
    seen.push({
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: String(init?.body ?? ""),
    });
    const next = responses[Math.min(index, responses.length - 1)];
    index++;
    return next === undefined ? new Response("no stub", { status: 500 }) : next();
  }) as unknown as typeof fetch;

  const adapter = new ClaudeAdapter({ fetch: fetchStub });
  for (let turn = 0; turn < turns; turn++) {
    try {
      for await (const _event of adapter.dispatch(request, candidate, makeContext())) {
        // Events are only read when a test asks for them; the attempts are the
        // contract under assertion here.
      }
    } catch {
      // A dispatch that throws still records what it sent; assertions below
      // decide whether the throw was the expected outcome.
    }
  }
  return seen;
}

/**
 * Banks a token with `bankedRequest`, then dispatches `replayRequest` once.
 *
 * A credit is bound to the body that was refused, so the two requests differ in
 * this variant — that is the point under assertion.
 */
async function dispatchReplay(
  bankedRequest: CanonicalRequest,
  replayRequest: CanonicalRequest,
  replayResponses: readonly (() => Response)[],
): Promise<readonly Attempt[]> {
  const seen: Attempt[] = [];
  let index = 0;
  let banking = true;
  const fetchStub = (async (_url: unknown, init?: RequestInit) => {
    if (banking) return sseResponse(refusalSse("fct_banked"))();
    seen.push({
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: String(init?.body ?? ""),
    });
    const next = replayResponses[Math.min(index, replayResponses.length - 1)];
    index++;
    return next === undefined ? new Response("no stub", { status: 500 }) : next();
  }) as unknown as typeof fetch;

  const adapter = new ClaudeAdapter({ fetch: fetchStub });
  try {
    for await (const _event of adapter.dispatch(bankedRequest, candidate, makeContext())) {
      // Banked turn; only its side effect on the cache matters.
    }
  } catch {
    // ignored
  }
  banking = false;
  try {
    for await (const _event of adapter.dispatch(replayRequest, candidate, makeContext())) {
      // Replay turn; assertions read what it sent.
    }
  } catch {
    // ignored
  }
  return seen;
}

function sseResponse(body: string): () => Response {
  return () =>
    new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
}

function errorResponse(status: number, message: string): () => Response {
  return () =>
    new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }), {
      status,
      headers: { "content-type": "application/json" },
    });
}

function betaTokens(headers: Record<string, string>): readonly string[] {
  const raw = headers["anthropic-beta"] ?? headers["Anthropic-Beta"] ?? "";
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

async function collect(
  request: CanonicalRequest,
  responses: readonly (() => Response)[],
): Promise<readonly CanonicalEvent[]> {
  let index = 0;
  const fetchStub = (async (_url: unknown, _init?: RequestInit) => {
    const next = responses[Math.min(index, responses.length - 1)];
    index++;
    return next === undefined ? new Response("no stub", { status: 500 }) : next();
  }) as unknown as typeof fetch;
  const events: CanonicalEvent[] = [];
  try {
    for await (const event of new ClaudeAdapter({ fetch: fetchStub }).dispatch(
      request,
      candidate,
      makeContext(),
    )) {
      events.push(event);
    }
  } catch {
    // ignored; assertions read `events`
  }
  return events;
}

describe("ClaudeAdapter fallback-credit redemption", () => {
  test("banks a refusal's token and replays it top-level on the next identical request", async () => {
    const seen = await dispatchCapturing([
      sseResponse(refusalSse("fct_banked")),
      sseResponse(successSse()),
    ]);
    expect(seen.length).toBe(2);
    expect(seen[0]?.body).not.toContain("fallback_credit_token");
    const replay = JSON.parse(seen[1]?.body ?? "{}") as Record<string, unknown>;
    expect(replay["fallback_credit_token"]).toBe("fct_banked");
    // Top-level, never nested in stop_details.
    expect(replay).not.toHaveProperty("stop_details");
  });

  test("sends the fallback-credit beta on the redemption request", async () => {
    // Donor guarantees it (`anthropic.ts:2433-2435`, `:2782-2784`).
    const seen = await dispatchCapturing([
      sseResponse(refusalSse("fct_banked")),
      sseResponse(successSse()),
    ]);
    expect(betaTokens(seen[1]?.headers ?? {})).toContain(FALLBACK_CREDIT_BETA);
  });

  test("a different body does not spend the token", async () => {
    // The token is bound to the body that was refused (`anthropic.ts:3303`,
    // `params: structuredClone(params)`), so an edited replay is not a match.
    const seen = await dispatchReplay(
      makeRequest(),
      makeRequest({
        messages: [{ role: "user", content: [{ kind: "text", text: "different" }] }],
      }),
      [sseResponse(successSse())],
    );
    expect(seen.length).toBe(1);
    expect(seen[0]?.body).not.toContain("fallback_credit_token");
  });

  test("an identical body spends the token", async () => {
    // The mirror image of the case above: same body, so the credit applies.
    const seen = await dispatchReplay(makeRequest(), makeRequest(), [
      sseResponse(successSse()),
    ]);
    expect(JSON.parse(seen[0]?.body ?? "{}")["fallback_credit_token"]).toBe("fct_banked");
  });

  test("the redemption is one-shot: a third identical request carries no token", async () => {
    const seen = await dispatchCapturing([
      sseResponse(refusalSse("fct_banked")),
      sseResponse(successSse()),
      sseResponse(successSse()),
    ]);
    expect(seen.length).toBe(3);
    expect(seen[1]?.body).toContain("fct_banked");
    expect(seen[2]?.body).not.toContain("fallback_credit_token");
  });

  test("drops the token and retries once without it when a 400 names it", async () => {
    // Two turns: turn 1 is the refusal that banks the token, turn 2 is the
    // replay — which carries the token, takes the 400, and retries once
    // without it. So turn 2 alone produces two fetches, and the "retry once"
    // contract is exactly that the third fetch no longer carries the token.
    const seen = await dispatchCapturing(
      [
        sseResponse(refusalSse("fct_expired")),
        errorResponse(400, "400 invalid fallback_credit_token expired"),
        sseResponse(successSse()),
      ],
      makeRequest(),
      2,
    );
    expect(seen.length).toBe(3);
    expect(JSON.parse(seen[1]?.body ?? "{}")["fallback_credit_token"]).toBe("fct_expired");
    // Second attempt dropped the token entirely.
    expect(seen[2]?.body).not.toContain("fallback_credit_token");
    expect(JSON.parse(seen[2]?.body ?? "{}")).not.toHaveProperty("fallback_credit_token");
  });

  test("does not retry an unrelated 400 without the token", async () => {
    // Only a 400 naming the token forfeits it; any other 400 surfaces instead
    // of being retried once and billed twice.
    const seen = await dispatchCapturing(
      [
        sseResponse(refusalSse("fct_banked")),
        errorResponse(400, "max_tokens is too large"),
        sseResponse(successSse()),
      ],
      makeRequest(),
      2,
    );
    expect(seen.length).toBe(2);
    expect(JSON.parse(seen[1]?.body ?? "{}")["fallback_credit_token"]).toBe("fct_banked");
  });

  test("no token is banked when the refusal carries none", async () => {
    const seen = await dispatchCapturing([
      sseResponse(
        [
          {
            type: "message_delta",
            delta: { stop_reason: "refusal", stop_details: { type: "refusal" } },
          },
          { type: "message_stop" },
        ]
          .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
          .join(""),
      ),
      sseResponse(successSse()),
    ]);
    expect(seen[1]?.body).not.toContain("fallback_credit_token");
  });

  test("retargets only when provider_options names a model", async () => {
    const seen = await dispatchCapturing(
      [sseResponse(refusalSse("fct_banked")), sseResponse(successSse())],
      makeRequest({
        provider_options: {
          [CLAUDE_FALLBACK_CREDIT_MODEL_OPTION]: "claude-sonnet-4-6",
        },
      }),
    );
    const replay = JSON.parse(seen[1]?.body ?? "{}") as Record<string, unknown>;
    expect(replay["model"]).toBe("claude-sonnet-4-6");
    expect(replay["fallback_credit_token"]).toBe("fct_banked");
  });

  test("the refusal still yields its terminal event to the caller", async () => {
    // Banking a credit must not swallow the refusal: the caller still owns
    // surfacing it.
    const events = await collect(makeRequest(), [sseResponse(refusalSse("fct_banked"))]);
    const terminal = events.find((event) => event.type === "terminal");
    expect(terminal).toBeDefined();
    expect((terminal as { stop_reason?: string }).stop_reason).toBe("error");
  });
});

// ─── 6. TTL: the token dies with its window ─────────────────────────────────

describe("TTL expiry", () => {
  test("a token banked with a short TTL is not replayed after it lapses", async () => {
    // Donor window is 5 minutes (`:248`); the cache honours whatever it was
    // constructed with, so a fast test pins the expiry behaviour itself.
    const cache = new FallbackCreditCache({ ttlMs: 20 });
    cache.set("k", "fct_soon_dead");
    expect(cache.get("k")).toBe("fct_soon_dead");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(cache.get("k")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  test("the documented window is 5 minutes", () => {
    expect(FALLBACK_CREDIT_TTL_MS).toBe(5 * 60 * 1000);
  });

  test("the shared cache keeps a live token banked by the adapter", async () => {
    await collect(makeRequest(), [sseResponse(refusalSse("fct_live"))]);
    // Banked against the body that was refused; still inside its window.
    expect(sharedFallbackCreditCache.size).toBe(1);
  });
});
