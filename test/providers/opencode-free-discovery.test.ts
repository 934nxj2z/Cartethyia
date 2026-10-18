/**
 * The OpenCode free discovery classifies a System One id, and it must use the
 * decision endpoint's own limits while doing so.
 *
 * `/zen/v1/models` publishes only `{id, object, created, owned_by}` — no limits
 * at all — so every row's limits come from the packed catalog. `jev-1.13-free`
 * is absent from every upstream catalog (models.dev and models.opencode.ai both
 * omit the `jev` family), so it fell all the way through to the chat default:
 * 200k in, 64_192 out, advertised for an endpoint that answers decision
 * questions with 8_192-token answers. The catalog cannot fix an id it does not
 * carry, so the row has to carry its own limits — the same ones its static
 * `systemoneZen` declaration already states.
 */
import { describe, expect, test } from "bun:test";
import { discoverOpenCodeFreeModels } from "../../src/providers/integrations/opencode/provider";

const LISTING = {
  data: [
    { id: "jev-1.13-free", object: "model", created: 1, owned_by: "opencode" },
    { id: "beam-free", object: "model", created: 1, owned_by: "opencode" },
    { id: "some-paid-model", object: "model", created: 1, owned_by: "opencode" },
  ],
};

function stubFetcher(): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(LISTING), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("OpenCode free discovery limits", () => {
  test("a System One id carries the decision endpoint's limits, not the chat default", async () => {
    const rows = await discoverOpenCodeFreeModels({
      baseUrl: "https://opencode.ai/zen/v1",
      fetcher: stubFetcher(),
    });
    const systemone = rows?.find((row) => row.modelId === "jev-1.13-free");
    expect(systemone?.serviceKind).toBe("systemone");
    expect(systemone?.endpointPath).toBe("/inference/v1/systemone");
    expect(systemone?.contextLimit).toBe(200_000);
    expect(systemone?.outputLimit).toBe(8_192);
  });

  test("a chat id keeps its catalog limits and is not reclassified", async () => {
    const rows = await discoverOpenCodeFreeModels({
      baseUrl: "https://opencode.ai/zen/v1",
      fetcher: stubFetcher(),
    });
    const chat = rows?.find((row) => row.modelId === "beam-free");
    // From `models.opencode.ai` via the packed catalog, not a default.
    expect(chat?.contextLimit).toBe(1_048_576);
    expect(chat?.outputLimit).toBe(131_072);
    expect(chat?.serviceKind).toBeUndefined();
  });

  test("a paid id is filtered out of the free tier", async () => {
    const rows = await discoverOpenCodeFreeModels({
      baseUrl: "https://opencode.ai/zen/v1",
      fetcher: stubFetcher(),
    });
    expect(rows?.some((row) => row.modelId === "some-paid-model")).toBe(false);
  });
});
