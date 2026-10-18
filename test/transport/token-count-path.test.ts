/**
 * The `/v1/messages/count_tokens` sibling path.
 *
 * The counter is a *sibling* of the chat endpoint, so the path is derived by
 * appending `/count_tokens` to whatever the catalog stored. That derivation is
 * the whole risk: the stored value is not always a bare path.
 *
 * - **A query string must stay at the end.** AgentRouter stores
 *   `/v1/messages?beta=true`. Appending naively yields
 *   `/v1/messages?beta=true/count_tokens`, so the counting segment lands inside
 *   the query: the upstream sees the chat path with junk appended and either
 *   answers the chat call or 404s — it never counts.
 * - **A trailing slash must not double.** A row stored as `/v1/messages/`
 *   becomes `/v1/messages/count_tokens`, not `/v1/messages//count_tokens`.
 *
 * Asserted against the exported helper rather than a re-derivation, so a fix
 * that is not applied to production cannot make these pass.
 */
import { describe, expect, test } from "bun:test";
import { joinCountTokensPath } from "../../src/transport/dispatch/token-count";

describe("joinCountTokensPath", () => {
  test("keeps a query string after the appended segment", () => {
    // AgentRouter's stored endpoint.
    expect(joinCountTokensPath("/v1/messages?beta=true")).toBe("/v1/messages/count_tokens?beta=true");
  });

  test("does not double a trailing slash", () => {
    expect(joinCountTokensPath("/v1/messages/")).toBe("/v1/messages/count_tokens");
  });

  test("appends to a bare path", () => {
    expect(joinCountTokensPath("/v1/messages")).toBe("/v1/messages/count_tokens");
  });

  test("keeps a versioned path untouched apart from the suffix", () => {
    expect(joinCountTokensPath("/anthropic/v1/messages")).toBe("/anthropic/v1/messages/count_tokens");
  });
});
