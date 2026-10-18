/**
 * The buddy CLI identity.
 *
 * These assertions come from the two reference gateways, which agree on the
 * split: the desktop product sends browser transport plus a device token, and
 * the CLI — issued by the OpenAI Node SDK — sends neither, and adds the agent
 * envelope and the SDK fingerprint. The hybrid this repo used to send
 * (`X-IDE-Type: CLI` alongside `x-requested-with` and `text/event-stream`) is
 * not a client either reference can produce, and it is what these tests pin.
 *
 * Opt-in is pinned too: an unset flag must leave every header exactly as it
 * was, because a wrong identity upstream is what gets an account blocked.
 */
import { describe, expect, test } from "bun:test";
import { codebuddyHeaders } from "../../src/providers/integrations/buddy/codebuddy/shared";
import { workbuddyHeaders } from "../../src/providers/integrations/buddy/workbuddy/shared";
import type { ProviderDispatchContext } from "../../src/providers/provider-contracts";

/** No browser header survives into the CLI identity. */
const BROWSER_HEADERS = [
  "origin",
  "referer",
  "accept-language",
  "x-requested-with",
  "x-codebuddy-request",
] as const;

const AGENT_ENVELOPE = ["X-Agent-Intent", "X-Agent-Type", "X-Agent-Runtime"] as const;

const STAINLESS = [
  "x-stainless-lang",
  "x-stainless-package-version",
  "x-stainless-os",
  "x-stainless-arch",
  "x-stainless-runtime",
  "x-stainless-runtime-version",
  "x-stainless-retry-count",
] as const;

const context = {
  credential: { account_id: "abcdef123456", auth_state: { deviceToken: "desktop-token" } },
} as unknown as ProviderDispatchContext;

const anonymous = {
  credential: { auth_state: {} },
} as unknown as ProviderDispatchContext;

describe("CodeBuddy CLI identity", () => {
  test("carries the agent envelope and the SDK fingerprint", async () => {
    const headers = await codebuddyHeaders("CLI", context, undefined, true);
    expect(headers["X-Agent-Intent"]).toBe("craft");
    expect(headers["X-Agent-Type"]).toBe("main");
    // The reference enum is local-agent / cloud-agent / agent-agent; a gateway
    // is none of them and the parser returns "other" for unknown.
    expect(headers["X-Agent-Runtime"]).toBe("other");
    for (const name of STAINLESS) expect(headers[name]).toBeDefined();
    expect(headers["x-stainless-package-version"]).toBe("6.25.0");
  });

  test("drops every browser header and the device token", async () => {
    const headers = await codebuddyHeaders("CLI", context, undefined, true);
    for (const name of BROWSER_HEADERS) expect(headers[name]).toBeUndefined();
    // The account carries a device token; the CLI never sends one.
    expect(headers["X-Device-Token"]).toBeUndefined();
    expect(headers["x-device-token"]).toBeUndefined();
    expect(headers["accept"]).toBe("application/json");
  });

  test("sets X-User-Id from the account, and anonymous without one", async () => {
    expect((await codebuddyHeaders("CLI", context, undefined, true))["X-User-Id"]).toBe("abcdef123456");
    // The reference sends the literal `anonymous` rather than omitting it.
    expect((await codebuddyHeaders("CLI", anonymous, undefined, true))["X-User-Id"]).toBe("anonymous");
  });

  test("sends X-IDE-Version on both identities", async () => {
    for (const variant of ["IDE", "CLI"] as const) {
      const headers = await codebuddyHeaders(variant, context);
      expect(headers["X-IDE-Version"]).toBeDefined();
    }
  });

  test("extends the trace family with the CLI's parent span", async () => {
    const headers = await codebuddyHeaders("CLI", context, undefined, true);
    expect(headers["traceparent"]).toBeDefined();
    expect(headers["X-B3-ParentSpanId"]).toBeDefined();
    // The CLI conversation request is a child span, so b3 carries four fields
    // where the desktop product's carries three.
    expect(headers["b3"]?.split("-").length).toBe(4);
  });
});

describe("WorkBuddy CLI identity", () => {
  test("carries the agent envelope and drops browser transport", async () => {
    const headers = await workbuddyHeaders(context, undefined, "www.workbuddy.ai", "5.8.4", true);
    for (const name of AGENT_ENVELOPE) expect(headers[name]).toBeDefined();
    for (const name of BROWSER_HEADERS) expect(headers[name]).toBeUndefined();
    expect(headers["x-device-token"]).toBeUndefined();
    expect(headers["accept"]).toBe("application/json");
  });

  test("presents itself as CLI rather than the desktop product", async () => {
    const headers = await workbuddyHeaders(context, undefined, "www.workbuddy.ai", "5.8.4", true);
    expect(headers["x-ide-name"]).toBe("CLI");
    expect(headers["x-ide-type"]).toBe("CLI");
    // The upstream gates chat on the desktop UA brand; the CLI has its own.
    expect(headers["user-agent"]).toMatch(/^CLI\/\S+ CodeBuddy\/\S+$/);
  });

  test("omits the desktop device pair the CLI has no equivalent for", async () => {
    const headers = await workbuddyHeaders(context, undefined, "www.workbuddy.ai", "5.8.4", true);
    expect(headers["x-machine-id"]).toBeUndefined();
    expect(headers["x-session-id"]).toBeUndefined();
  });
});

describe("the desktop identity is unchanged", () => {
  test("x-product is the official SaaS value on both realms", async () => {
    // `WorkBuddy` was a value this repo invented; both references send `SaaS`.
    expect((await workbuddyHeaders(context, undefined, "www.workbuddy.ai", "5.8.4"))["x-product"]).toBe("SaaS");
    expect((await workbuddyHeaders(context, undefined, "www.workbuddy.cn", "5.8.3"))["x-product"]).toBe("SaaS");
  });

  test("an unset flag leaves the desktop headers exactly as they were", async () => {
    const headers = await workbuddyHeaders(context, undefined, "www.workbuddy.ai", "5.8.4");
    expect(headers["origin"]).toBe("https://www.workbuddy.ai");
    expect(headers["referer"]).toBe("https://www.workbuddy.ai/");
    expect(headers["accept-language"]).toBe("en-US");
    expect(headers["x-requested-with"]).toBe("XMLHttpRequest");
    expect(headers["x-codebuddy-request"]).toBe("1");
    expect(headers["x-device-token"]).toBe("desktop-token");
    expect(headers["x-ide-name"]).toBe("WorkBuddy");
    expect(headers["accept"]).toBe("application/json, text/event-stream");
    // Not one CLI-only header leaks into the default identity.
    for (const name of AGENT_ENVELOPE) expect(headers[name]).toBeUndefined();
    for (const name of STAINLESS) expect(headers[name]).toBeUndefined();
  });

  test("an account authorized as CLI overrides the desktop default", async () => {
    const cliAccount = {
      credential: { account_id: "a1", auth_state: { cliIdentity: true } },
    } as unknown as ProviderDispatchContext;
    const headers = await workbuddyHeaders(cliAccount, undefined, "www.workbuddy.ai", "5.8.4");
    expect(headers["x-ide-name"]).toBe("CLI");
    expect(headers["x-device-token"]).toBeUndefined();
  });
});
