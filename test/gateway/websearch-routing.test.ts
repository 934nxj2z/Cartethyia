/**
 * The native search route (`POST /v1/search`).
 *
 * Search is a surface of its own, not an override layered on a chat turn: the
 * caller names a search model and a query and receives a normalized hit list.
 * Nothing in the chat pipeline executes a search on the caller's behalf — a
 * chat request is dispatched once, to the route the caller's model selects,
 * and whatever a hosted search declaration means is decided by that upstream.
 *
 * The contracts that matter to a client:
 *
 * - a declared search route answers `/v1/search` with normalized hits;
 * - failover advances to the next declared search route when one fails;
 * - a chat-row model is never a search route, and a chat turn is never
 *   re-dispatched to serve a search.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createTestGateway, type TestGateway } from "../helpers/gateway";
import { createWorld, type GatewayWorld } from "../helpers/fixtures";
import { dbDescribe } from "../helpers/database";

/** A search body in the shape the route documents: a search model and a query. */
function searchRequest(model: string, query = "siapa itu risuncode"): Record<string, unknown> {
  return { model, query, max_results: 5 };
}

/** A chat turn that declares Anthropic's hosted web-search tool. */
function messagesSearchRequest(model: string): Record<string, unknown> {
  return {
    model,
    max_tokens: 1024,
    stream: false,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    messages: [{ role: "user", content: "Coba cari siapa itu risuncode" }],
  };
}

dbDescribe("native search route", () => {
  let gateway: TestGateway;
  let world: GatewayWorld;
  /** Two declared search routes, each with its own provider and account rows. */
  let first: { providerId: string; modelId: string; accountId: string };
  let second: { providerId: string; modelId: string; accountId: string };
  /** A combo name that plans both search routes, so failover is observable. */
  const SEARCH_SET = "searchset";

  beforeAll(async () => {
    world = await createWorld();
    gateway = await createTestGateway();
    first = await world.addProvider({
      modelId: "search-a",
      modelOptions: { serviceKind: "websearch", endpointPath: "/search" },
    });
    second = await world.addProvider({
      modelId: "search-b",
      modelOptions: { serviceKind: "websearch", endpointPath: "/search" },
    });
  });

  afterAll(async () => {
    await gateway?.close();
    await world?.cleanup();
  });

  /** Registers both declared search routes, plus the world's chat row when asked. */
  function searchRoutes(withChatRow = false): void {
    gateway.setRoutes(
      [
        ...(withChatRow
          ? [
              {
                providerId: world.providerId,
                modelId: world.modelId,
                accountId: world.accountId,
              },
            ]
          : []),
        {
          providerId: first.providerId,
          modelId: first.modelId,
          accountId: first.accountId,
          serviceKind: "websearch",
        },
        {
          providerId: second.providerId,
          modelId: second.modelId,
          accountId: second.accountId,
          serviceKind: "websearch",
        },
      ],
      {
        combos: {
          [world.tenantId]: {
            [SEARCH_SET]: {
              members: [
                `${first.providerId}/${first.modelId}`,
                `${second.providerId}/${second.modelId}`,
              ],
              strategy: "fallback",
            },
          },
        },
      },
    );
  }

  test("a declared search route answers with normalized hits", async () => {
    searchRoutes();
    const source = gateway.adapter(first.providerId, {
      searchResults: [
        { title: "risuncode", url: "https://example.com/risuncode", snippet: "Profile" },
      ],
    });
    const response = await gateway.json("/v1/search", searchRequest(SEARCH_SET), {
      token: world.token,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      provider: string;
      model: string;
      query: string;
      results: { title: string; url: string; snippet: string }[];
      total_results: number;
    };
    expect(body.provider).toBe(first.providerId);
    expect(body.model).toBe(first.modelId);
    expect(body.query).toBe("siapa itu risuncode");
    expect(body.results).toEqual([
      { title: "risuncode", url: "https://example.com/risuncode", snippet: "Profile" },
    ]);
    expect(body.total_results).toBe(1);
    expect(source.searches).toEqual(["siapa itu risuncode"]);
  });

  test("a failing search route advances to the next declared one", async () => {
    searchRoutes();
    gateway.adapter(first.providerId, {
      failSearchWith: () => new Error("first search unreachable"),
    });
    const fallback = gateway.adapter(second.providerId, {
      searchResults: [{ title: "next hit", url: "https://example.com/next", snippet: "Snippet" }],
    });
    const response = await gateway.json("/v1/search", searchRequest(SEARCH_SET), {
      token: world.token,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { provider: string };
    expect(body.provider).toBe(second.providerId);
    expect(fallback.searches).toEqual(["siapa itu risuncode"]);
  });

  test("a chat-row model is not a search route", async () => {
    gateway.setRoutes([
      {
        providerId: world.providerId,
        modelId: world.modelId,
        accountId: world.accountId,
      },
    ]);
    const response = await gateway.json(
      "/v1/search",
      searchRequest(world.qualifiedModel),
      { token: world.token },
    );
    // The row declares no `websearch` service, so the route finds no candidate
    // rather than dispatching a search body to a chat endpoint.
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("capability_unsupported");
  });

  test("a chat turn that declares a hosted search tool is dispatched once", async () => {
    searchRoutes(true);
    let attempts = 0;
    gateway.adapter(world.providerId, {
      onDispatch: () => {
        attempts += 1;
      },
      events: () => [
        { type: "message_start", sequence_number: 0, model: world.modelId },
        {
          type: "content_delta",
          sequence_number: 1,
          content: { kind: "text", text: "I have no browsing ability" },
        },
        { type: "terminal", sequence_number: 2, state: "complete", stop_reason: "stop" },
      ],
    });
    const searchAdapter = gateway.adapter(first.providerId, {
      searchResults: [{ title: "risuncode", url: "https://github.com/risunCode", snippet: "Profile" }],
    });
    const response = await gateway.json(
      "/v1/messages",
      messagesSearchRequest(world.qualifiedModel),
      { token: world.token },
    );
    expect(response.status).toBe(200);
    // No override: the declaration is forwarded and the turn is answered once.
    expect(attempts).toBe(1);
    expect(searchAdapter.searches).toEqual([]);
    const body = (await response.json()) as { content: { type: string; text?: string }[] };
    expect(body.content.some((block) => block.text?.includes("I have no browsing ability"))).toBe(true);
  });

  test("a chat turn is not searched on the caller's behalf", async () => {
    searchRoutes(true);
    gateway.adapter(world.providerId);
    const searchAdapter = gateway.adapter(first.providerId, {
      searchResults: [{ title: "risuncode", url: "https://github.com/risunCode", snippet: "Profile" }],
    });
    const response = await gateway.json(
      "/v1/messages",
      messagesSearchRequest(world.qualifiedModel),
      { token: world.token },
    );
    expect(response.status).toBe(200);
    expect(searchAdapter.searches).toEqual([]);
  });
});
