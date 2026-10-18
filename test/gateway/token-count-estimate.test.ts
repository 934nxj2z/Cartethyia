/**
 * `POST /v1/messages/count_tokens` on a route that has no counter.
 *
 * Claude Code asks "does this context still fit" before a turn, and it asks it
 * for *whatever model is routed* — not only for Anthropic. A combo of
 * buddy-family chat rows has no `count_tokens` to forward to, and answering 400
 * there is answering a question the client did not ask: it wanted a number, and
 * a number is knowable locally.
 *
 * The two paths the route now has, and the boundary between them:
 *
 * - a Messages route still forwards, so the provider's own number wins;
 * - a route with no Messages row estimates instead of failing;
 * - an *unavailable* Messages route still reports its real 429/503 — a
 *   fabricated count would tell the client the context fits when no account is
 *   there to serve the turn that follows.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createTestGateway, type TestGateway } from "../helpers/gateway";
import { createWorld, type GatewayWorld } from "../helpers/fixtures";
import { dbDescribe } from "../helpers/database";

/** A Messages count body: model plus the turns to price. */
function countBody(model: string): Record<string, unknown> {
  return { model, messages: [{ role: "user", content: "hello world" }] };
}

dbDescribe("count_tokens on a route without a counter", () => {
  let gateway: TestGateway;
  let world: GatewayWorld;
  /** A chat-family provider: no `count_tokens` endpoint anywhere on it. */
  let chat: { providerId: string; modelId: string; accountId: string };
  /** A Messages-family provider: the counter is forwarded to it. */
  let messages: { providerId: string; modelId: string; accountId: string };

  beforeAll(async () => {
    world = await createWorld();
    gateway = await createTestGateway();
    chat = await world.addProvider({
      modelId: "deepseek-v4.1-flash",
      modelOptions: { wireFamily: "chat", endpointPath: "/v1/chat/completions" },
    });
    messages = await world.addProvider({
      modelId: "claude-sonnet-4-6",
      modelOptions: { wireFamily: "messages", endpointPath: "/v1/messages" },
    });
  });

  afterAll(async () => {
    await gateway?.close();
    await world?.cleanup();
  });

  test("a chat-only route answers an estimate instead of failing", async () => {
    gateway.setRoutes([
      {
        providerId: chat.providerId,
        modelId: chat.modelId,
        accountId: chat.accountId,
      },
    ]);
    const adapter = gateway.adapter(chat.providerId);
    const response = await gateway.json("/v1/messages/count_tokens", countBody(chat.modelId), {
      token: world.token,
    });
    // The reported failure: this used to be a 400 capability_unsupported.
    expect(response.status).toBe(200);
    const body = (await response.json()) as { input_tokens: number };
    expect(body.input_tokens).toBe(3);
    expect(adapter.dispatches).toEqual([]);
  });

  test("a Messages route still forwards, so the provider's own number wins", async () => {
    gateway.setRoutes([
      {
        providerId: messages.providerId,
        modelId: messages.modelId,
        accountId: messages.accountId,
        wireFamily: "messages",
      },
    ]);
    const adapter = gateway.adapter(messages.providerId);
    const response = await gateway.json("/v1/messages/count_tokens", countBody(messages.modelId), {
      token: world.token,
    });
    // Proof this took the forward path and not the estimate: the stub adapter
    // has no native-service dispatch, so forwarding reports the provider-level
    // refusal. An estimate would have answered 200 with a number.
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("capability_unsupported");
    expect(body.error.message).toContain("token counting is unavailable");
    expect(adapter.dispatches).toEqual([]);
  });

  test("a count still requires messages and a model", async () => {
    gateway.setRoutes([
      {
        providerId: chat.providerId,
        modelId: chat.modelId,
        accountId: chat.accountId,
      },
    ]);
    const response = await gateway.json("/v1/messages/count_tokens", { model: chat.modelId }, {
      token: world.token,
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_request");
  });
});
