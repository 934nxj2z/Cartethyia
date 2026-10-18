/**
 * Codex 429 retry budget honoring server delays (research item Codex #2).
 *
 * Unit-level: no network (the adapter is driven through an injected
 * `outbound_fetch`) and no environment mutation. Real timers are used, but the
 * amounts under test are small enough that wall-clock cost is negligible.
 *
 * Covers the three properties that make the behavior safe:
 *   (a) a 429 that states a delay waits that delay and re-posts;
 *   (b) the wait is clamped by the budget/deadline and never exceeds one wait;
 *   (c) a non-429 or non-retryable error is untouched.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  _setCodexRateLimitSleepForTesting,
  codex429WaitMs,
  createCodexAdapter,
} from "../../src/providers/integrations/codex/codex";

/**
 * The waits under test are real-world sized (tens of seconds by design), so the
 * clock is replaced for the duration of each test: the loop still runs its real
 * arithmetic, only the wall-clock pause is skipped. Restored afterwards so no
 * test can leak a fake clock into another file.
 */
const waited: number[] = [];
beforeEach(() => {
  waited.length = 0;
  _setCodexRateLimitSleepForTesting((ms: number, signal: AbortSignal) => {
    waited.push(ms);
    return signal.aborted ? Promise.reject(new Error("aborted")) : Promise.resolve();
  });
});
afterEach(() => {
  _setCodexRateLimitSleepForTesting(null);
});
import type { CanonicalRequest } from "../../src/protocol/canonical-model";
import type {
  ProviderDispatchContext,
  ProviderDispatchTarget,
  ValidatedOutboundFetch,
} from "../../src/providers/provider-contracts";

const TARGET: ProviderDispatchTarget = {
  provider_id: "codex",
  model_id: "gpt-5.6-luna",
  wire_family: "responses",
  endpoint_path: "/backend-api/codex/responses",
  capabilities: {},
};

function baseRequest(): CanonicalRequest {
  return {
    model: "gpt-5.6-luna",
    messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
    generation_controls: {},
    stream: true,
    source_surface: "responses",
  };
}

/** Fake JWT with a non-empty payload — Codex identity reads claims from it. */
const TOKEN = `header.${Buffer.from(
  JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_test" } }),
).toString("base64url")}.sig`;

function context(
  fetcher: ValidatedOutboundFetch,
  deadlineMs = 300_000,
): ProviderDispatchContext {
  return {
    credential: {
      provider_id: "codex",
      credential_kind: "oauth",
      secret: new TextEncoder().encode(TOKEN),
    },
    deadline: Date.now() + deadlineMs,
    abort_signal: new AbortController().signal,
    outbound_fetch: fetcher,
  };
}

/**
 * Records, for each outbound post, how long the loop had waited before it.
 *
 * The wait amounts are read from the injected sleep rather than the clock: the
 * sleeps are real-world sized (tens of seconds) and stubbing them makes any
 * wall-clock gap zero, so measuring elapsed time would assert nothing. What the
 * tests care about is the delay the loop COMPUTED, which is exactly what the
 * stub receives.
 */
function recordingFetch(
  respond: (attempt: number) => Response,
): { fetcher: ValidatedOutboundFetch; gaps: number[]; count: () => number } {
  const gaps: number[] = [];
  const fetcher = (async (): Promise<Response> => {
    gaps.push(waited.length > 0 ? waited[waited.length - 1]! : 0);
    return respond(gaps.length);
  }) as unknown as ValidatedOutboundFetch;
  return { fetcher, gaps, count: () => gaps.length };
}

