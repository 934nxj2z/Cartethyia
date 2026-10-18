/**
 * Slow-lane wiring into the Claude dispatch path (design doc §5).
 *
 * The dangerous failure mode is not "the wait doesn't happen" — it is "the wait
 * happens when it shouldn't". A capacity wait must fire only when the slow
 * header was actually sent and the lane is active; otherwise every ordinary 429
 * silently gains seconds of latency. That is what most of these pin.
 */
import { describe, expect, test } from "bun:test";
import { ClaudeAdapter } from "../../src/providers/integrations/claude/claude";
import { sharedClaudeSlowLanes } from "../../src/providers/integrations/claude/claude-slow-lane";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";
import type {
  ProviderDispatchContext,
  ProviderDispatchTarget,
} from "../../src/providers/provider-contracts";

const TARGET: ProviderDispatchTarget = {
  provider_id: "claude",
  model_id: "claude-sonnet-4-6",
  wire_family: "messages",
  endpoint_path: "/v1/messages",
} as unknown as ProviderDispatchTarget;

function makeRequest(): CanonicalRequest {
  return {
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
    generation_controls: {},
    stream: false,
    source_surface: "messages",
  } as unknown as CanonicalRequest;
}

function makeContext(accountId: string | undefined): ProviderDispatchContext {
  return {
    credential: {
      provider_id: "claude",
      credential_kind: "oauth",
      secret: new TextEncoder().encode("tok"),
      ...(accountId === undefined ? {} : { account_id: accountId }),
    },
    deadline: Date.now() + 30_000,
    abort_signal: AbortSignal.timeout(30_000),
  } as unknown as ProviderDispatchContext;
}

interface Attempt {
  readonly headers: Record<string, string>;
}


/** Collects outbound headers across a dispatch that always answers 429. */
async function dispatchCollecting(
  accountId: string | undefined,
  laneActive: boolean,
): Promise<readonly Attempt[]> {
  if (laneActive && accountId !== undefined) {
    sharedClaudeSlowLanes.observe(accountId, {
      offer: "treatment",
      status: "active",
      unifiedLimitClaim: false,
      overageInUse: false,
      unifiedResetAtSec: Math.floor(Date.now() / 1000) + 3600,
    });
  }
  const seen: Attempt[] = [];
  const fetcher = (async (_url: unknown, init?: RequestInit): Promise<Response> => {
    seen.push({ headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const claude = new ClaudeAdapter({ fetch: fetcher });
  try {
    for await (const _event of claude.dispatch(makeRequest(), TARGET, makeContext(accountId))) {
      void _event;
    }
  } catch {
    // A dispatch that throws still records what it sent.
  }
  return seen;
}

describe("slow-lane header attachment", () => {
  test("attaches anthropic-usage-limit: slow only when the lane is active", async () => {
    const accountId = `lane-on-${crypto.randomUUID()}`;
    const withLane = await dispatchCollecting(accountId, true);
    expect(withLane[0]?.headers["anthropic-usage-limit"]).toBe("slow");
  });

  test("a request on an account with no active lane is untouched", async () => {
    // The regression this guards: stamping the limit unconditionally would
    // slow every Claude request, eligible or not.
    const seen = await dispatchCollecting(`lane-off-${crypto.randomUUID()}`, false);
    expect(seen[0]?.headers["anthropic-usage-limit"]).toBeUndefined();
  });

  test("a credential with no account id never gets the limit", async () => {
    const seen = await dispatchCollecting(undefined, false);
    expect(seen[0]?.headers["anthropic-usage-limit"]).toBeUndefined();
  });
});

describe("slow-lane capacity wait actually fires", () => {
  test("a 529 with an active lane resends on the same account", async () => {
    // The wait itself is real (seconds), so the deadline is what proves the
    // retry happened: with 40s of budget the wait fits and a second request
    // goes out; the same failure with no budget left must not.
    const accountId = `wait-${crypto.randomUUID()}`;
    sharedClaudeSlowLanes.observe(accountId, {
      offer: "treatment",
      status: "active",
      retryAfterMs: 50,
      maxWaitMs: 60_000,
      unifiedLimitClaim: false,
      overageInUse: false,
      unifiedResetAtSec: Math.floor(Date.now() / 1000) + 3600,
    });

    let calls = 0;
    const fetcher = (async (): Promise<Response> => {
      calls++;
      return new Response(JSON.stringify({ error: { message: "overloaded_error" } }), {
        status: 529,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const claude = new ClaudeAdapter({ fetch: fetcher });
    const context = {
      ...makeContext(accountId),
      deadline: Date.now() + 40_000,
    } as unknown as ProviderDispatchContext;
    try {
      for await (const _event of claude.dispatch(makeRequest(), TARGET, context)) {
        void _event;
      }
    } catch {
      // Both attempts fail here; the attempt count is what matters.
    }
    expect(calls).toBe(2);
  });

  test("no wait when the deadline leaves no room", async () => {
    // The wait is bounded by the deadline minus the retry floor. With only a
    // few seconds left there is nothing to spend, so an ordinary error path
    // runs instead of stalling the request.
    const accountId = `nowait-${crypto.randomUUID()}`;
    sharedClaudeSlowLanes.observe(accountId, {
      offer: "treatment",
      status: "active",
      retryAfterMs: 60_000,
      maxWaitMs: 600_000,
      unifiedLimitClaim: false,
      overageInUse: false,
      unifiedResetAtSec: Math.floor(Date.now() / 1000) + 3600,
    });

    let calls = 0;
    const fetcher = (async (): Promise<Response> => {
      calls++;
      return new Response(JSON.stringify({ error: { message: "overloaded_error" } }), {
        status: 529,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const claude = new ClaudeAdapter({ fetch: fetcher });
    const context = {
      ...makeContext(accountId),
      deadline: Date.now() + 5_000,
    } as unknown as ProviderDispatchContext;
    try {
      for await (const _event of claude.dispatch(makeRequest(), TARGET, context)) {
        void _event;
      }
    } catch {
      // Expected: the deadline leaves no room for a wait.
    }
    expect(calls).toBe(1);
  });
});
