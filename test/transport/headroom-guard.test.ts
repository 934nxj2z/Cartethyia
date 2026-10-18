/**
 * The memory-headroom shed guard.
 *
 * A box that runs out of memory is OOM-killed, and because the SPA is served by
 * the same process, the dashboard dies with it — the operator is left with no
 * console to explain what happened. This guard refuses a *gateway* request with
 * 503 before that point, so the console and static surfaces keep being served
 * while gateway load is shed.
 *
 * These lock the two halves: a proxy request sheds with the documented code and
 * a retry hint, and everything that is not a `/v1` gateway request is exempt.
 */
import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { createHeadroomGuard } from "../../src/transport/guards/headroom-guard";
import { createErrorNormalizationMiddleware } from "../../src/transport/guards/error-lifecycle";
import { ProxyRequestStateStore } from "../../src/transport/request/state";

/**
 * Builds an app where the guard's predicate trips deterministically: a
 * `minFreeBytes` far larger than any real box's total memory makes
 * `rss + minFreeBytes > totalmem()` always true, independent of the machine.
 */
function trippedApp() {
  const stateStore = new ProxyRequestStateStore(undefined);
  return new Elysia()
    .use(createErrorNormalizationMiddleware({ stateStore }))
    .use(createHeadroomGuard({ store: stateStore, minFreeBytes: Number.MAX_SAFE_INTEGER }))
    .post("/v1/chat/completions", () => new Response("gateway", { status: 200 }))
    .get("/console", () => new Response("console", { status: 200 }))
    .get("/share/token", () => new Response("share", { status: 200 }))
    .get("/health", () => new Response("ok", { status: 200 }));
}

/** An app where the predicate never trips, to prove the guard is inert. */
function openApp() {
  const stateStore = new ProxyRequestStateStore(undefined);
  return new Elysia()
    .use(createErrorNormalizationMiddleware({ stateStore }))
    .use(createHeadroomGuard({ store: stateStore, minFreeBytes: 0 }))
    .post("/v1/chat/completions", () => new Response("gateway", { status: 200 }))
    .get("/console", () => new Response("console", { status: 200 }));
}

describe("headroom guard — shedding", () => {
  test("a proxy request is refused with 503 overloaded and a retry hint", async () => {
    const response = await trippedApp().handle(
      new Request("https://gateway.test/v1/chat/completions", { method: "POST", body: "{}" }),
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as {
      error: { code: string; details: Record<string, unknown> };
    };
    expect(body.error.code).toBe("overloaded");
    // The hint tells the client to retry rather than fail permanently, and it
    // is the same number the `retry-after` header carries.
    expect(body.error.details.retryAfterMs).toBe(1_000);
    expect(response.headers.get("retry-after")).toBe("1");
  });

  test("the console, share pages, and health stay served while gateway load sheds", async () => {
    // The whole reason the guard exists: an operator must still reach the
    // console that explains the shedding, and a recipient must still see their
    // share page.
    const app = trippedApp();
    for (const path of ["/console", "/share/token", "/health"]) {
      const response = await app.handle(new Request(`https://gateway.test${path}`));
      expect(response.status, path).toBe(200);
    }
  });

  test("the guard is inert when headroom is sufficient", async () => {
    const response = await openApp().handle(
      new Request("https://gateway.test/v1/chat/completions", { method: "POST", body: "{}" }),
    );
    expect(response.status).toBe(200);
  });
});
