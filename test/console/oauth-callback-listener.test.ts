import { describe, expect, test } from "bun:test";
import { OAuthCallbackListener } from "../../src/console/providers/oauth/callback-listener";

/**
 * The listener binds a real port, so `serve` is stubbed: these tests are about
 * what the handler decides, not about Bun's socket behaviour.
 */
function harness() {
  const completions: { providerId: string; code: string; state: string }[] = [];
  let handler: ((request: Request) => Response | Promise<Response>) | undefined;
  const listener = new OAuthCallbackListener({
    completer: {
      async complete(providerId, code, state) {
        completions.push({ providerId, code, state });
        return { ok: true, message: "done" };
      },
    },
    serve: (options) => {
      handler = options.fetch;
      return { stop() {} };
    },
  });
  const request = async (query: string): Promise<Response> => {
    if (handler === undefined) throw new Error("listener never bound");
    return await handler(new Request(`http://127.0.0.1:1455/callback${query}`));
  };
  return { listener, request, completions };
}

describe("OAuth callback listener", () => {
  test("a callback carrying `code` completes the flow", async () => {
    const { listener, request, completions } = harness();
    listener.register("http://127.0.0.1:1455/callback", "openrouter", "state-1");
    const response = await request("?code=abc&state=state-1");
    expect(response.status).toBe(200);
    expect(completions).toEqual([{ providerId: "openrouter", code: "abc", state: "state-1" }]);
  });

  test("a callback that carries its payload instead of a code is not rejected", async () => {
    // Trae's page redirects with the refresh token already in the query and no
    // `code` at all. Rejecting that here left the operator with "Missing
    // authorization code" after a login that had in fact succeeded.
    const { listener, request, completions } = harness();
    listener.register("http://127.0.0.1:1455/callback", "trae", "state-2");
    const response = await request("?isRedirect=true&refreshToken=rt-1&loginHost=www.trae.ai");
    expect(response.status).toBe(200);
    expect(completions).toHaveLength(1);
    expect(completions[0]?.providerId).toBe("trae");
    expect(completions[0]?.code).toBe("isRedirect=true&refreshToken=rt-1&loginHost=www.trae.ai");
  });

  test("an empty callback is still refused", async () => {
    const { listener, request, completions } = harness();
    listener.register("http://127.0.0.1:1455/callback", "trae", "state-3");
    const response = await request("");
    expect(response.status).toBe(400);
    expect(completions).toHaveLength(0);
  });
});
