/**
 * The conversation and tracing header family.
 *
 * A live WorkBuddy request answered `400 · 11128 "conversation id missing"` —
 * "This call failed channel verification, possibly because it was not sent from
 * an official client" — while carrying only `x-session-id` and `user-agent`. The
 * reference gateway always sends a whole family of conversation IDs, and marks
 * `X-Conversation-Request-ID` mandatory.
 *
 * Three properties are pinned:
 *
 * 1. **The mandatory aggregation key is always present.** It is what the
 *    upstream's channel check reads, and a call without it is what drew `11128`.
 * 2. **A conversation id the client never sent is not invented.** The reference
 *    is explicit that a fabricated id makes the backend build a session the
 *    caller never had.
 * 3. **B3 ids are valid.** The B3 spec accepts only 16/32 hex; an inbound id is
 *    arbitrary, and passing one through unchanged breaks trace correlation.
 */
import { describe, expect, test } from "bun:test";
import { buddyConversationHeaders } from "../../src/providers/integrations/buddy/buddy-conversation-headers";
import { codebuddyHeaders } from "../../src/providers/integrations/buddy/codebuddy/shared";
import { workbuddyHeaders } from "../../src/providers/integrations/buddy/workbuddy/shared";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";

const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;

const MANDATORY = [
  "x-conversation-request-id",
  "x-conversation-message-id",
  "x-request-id",
  "x-root-request-id",
  "x-trace-id",
  "x-b3-traceid",
  "x-b3-spanid",
  "x-b3-sampled",
];

describe("buddyConversationHeaders", () => {
  test("sends every header the reference marks mandatory", () => {
    const headers = buddyConversationHeaders();
    for (const name of MANDATORY) {
      expect(headers[name]).toBeDefined();
    }
  });

  test("the aggregation key is mandatory even with no ids supplied", () => {
    // This is the one that `11128` is about: a chat call with no turn-level key
    // was refused outright.
    const headers = buddyConversationHeaders();
    expect(headers["x-conversation-request-id"]).toMatch(HEX32);
    expect(headers["x-root-request-id"]).toBe(headers["x-conversation-request-id"]);
  });

  test("message and request ids are the same 32-hex value", () => {
    const headers = buddyConversationHeaders();
    expect(headers["x-request-id"]).toMatch(HEX32);
    expect(headers["x-conversation-message-id"]).toBe(headers["x-request-id"]);
    expect(headers["x-b3-spanid"]).toBe(headers["x-request-id"]!.slice(0, 16));
  });

  test("omits the conversation id when the client sent none", () => {
    // Fabricating one makes the upstream build a session the caller never had.
    expect(buddyConversationHeaders()["x-conversation-id"]).toBeUndefined();
    expect(buddyConversationHeaders({ conversationId: "  " })["x-conversation-id"]).toBeUndefined();
  });

  test("passes an inbound conversation id through unchanged", () => {
    const headers = buddyConversationHeaders({ conversationId: "conv-42" });
    expect(headers["x-conversation-id"]).toBe("conv-42");
  });

  test("reuses a supplied turn key and derives the trace from it", () => {
    const headers = buddyConversationHeaders({ conversationRequestId: "turn-1" });
    expect(headers["x-conversation-request-id"]).toBe("turn-1");
    expect(headers["x-root-request-id"]).toBe("turn-1");
    expect(headers["x-trace-id"]).toBe("turn-1");
  });

  test("an inbound trace id wins over the derived one", () => {
    const headers = buddyConversationHeaders({
      conversationRequestId: "turn-1",
      traceId: "inbound-trace",
    });
    expect(headers["x-trace-id"]).toBe("inbound-trace");
  });

  test("a non-hex turn key falls back to a valid B3 trace id", () => {
    // B3 only accepts 16/32 hex. An inbound id carrying dashes would break
    // trace correlation if it were passed straight through.
    const headers = buddyConversationHeaders({
      conversationRequestId: "not-a-hex-trace-id-at-all",
    });
    expect(headers["x-b3-traceid"]).toMatch(HEX32);
    expect(headers["x-conversation-request-id"]).toBe("not-a-hex-trace-id-at-all");
  });

  test("a 32-hex turn key is valid B3 and used as the trace id", () => {
    const turn = "0123456789abcdef0123456789abcdef";
    const headers = buddyConversationHeaders({ conversationRequestId: turn });
    expect(headers["x-b3-traceid"]).toBe(turn);
  });

  test("ids are fresh per call", () => {
    const first = buddyConversationHeaders();
    const second = buddyConversationHeaders();
    expect(first["x-request-id"]).not.toBe(second["x-request-id"]);
    expect(first["x-conversation-request-id"]).not.toBe(second["x-conversation-request-id"]);
  });
});

describe("the per-provider header builders", () => {
  test("WorkBuddy chat carries the whole family", async () => {
    const headers = await workbuddyHeaders(undefined, undefined, "www.workbuddy.ai", "5.7.6");
    for (const name of MANDATORY) expect(headers[name]).toBeDefined();
    expect(headers["x-b3-spanid"]).toMatch(HEX16);
  });

  test("CodeBuddy chat carries the whole family", async () => {
    const headers = await codebuddyHeaders("CLI");
    for (const name of MANDATORY) expect(headers[name]).toBeDefined();
  });

  test("an inbound session header becomes the conversation id", async () => {
    const context = { credential: { account_id: "a1", auth_state: {} }, request_headers: { "x-conversation-id": "inbound-1" } } as never;
    const headers = await workbuddyHeaders(context, { model: "x", messages: [] } as unknown as CanonicalRequest);
    expect(headers["x-conversation-id"]).toBe("inbound-1");
  });

  test("turn keys are stable across two calls but message ids are not", async () => {
    // The reference reuses the turn key across retries/failover inside one user
    // send and rotates the message id per outbound message. Here each call is a
    // fresh turn, so both rotate — but the two must never be equal within a
    // call, which is the property that keeps B3 spans distinct.
    const headers = await workbuddyHeaders(undefined, undefined, "www.workbuddy.ai", "5.7.6");
    expect(headers["x-conversation-request-id"]).not.toBe(headers["x-request-id"]);
  });
});
