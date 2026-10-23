import { describe, expect, test } from "bun:test";
import {
  captureProviderExchange,
  providerCaptureMaxBytes,
} from "../../src/transport/dispatch/attempt-finalize";

describe("provider capture size follows the capture depth", () => {
  // The tee's cap is the most a Provider Request/Response panel can ever
  // show. It was a flat 256 KiB at every depth, so a tenant who raised the
  // depth to Maximum still saw a quarter-megabyte translated request and an
  // empty raw response on any larger exchange.
  test("the cap grows with the depth", () => {
    expect(providerCaptureMaxBytes("minimum")).toBe(256 * 1024);
    expect(providerCaptureMaxBytes("moderate")).toBe(2 * 1024 * 1024);
    expect(providerCaptureMaxBytes("maximum")).toBe(4 * 1024 * 1024);
  });

  test("a larger depth keeps a translated body the flat cap clipped", async () => {
    const body = JSON.stringify({ text: "y".repeat(600_000) });
    const capture = { request: null, response: Promise.resolve(null) };
    const fetcher = captureProviderExchange(
      async () => new Response("{}", { headers: { "content-type": "application/json" } }),
      capture,
      true,
      providerCaptureMaxBytes("moderate"),
    );
    await fetcher("https://example.test/v1/chat/completions", { method: "POST", body });
    const kept = JSON.stringify(((capture.request ?? {}) as { body?: unknown }).body ?? null);
    expect(kept.length).toBeGreaterThan(256 * 1024);
  });

  test("the response tee is read to the same cap", async () => {
    const big = JSON.stringify({ text: "z".repeat(600_000) });
    const capture = { request: null, response: Promise.resolve(null) };
    const fetcher = captureProviderExchange(
      async () => new Response(big, { headers: { "content-type": "application/json" } }),
      capture,
      true,
      providerCaptureMaxBytes("moderate"),
    );
    await fetcher("https://example.test/v1/chat/completions", { method: "POST", body: "{}" });
    const providerResponse = await capture.response;
    expect(JSON.stringify(providerResponse).length).toBeGreaterThan(256 * 1024);
  });
});

describe("provider exchange capture", () => {
  test("captures OpenCode fingerprint headers without persisting credentials", async () => {
    const capture = {
      request: null,
      response: Promise.resolve(null),
    };
    const fetcher = captureProviderExchange(
      async () => new Response("{}", { headers: { "content-type": "application/json" } }),
      capture,
    );

    await fetcher("https://opencode.ai/zen/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: "******",
        "x-opencode-client": "cli",
        "x-opencode-project": "stable-project-hash",
        "x-opencode-session": "ses_test",
        "x-opencode-session-id": "ses_test",
        "x-opencode-parent-session-id": "ses_parent",
        "x-session-affinity": "ses_test",
        "x-session-id": "ses_test",
        "x-parent-session-id": "ses_parent",
        traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
        b3: "0123456789abcdef0123456789abcdef-0123456789abcdef-1-fedcba9876543210",
        "user-agent": "opencode/latest/2.0.28/cli",
      },
      body: "{}",
    });

    expect(capture.request).toMatchObject({
      headers: {
        "x-opencode-client": "cli",
        "x-opencode-project": "stable-project-hash",
        "x-opencode-session": "ses_test",
        "x-opencode-session-id": "ses_test",
        "x-opencode-parent-session-id": "ses_parent",
        "x-session-affinity": "ses_test",
        "x-session-id": "ses_test",
        "x-parent-session-id": "ses_parent",
        traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
        b3: "0123456789abcdef0123456789abcdef-0123456789abcdef-1-fedcba9876543210",
        "user-agent": "opencode/latest/2.0.28/cli",
      },
    });
    expect(JSON.stringify(capture.request)).not.toContain("******");
  });

  test("captures the buddy conversation headers the channel check reads", async () => {
    const capture = { request: null, response: Promise.resolve(null) };
    const fetcher = captureProviderExchange(
      async () => new Response("{}", { headers: { "content-type": "application/json" } }),
      capture,
    );

    await fetcher("https://www.workbuddy.ai/v2/chat/completions", {
      method: "POST",
      headers: {
        authorization: "******",
        "x-session-id": "session-1",
        "x-conversation-id": "conv-1",
        "x-conversation-request-id": "turn-1",
        "x-conversation-message-id": "msg-1",
        "x-root-request-id": "turn-1",
        "x-request-id": "msg-1",
        "x-trace-id": "trace-1",
        "x-b3-traceid": "trace-1",
        "x-b3-spanid": "span-1",
        "x-b3-sampled": "1",
        "user-agent": "WorkBuddy/5.7.6",
      },
      body: "{}",
    });

    expect(capture.request).toMatchObject({
      headers: {
        "x-conversation-id": "conv-1",
        "x-conversation-request-id": "turn-1",
        "x-conversation-message-id": "msg-1",
        "x-root-request-id": "turn-1",
        "x-request-id": "msg-1",
        "x-b3-traceid": "trace-1",
        "x-b3-spanid": "span-1",
      },
    });
    expect(JSON.stringify(capture.request)).not.toContain("******");
  });
});
