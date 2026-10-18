/**
 * Empty-stream replay + pre-start failover tests.
 *
 * All unit-level with injected fetch/drain/sleep; no network, no env mutation.
 */
import { describe, expect, test } from "bun:test";
import {
  fetchWithEmptyStreamRecovery,
  isEmptyStream,
  type DrainStream,
  type EmptyStreamFetch,
  type StreamTally,
} from "../../src/transport/dispatch/empty-stream";
import { GatewayError } from "../../src/protocol/gateway-error";

// ─── Test helpers ──────────────────────────────────────────────────────────

function makeSignal(): AbortSignal {
  return new AbortController().signal;
}

function makeFetch(responses: Response[]): EmptyStreamFetch {
  const calls: { url: string; body: string }[] = [];
  let index = 0;
  const fetch: EmptyStreamFetch = async (url, init) => {
    calls.push({ url, body: init.body });
    const response = responses[Math.min(index, responses.length - 1)]!;
    index++;
    return response;
  };
  (fetch as any).calls = calls;
  return fetch;
}

function makeDrain(tallies: StreamTally[]): DrainStream {
  let index = 0;
  return async () => {
    const tally = tallies[Math.min(index, tallies.length - 1)]!;
    index++;
    return tally;
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function emptyTally(): StreamTally {
  return { dataEvents: 0, meaningful: false, thoughtOnly: false };
}

function meaningfulTally(): StreamTally {
  return { dataEvents: 5, meaningful: true, thoughtOnly: false };
}

function thoughtOnlyTally(): StreamTally {
  return { dataEvents: 1, meaningful: false, thoughtOnly: true };
}

// ─── isEmptyStream ─────────────────────────────────────────────────────────

describe("isEmptyStream", () => {
  test("zero data events is empty", () => {
    expect(isEmptyStream({ dataEvents: 0, meaningful: false, thoughtOnly: false })).toBe(true);
  });

  test("data events with no meaningful content is empty", () => {
    expect(isEmptyStream({ dataEvents: 3, meaningful: false, thoughtOnly: false })).toBe(true);
  });

  test("data events with meaningful content is not empty", () => {
    expect(isEmptyStream({ dataEvents: 3, meaningful: true, thoughtOnly: false })).toBe(false);
  });

  test("thought-only tally is not empty (carve-out)", () => {
    expect(isEmptyStream({ dataEvents: 1, meaningful: false, thoughtOnly: true })).toBe(false);
  });
});

// ─── fetchWithEmptyStreamRecovery ──────────────────────────────────────────

describe("fetchWithEmptyStreamRecovery", () => {
  test("1. empty first response → replay → success with replaysUsed: 1", async () => {
    const fetch = makeFetch([
      jsonResponse({ content: "empty" }),
      jsonResponse({ content: "hello" }),
    ]);
    const drain = makeDrain([emptyTally(), meaningfulTally()]);
    const result = await fetchWithEmptyStreamRecovery(
      ["https://api.test/v1"],
      { headers: { "content-type": "application/json" }, body: '{"model":"test"}' },
      { fetch, drain, signal: makeSignal(), deadlineMs: Date.now() + 60_000 },
    );
    expect(result.replaysUsed).toBe(1);
    expect(result.endpoint).toBe("https://api.test/v1");
    expect(result.tally.meaningful).toBe(true);
    expect((fetch as any).calls.length).toBe(2);
    // Byte-identical replay
    expect((fetch as any).calls[0].body).toBe((fetch as any).calls[1].body);
  });

  test("2. all replays empty → throws GatewayError platform_unavailable/502/upstream", async () => {
    const fetch = makeFetch([jsonResponse({ content: "empty" })]);
    const drain = makeDrain([emptyTally()]);
    try {
      await fetchWithEmptyStreamRecovery(
        ["https://api.test/v1"],
        { headers: {}, body: "{}" },
        { fetch, drain, signal: makeSignal(), deadlineMs: Date.now() + 60_000 },
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayError);
      const ge = error as GatewayError;
      expect(ge.code).toBe("platform_unavailable");
      expect(ge.status).toBe(502);
      expect(ge.origin).toBe("upstream");
    }
  });

  test("3. first endpoint empty through budget → second endpoint succeeds", async () => {
    // First endpoint returns empty for all 3 fetches (initial + 2 replays),
    // second endpoint returns meaningful on its first fetch.
    const fetch = makeFetch([
      jsonResponse({ content: "empty" }),
      jsonResponse({ content: "empty" }),
      jsonResponse({ content: "empty" }),
      jsonResponse({ content: "hello" }),
    ]);
    const drain = makeDrain([
      emptyTally(),
      emptyTally(),
      emptyTally(),
      meaningfulTally(),
    ]);
    const result = await fetchWithEmptyStreamRecovery(
      ["https://api.test/v1", "https://api.test/v2"],
      { headers: {}, body: "{}" },
      { fetch, drain, signal: makeSignal(), deadlineMs: Date.now() + 60_000 },
    );
    expect(result.endpoint).toBe("https://api.test/v2");
    expect(result.replaysUsed).toBe(0);
  });

  test("5. meaningful first response → fetch called exactly once", async () => {
    const fetch = makeFetch([jsonResponse({ content: "hello" })]);
    const drain = makeDrain([meaningfulTally()]);
    const result = await fetchWithEmptyStreamRecovery(
      ["https://api.test/v1"],
      { headers: {}, body: "{}" },
      { fetch, drain, signal: makeSignal(), deadlineMs: Date.now() + 60_000 },
    );
    expect(result.replaysUsed).toBe(0);
    expect((fetch as any).calls.length).toBe(1);
  });

  test("6. thought-only STOP → no replay, returns tally as-is", async () => {
    const fetch = makeFetch([jsonResponse({ thought: "done" })]);
    const drain = makeDrain([thoughtOnlyTally()]);
    const result = await fetchWithEmptyStreamRecovery(
      ["https://api.test/v1"],
      { headers: {}, body: "{}" },
      { fetch, drain, signal: makeSignal(), deadlineMs: Date.now() + 60_000 },
    );
    expect(result.replaysUsed).toBe(0);
    expect(result.tally.thoughtOnly).toBe(true);
    expect((fetch as any).calls.length).toBe(1);
  });

  test("7. abort during backoff → rejects with transport_closed", async () => {
    const controller = new AbortController();
    const fetch = makeFetch([
      jsonResponse({ content: "empty" }),
      jsonResponse({ content: "hello" }),
    ]);
    const drain = makeDrain([emptyTally(), meaningfulTally()]);
    let callCount = 0;
    const sleep = async () => {
      callCount++;
      if (callCount === 1) {
        controller.abort();
        throw new GatewayError("transport_closed", 499, "Aborted");
      }
    };
    try {
      await fetchWithEmptyStreamRecovery(
        ["https://api.test/v1"],
        { headers: {}, body: "{}" },
        { fetch, drain, signal: controller.signal, deadlineMs: Date.now() + 60_000, policy: { sleep } },
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayError);
      expect((error as GatewayError).code).toBe("transport_closed");
    }
  });

  test("deadline exhausted → throws before replay", async () => {
    const fetch = makeFetch([jsonResponse({ content: "empty" })]);
    const drain = makeDrain([emptyTally()]);
    try {
      await fetchWithEmptyStreamRecovery(
        ["https://api.test/v1"],
        { headers: {}, body: "{}" },
        { fetch, drain, signal: makeSignal(), deadlineMs: Date.now() + 5_000 }, // < MIN_RETRY_BUDGET_MS
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayError);
      expect((error as GatewayError).code).toBe("platform_unavailable");
    }
  });

  test("empty endpoints array → throws immediately", async () => {
    try {
      await fetchWithEmptyStreamRecovery(
        [],
        { headers: {}, body: "{}" },
        { fetch: makeFetch([]), drain: makeDrain([]), signal: makeSignal(), deadlineMs: Date.now() + 60_000 },
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayError);
    }
  });
});
