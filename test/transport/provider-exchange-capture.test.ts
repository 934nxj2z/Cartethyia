import { describe, expect, test } from "bun:test";
import { captureProviderExchange } from "../../src/transport/dispatch/attempt-finalize";

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
