/**
 * Daybreak `access_programs.cyber` (research item Codex #3) and the
 * Responses-Lite body contract (Codex #6).
 *
 * No network and no environment mutation: the Codex adapter is driven through
 * an injected `outbound_fetch`, and the payload builder is called directly.
 *
 * Every assertion about `access_programs` pins behavior that is gated behind
 * `provider_options.codex_access_programs_cyber` — see the UNCONFIRMED note in
 * `src/protocol/request/codex.ts`. The field is not sent by default precisely
 * because eligibility cannot be derived from local state.
 */
import { describe, expect, test } from "bun:test";
import { createCodexAdapter } from "../../src/providers/integrations/codex/codex";
import {
  applyCodexResponsesLiteShape,
  canonicalToCodexResponsesPayload,
  dropCodexAccessPrograms,
} from "../../src/protocol/request/codex";
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

function baseRequest(
  overrides: Partial<CanonicalRequest> = {},
): CanonicalRequest {
  return {
    model: "gpt-5.6-luna",
    messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
    generation_controls: {},
    stream: false,
    source_surface: "responses",
    ...overrides,
  };
}

/** Fake JWT with a non-empty payload — Codex identity reads claims from it. */
const TOKEN = `header.${Buffer.from(
  JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_test" } }),
).toString("base64url")}.sig`;

function context(fetcher: ValidatedOutboundFetch): ProviderDispatchContext {
  return {
    credential: {
      provider_id: "codex",
      credential_kind: "oauth",
      secret: new TextEncoder().encode(TOKEN),
    },
    deadline: Date.now() + 30_000,
    abort_signal: new AbortController().signal,
    outbound_fetch: fetcher,
  };
}

