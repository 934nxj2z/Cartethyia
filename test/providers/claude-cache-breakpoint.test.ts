/**
 * Where the OAuth cache breakpoint lands in the system array.
 *
 * The reference client caches the *last* system block, not a fixed one. Pinning
 * the breakpoint on the Claude Code identity put it mid-prefix whenever the
 * caller supplied its own system prompt: the stable tail went uncached and the
 * request carried a fingerprint no real client produces. Both are regressions
 * with no visible symptom — the request still succeeds — so nothing else fails
 * if this drifts.
 */
import { describe, expect, test } from "bun:test";
import { ClaudeAdapter } from "../../src/providers/integrations/claude/claude";
import { CLAUDE_CODE_SYSTEM_INSTRUCTION } from "../../src/providers/integrations/claude/claude-cch";
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

function makeRequest(systemPrompt?: string): CanonicalRequest {
  return {
    model: "claude-sonnet-4-6",
    // `system` is normalized content parts, not a bare string.
    ...(systemPrompt === undefined
      ? {}
      : { system: [{ kind: "text", text: systemPrompt }] }),
    messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
    generation_controls: {},
    stream: false,
    source_surface: "messages",
  } as unknown as CanonicalRequest;
}

function makeContext(): ProviderDispatchContext {
  return {
    credential: {
      provider_id: "claude",
      credential_kind: "oauth",
      secret: new TextEncoder().encode("tok"),
      account_id: `cache-breakpoint-${crypto.randomUUID()}`,
    },
    deadline: Date.now() + 30_000,
    abort_signal: AbortSignal.timeout(30_000),
  } as unknown as ProviderDispatchContext;
}

interface SystemBlock {
  readonly text?: string;
  readonly cache_control?: unknown;
}

/** Captures the serialized `system` array of the one request dispatched. */
async function dispatchedSystem(systemPrompt?: string): Promise<readonly SystemBlock[]> {
  let captured: readonly SystemBlock[] = [];
  const fetcher = (async (_url: unknown, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { system?: SystemBlock[] };
    captured = body.system ?? [];
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const claude = new ClaudeAdapter({ fetch: fetcher });
  try {
    for await (const _event of claude.dispatch(makeRequest(systemPrompt), TARGET, makeContext())) {
      void _event;
    }
  } catch {
    // A dispatch that throws still records what it sent.
  }
  return captured;
}

describe("Claude Code system block assembly", () => {
  test("billing leads and carries no breakpoint", async () => {
    const system = await dispatchedSystem("Stay concise.");
    expect(system[0]?.text?.startsWith("x-anthropic-billing-header:")).toBe(true);
    // Billing varies per request; caching it would miss every time.
    expect(system[0]?.cache_control).toBeUndefined();
  });

  test("the identity block is not breakpointed when the caller supplies system", async () => {
    const system = await dispatchedSystem("Stay concise.");
    const identity = system.find((block) => block.text === CLAUDE_CODE_SYSTEM_INSTRUCTION);
    expect(identity).toBeDefined();
    expect(identity?.cache_control).toBeUndefined();
  });

  test("the breakpoint rides the last system block", async () => {
    const system = await dispatchedSystem("Stay concise.");
    const last = system[system.length - 1];
    expect(last?.text).toBe("Stay concise.");
    expect(last?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  test("with no caller system the identity itself is cached", async () => {
    const system = await dispatchedSystem();
    // Billing + identity, nothing else: the identity is the tail.
    expect(system).toHaveLength(2);
    expect(system[1]?.text).toBe(CLAUDE_CODE_SYSTEM_INSTRUCTION);
    expect(system[1]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });
});