function sseOk(): Response {
  return new Response(
    [
      'data: {"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":"ok"}]}}',
      'data: {"type":"response.completed","response":{"status":"completed"}}',
      "data: [DONE]",
      "",
    ].join("\n\n"),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

/** A 429 that states its own delay in `retry-after` seconds. */
function tooManyRequests(headers: Record<string, string> = {}): Response {
  return new Response(
    JSON.stringify({ error: { code: "rate_limit_exceeded", message: "slow down" } }),
    { status: 429, headers: { "content-type": "application/json", ...headers } },
  );
}

function adapter() {
  return createCodexAdapter({
    provider_id: "codex",
    installation_id_override: "test-install",
  });
}

/** Drives one dispatch to completion (or first throw), collecting events. */
async function dispatch(
  fetcher: ValidatedOutboundFetch,
  deadlineMs = 300_000,
): Promise<{ events: number; thrown: unknown }> {
  let events = 0;
  let thrown: unknown;
  try {
    for await (const _event of adapter().dispatch(
      baseRequest(),
      TARGET,
      context(fetcher, deadlineMs),
    ))
      events += 1;
  } catch (error: unknown) {
    thrown = error;
  }
  return { events, thrown };
}

// ─── A. A 429 with a server-stated delay becomes latency ────────────────────

describe("A1. the stated delay is honored", () => {
  test("waits the server delay and re-posts, returning the eventual success", async () => {
    const { fetcher, gaps } = recordingFetch((attempt) =>
      attempt === 1 ? tooManyRequests({ "retry-after": "1" }) : sseOk(),
    );

    const { events, thrown } = await dispatch(fetcher);

    expect(thrown).toBeUndefined();
    expect(events).toBeGreaterThan(0);
    expect(gaps.length).toBe(2);
    // The second post came after ~1s, not immediately and not a fixed fallback.
    expect(gaps[1]!).toBeGreaterThanOrEqual(950);
    expect(gaps[1]!).toBeLessThan(3_000);
  });

  test("honors retry-after-ms over retry-after when both are present", async () => {
    const { fetcher, gaps } = recordingFetch((attempt) =>
      attempt === 1
        ? tooManyRequests({ "retry-after": "60", "retry-after-ms": "300" })
        : sseOk(),
    );

    await dispatch(fetcher);

    expect(gaps.length).toBe(2);
    // 300ms, not the 60s the classic header stated.
    expect(gaps[1]!).toBeGreaterThanOrEqual(280);
    expect(gaps[1]!).toBeLessThan(3_000);
  });

  test("falls back to an x-codex window header when no backoff header is sent", async () => {
    // `x-codex-primary-reset-at` is an epoch-seconds stamp, so a `+1s` header
    // can land anywhere in (0, 1000] ms of remaining wait once the second
    // boundary is crossed. Assert only that the window was read and honored —
    // the exact clamp arithmetic is pinned in section D on the pure planner.
    const resetAt = Math.floor(Date.now() / 1000) + 2;
    const { fetcher, gaps } = recordingFetch((attempt) =>
      attempt === 1 ? tooManyRequests({ "x-codex-primary-reset-at": String(resetAt) }) : sseOk(),
    );

    await dispatch(fetcher);

    expect(gaps.length).toBe(2);
    expect(gaps[1]!).toBeGreaterThanOrEqual(900);
    expect(gaps[1]!).toBeLessThan(4_000);
  });

  test("keeps waiting across several 429s while the budget allows", async () => {
    const { fetcher, gaps } = recordingFetch((attempt) =>
      attempt <= 3 ? tooManyRequests({ "retry-after-ms": "120" }) : sseOk(),
    );

    const { thrown } = await dispatch(fetcher);

    expect(thrown).toBeUndefined();
    expect(gaps.length).toBe(4);
    for (const gap of gaps.slice(1)) {
      expect(gap).toBeGreaterThanOrEqual(100);
      expect(gap).toBeLessThan(3_000);
    }
  });
});

// ─── B. The wait is bounded ────────────────────────────────────────────────

describe("B1. one wait is capped", () => {
  test("a huge stated delay is clamped to the per-wait cap", () => {
    const now = Date.now();
    const wait = codex429WaitMs({
      serverDelayMs: 600_000,
      waitedMs: 0,
      retry: 0,
      deadline: now + 3_600_000,
      now,
    });
    // 600s requested, 60s cap honored.
    expect(wait).toBe(60_000);
  });
});

describe("B2. the total wait is bounded by the budget", () => {
  test("the budget, not the server, decides when waiting stops", () => {
    const now = Date.now();
    const deadline = now + 3_600_000;
    // 299_000 ms already spent of the 300_000 ms budget: 1_000 ms left.
    expect(
      codex429WaitMs({ serverDelayMs: 60_000, waitedMs: 299_000, retry: 9, deadline, now }),
    ).toBe(1_000);
    // Budget fully spent: stop waiting, whatever the server says.
    expect(
      codex429WaitMs({ serverDelayMs: 1_000, waitedMs: 300_000, retry: 10, deadline, now }),
    ).toBeNull();
  });

  test("the loop terminates when the server keeps restating a delay", async () => {
    // Integration shape only: every response restates 30s, so the real budget
    // would burn minutes. Drain it fast by keeping the deadline short instead —
    // the deadline clamp is what makes this terminate, and it is pinned in B3.
    const { fetcher, gaps } = recordingFetch(() => tooManyRequests({ "retry-after": "30" }));

    const { thrown } = await dispatch(fetcher, 16_000);

    expect((thrown as { status?: number } | undefined)?.status).toBe(429);
    expect(gaps.length).toBeGreaterThanOrEqual(1);
  });
});

describe("B3. the deadline always wins", () => {
  test("no re-post when less than the retry floor remains", async () => {
    const { fetcher, gaps } = recordingFetch(() => tooManyRequests({ "retry-after": "30" }));

    // Deadline leaves ~5s: below the 15s retry floor, so the 429 is terminal.
    const { thrown } = await dispatch(fetcher, 5_000);

    expect((thrown as { status?: number } | undefined)?.status).toBe(429);
    expect(gaps.length).toBe(1);
    expect(gaps[0]!).toBeLessThan(100);
  });

  test("a stated delay longer than the remaining budget is clamped to it", async () => {
    const { fetcher, gaps } = recordingFetch((attempt) =>
      attempt === 1 ? tooManyRequests({ "retry-after": "30" }) : sseOk(),
    );

    // 20s left: above the 15s floor, so one wait is allowed but must leave the
    // floor intact — 20s - 15s = 5s, not the 30s the server stated.
    const { thrown } = await dispatch(fetcher, 20_000);

    expect(thrown).toBeUndefined();
    expect(gaps.length).toBe(2);
    expect(gaps[1]!).toBeGreaterThanOrEqual(4_000);
    expect(gaps[1]!).toBeLessThan(8_000);
  });

  test("an already-expired deadline posts once and surfaces the 429", async () => {
    const { fetcher, gaps } = recordingFetch(() => tooManyRequests({ "retry-after": "1" }));

    const { thrown } = await dispatch(fetcher, 0);

    expect((thrown as { status?: number } | undefined)?.status).toBe(429);
    expect(gaps.length).toBe(1);
  });
});

// ─── C. Everything else is unaffected ──────────────────────────────────────

describe("C1. non-429 failures are untouched", () => {
  for (const status of [400, 401, 403, 404, 500, 503]) {
    test(`HTTP ${status} posts once with no wait`, async () => {
      const { fetcher, gaps } = recordingFetch(() =>
        new Response(JSON.stringify({ error: { message: "nope" } }), {
          status,
          headers: { "content-type": "application/json", "retry-after": "1" },
        }),
      );

      const { thrown } = await dispatch(fetcher);

      expect((thrown as { status?: number } | undefined)?.status).toBe(status);
      expect(gaps.length).toBe(1);
    });
  }

  test("a 429 with no stated delay and no window header does not loop", async () => {
    // Unconfirmed posture: a bare 429 gets one short backoff on the first
    // response, then stops. It must terminate, not spin.
    const { fetcher, gaps } = recordingFetch(() => tooManyRequests());

    const { thrown } = await dispatch(fetcher);

    expect((thrown as { status?: number } | undefined)?.status).toBe(429);
    expect(gaps.length).toBeLessThanOrEqual(2);
  });

  test("a successful first response is never delayed", async () => {
    const { fetcher, gaps } = recordingFetch(() => sseOk());

    const { events, thrown } = await dispatch(fetcher);

    expect(thrown).toBeUndefined();
    expect(events).toBeGreaterThan(0);
    expect(gaps.length).toBe(1);
  });
});

describe("C2. the retried request is otherwise unchanged", () => {
  test("the re-post carries the same session key", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetcher = (async (
      _url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return bodies.length === 1 ? tooManyRequests({ "retry-after-ms": "100" }) : sseOk();
    }) as unknown as ValidatedOutboundFetch;

    await dispatch(fetcher);

    expect(bodies.length).toBe(2);
    expect(bodies[1]?.["prompt_cache_key"]).toBe(bodies[0]?.["prompt_cache_key"]);
    expect(bodies[1]?.["model"]).toBe(bodies[0]?.["model"]);
  });

  test("a client abort during the wait surfaces the 429 rather than hanging", async () => {
    const controller = new AbortController();
    const fetcher = (async (): Promise<Response> => {
      // The wait starts after the first 429; cancel while it is in flight.
      setTimeout(() => controller.abort(), 50);
      return tooManyRequests({ "retry-after-ms": "2_000" });
    }) as unknown as ValidatedOutboundFetch;

    let thrown: unknown;
    try {
      for await (const _event of adapter().dispatch(baseRequest(), TARGET, {
        credential: {
          provider_id: "codex",
          credential_kind: "oauth",
          secret: new TextEncoder().encode(TOKEN),
        },
        deadline: Date.now() + 300_000,
        abort_signal: controller.signal,
        outbound_fetch: fetcher,
      }))
        void _event;
    } catch (error: unknown) {
      thrown = error;
    }

    expect((thrown as { status?: number } | undefined)?.status).toBe(429);
  });
});

// ─── D. The planner's clamps, without running the clock ─────────────────────
//
// The integration tests above can only use short delays — a 5-minute budget or
// a 60s per-wait cap would blow the test timeout. These pin the arithmetic
// that those tests cannot reach.

describe("D1. codex429WaitMs clamps", () => {
  const NOW = 1_000_000_000_000;
  const FAR = NOW + 3_600_000; // an hour out: neither clamp binds

  test("honors a stated delay in full when nothing else binds", () => {
    expect(
      codex429WaitMs({ serverDelayMs: 1_200, waitedMs: 0, retry: 0, deadline: FAR, now: NOW }),
    ).toBe(1_200);
  });

  test("caps one wait at 60s however long the server asked for", () => {
    expect(
      codex429WaitMs({ serverDelayMs: 3_600_000, waitedMs: 0, retry: 0, deadline: FAR, now: NOW }),
    ).toBe(60_000);
  });

  test("reserves the retry floor out of the deadline", () => {
    // 20s to deadline, 15s floor: at most 5s may be spent waiting.
    expect(
      codex429WaitMs({
        serverDelayMs: 30_000,
        waitedMs: 0,
        retry: 0,
        deadline: NOW + 20_000,
        now: NOW,
      }),
    ).toBe(5_000);
  });

  test("refuses to wait at all when the floor itself is gone", () => {
    expect(
      codex429WaitMs({
        serverDelayMs: 1_000,
        waitedMs: 0,
        retry: 0,
        deadline: NOW + 15_000,
        now: NOW,
      }),
    ).toBeNull();
    expect(
      codex429WaitMs({
        serverDelayMs: 1_000,
        waitedMs: 0,
        retry: 0,
        deadline: NOW,
        now: NOW,
      }),
    ).toBeNull();
  });

  test("accumulated waits draw down the same budget", () => {
    const deadline = NOW + 3_600_000;
    expect(
      codex429WaitMs({ serverDelayMs: 60_000, waitedMs: 290_000, retry: 5, deadline, now: NOW }),
    ).toBe(10_000);
    expect(
      codex429WaitMs({ serverDelayMs: 60_000, waitedMs: 300_000, retry: 6, deadline, now: NOW }),
    ).toBeNull();
  });

  test("a bare 429 gets one short backoff, then stops", () => {
    // No stated delay at all: the first retry still gets a minimal backoff...
    expect(
      codex429WaitMs({ serverDelayMs: null, waitedMs: 0, retry: 0, deadline: FAR, now: NOW }),
    ).toBe(50);
    // ...and nothing after it, so an uninformative 429 cannot spin.
    expect(
      codex429WaitMs({ serverDelayMs: null, waitedMs: 50, retry: 1, deadline: FAR, now: NOW }),
    ).toBeNull();
  });

  test("the smallest clamp wins when several bind at once", () => {
    // Budget leaves 2s, deadline leaves 4s, server asks 10s → 2s.
    expect(
      codex429WaitMs({
        serverDelayMs: 10_000,
        waitedMs: 298_000,
        retry: 5,
        deadline: NOW + 19_000,
        now: NOW,
      }),
    ).toBe(2_000);
  });

  test("never returns zero or negative", () => {
    const wait = codex429WaitMs({
      serverDelayMs: 1,
      waitedMs: 299_999,
      retry: 5,
      deadline: NOW + 15_001,
      now: NOW,
    });
    expect(wait === null || wait > 0).toBe(true);
  });
});