/** Collects every outbound body the adapter posts. */
function recordingFetch(
  respond: (attempt: number) => Response,
): { fetcher: ValidatedOutboundFetch; bodies: Array<Record<string, unknown>> } {
  const bodies: Array<Record<string, unknown>> = [];
  const fetcher = (async (
    _url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return respond(bodies.length);
  }) as unknown as ValidatedOutboundFetch;
  return { fetcher, bodies };
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

function rejection(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: { code, message: "denied" } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ─── A. access_programs.cyber ──────────────────────────────────────────────

describe("A1. access_programs.cyber is opt-in only", () => {
  test("absent unless the caller declares eligibility", () => {
    const payload = canonicalToCodexResponsesPayload(baseRequest());
    expect(payload).not.toHaveProperty("access_programs");
  });

  test("emitted as { cyber: true } when declared", () => {
    const payload = canonicalToCodexResponsesPayload(
      baseRequest({ provider_options: { codex_access_programs_cyber: true } }),
    );
    expect(payload["access_programs"]).toEqual({ cyber: true });
  });

  test("accepts the string form, matching provider_options JSON callers", () => {
    const payload = canonicalToCodexResponsesPayload(
      baseRequest({ provider_options: { codex_access_programs_cyber: "true" } }),
    );
    expect(payload["access_programs"]).toEqual({ cyber: true });
  });

  test("ignores any other declared value", () => {
    for (const value of [false, "false", "yes", 1, null]) {
      const payload = canonicalToCodexResponsesPayload(
        baseRequest({ provider_options: { codex_access_programs_cyber: value } }),
      );
      expect(payload).not.toHaveProperty("access_programs");
    }
  });

  test("survives the Responses-Lite reshape untouched", () => {
    const payload = canonicalToCodexResponsesPayload(
      baseRequest({
        provider_options: { codex_access_programs_cyber: true },
        tools: [{ name: "shell", jsonSchema: { type: "object" } }],
      }),
      { responsesLite: true },
    );
    expect(payload["access_programs"]).toEqual({ cyber: true });
  });
});

describe("A2. dropCodexAccessPrograms", () => {
  test("removes the field and reports the removal", () => {
    const payload = { model: "m", access_programs: { cyber: true } };
    expect(dropCodexAccessPrograms(payload)).toBe(true);
    expect(payload).not.toHaveProperty("access_programs");
  });

  test("reports false when there was nothing to drop", () => {
    const payload = { model: "m" };
    expect(dropCodexAccessPrograms(payload)).toBe(false);
    expect(payload).toEqual({ model: "m" });
  });
});

describe("A3. drop-on-rejection replay through the adapter", () => {
  test("replays once without the field when the upstream rejects the first attempt", async () => {
    const { fetcher, bodies } = recordingFetch((attempt) =>
      attempt === 1 ? rejection(400, "daybreak_access_denied") : sseOk(),
    );
    const adapter = createCodexAdapter({
      provider_id: "codex",
      installation_id_override: "test-install",
    });

    const events = [];
    for await (const event of adapter.dispatch(
      baseRequest({ provider_options: { codex_access_programs_cyber: true } }),
      TARGET,
      context(fetcher),
    ))
      events.push(event);

    expect(bodies.length).toBe(2);
    expect(bodies[0]?.["access_programs"]).toEqual({ cyber: true });
    expect(bodies[1]).not.toHaveProperty("access_programs");
    // The replay is otherwise identical — same session key, same model.
    expect(bodies[1]?.["model"]).toBe(bodies[0]?.["model"]);
    expect(bodies[1]?.["prompt_cache_key"]).toBe(bodies[0]?.["prompt_cache_key"]);
    expect(events.length).toBeGreaterThan(0);
  });

  test("does not replay when the request never carried the field", async () => {
    const { fetcher, bodies } = recordingFetch(() => rejection(400, "bad_request"));
    const adapter = createCodexAdapter({
      provider_id: "codex",
      installation_id_override: "test-install",
    });

    let thrown: unknown;
    try {
      for await (const _event of adapter.dispatch(baseRequest(), TARGET, context(fetcher)))
        void _event;
    } catch (error: unknown) {
      thrown = error;
    }

    expect(bodies.length).toBe(1);
    expect(thrown).toBeDefined();
  });

  test("replays at most once — an ineligible account hard-fails", async () => {
    const { fetcher, bodies } = recordingFetch(() =>
      rejection(403, "daybreak_access_denied"),
    );
    const adapter = createCodexAdapter({
      provider_id: "codex",
      installation_id_override: "test-install",
    });

    let status = 0;
    try {
      for await (const _event of adapter.dispatch(
        baseRequest({ provider_options: { codex_access_programs_cyber: true } }),
        TARGET,
        context(fetcher),
      ))
        void _event;
    } catch (error: unknown) {
      status = (error as { status?: number }).status ?? 0;
    }

    // One original + one replay, then the mapped upstream error surfaces.
    expect(bodies.length).toBe(2);
    expect(bodies[1]).not.toHaveProperty("access_programs");
    expect(status).toBe(403);
  });

  test("no replay on a successful first attempt", async () => {
    const { fetcher, bodies } = recordingFetch(() => sseOk());
    const adapter = createCodexAdapter({
      provider_id: "codex",
      installation_id_override: "test-install",
    });

    for await (const _event of adapter.dispatch(
      baseRequest({ provider_options: { codex_access_programs_cyber: true } }),
      TARGET,
      context(fetcher),
    ))
      void _event;

    expect(bodies.length).toBe(1);
    expect(bodies[0]?.["access_programs"]).toEqual({ cyber: true });
  });
});

// ─── B. Responses-Lite body shape ──────────────────────────────────────────
//
// Research item Codex #6 asked whether `applyCodexResponsesLiteShape` already
// covers both halves of the donor contract. It does — these tests pin the
// coverage so a future edit cannot silently drop either half.

describe("B1. Responses Lite moves tools into additional_tools", () => {
  test("hoists declared tools into a leading additional_tools developer item", () => {
    const payload = canonicalToCodexResponsesPayload(
      baseRequest({
        system: [{ kind: "text", text: "You are a router." }],
        tools: [
          { name: "shell", jsonSchema: { type: "object" } },
          { name: "read", jsonSchema: { type: "object" } },
        ],
      }),
      { responsesLite: true },
    );

    const input = payload["input"] as Array<Record<string, unknown>>;
    const hoisted = input[0];
    expect(hoisted?.["type"]).toBe("additional_tools");
    expect(hoisted?.["role"]).toBe("developer");
    expect((hoisted?.["tools"] as unknown[]).length).toBe(2);
    expect(payload).not.toHaveProperty("tools");
  });

  test("an empty tool list still yields the shaped item", () => {
    const body: Record<string, unknown> = { input: [{ type: "message" }] };
    applyCodexResponsesLiteShape(body);
    expect(body["tools"]).toBeUndefined();
    expect((body["input"] as Array<Record<string, unknown>>)[0]?.["type"]).toBe(
      "additional_tools",
    );
  });
});

describe("B2. Responses Lite folds instructions into input", () => {
  test("instructions become a leading developer message and the field is deleted", () => {
    const payload = canonicalToCodexResponsesPayload(
      baseRequest({ system: [{ kind: "text", text: "Be terse." }] }),
      { responsesLite: true },
    );

    expect(payload).not.toHaveProperty("instructions");
    const input = payload["input"] as Array<Record<string, unknown>>;
    const message = input.find((item) => item["type"] === "message");
    expect(message?.["role"]).toBe("developer");
    expect(message?.["content"]).toEqual([
      { type: "input_text", text: "Be terse." },
    ]);
  });

  test("the additional_tools item precedes the folded instructions", () => {
    const payload = canonicalToCodexResponsesPayload(
      baseRequest({
        system: [{ kind: "text", text: "Be terse." }],
        tools: [{ name: "shell", jsonSchema: { type: "object" } }],
      }),
      { responsesLite: true },
    );
    const input = payload["input"] as Array<Record<string, unknown>>;
    expect(input[0]?.["type"]).toBe("additional_tools");
    expect(input[1]?.["type"]).toBe("message");
  });

  test("omits the instructions item when there is no system content", () => {
    const payload = canonicalToCodexResponsesPayload(baseRequest(), {
      responsesLite: true,
    });
    const input = payload["input"] as Array<Record<string, unknown>>;
    expect(input.every((item) => item["type"] !== "message" || item["role"] !== "developer")).toBe(
      true,
    );
  });
});

describe("B3. Responses Lite side effects", () => {
  test("forces parallel_tool_calls false and keeps the all_turns override", () => {
    const payload = canonicalToCodexResponsesPayload(
      baseRequest({ reasoning: { effort: "medium", context: "current_turn" } }),
      { responsesLite: true },
    );
    expect(payload["parallel_tool_calls"]).toBe(false);
    expect((payload["reasoning"] as Record<string, unknown>)["context"]).toBe(
      "all_turns",
    );
  });

  test("hosted tool_choice downgrades to auto when no declared tool matches", () => {
    const payload = canonicalToCodexResponsesPayload(
      baseRequest({ tool_choice: { type: "tool", name: "shell" } }),
      { responsesLite: true },
    );
    expect(payload["tool_choice"]).toBe("auto");
  });

  test("a matching declared tool keeps tool_choice required and narrows the set", () => {
    const payload = canonicalToCodexResponsesPayload(
      baseRequest({
        tools: [
          { name: "shell", jsonSchema: { type: "object" } },
          { name: "read", jsonSchema: { type: "object" } },
        ],
        tool_choice: { type: "tool", name: "shell" },
      }),
      { responsesLite: true },
    );
    expect(payload["tool_choice"]).toBe("required");
    const hoisted = (payload["input"] as Array<Record<string, unknown>>)[0];
    const tools = hoisted?.["tools"] as Array<Record<string, unknown>>;
    expect(tools.length).toBe(1);
    expect(tools[0]?.["name"]).toBe("shell");
  });
});
