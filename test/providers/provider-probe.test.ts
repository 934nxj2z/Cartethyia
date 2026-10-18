/**
 * The provider probe asks the same question a dispatch asks, without spending
 * one.
 *
 * A neutral canary cannot answer "will this provider serve this egress": an
 * OpenCode address that is refused on `/inference/v1/chat/completions` still
 * answers `/v1/models` and the public catalog with `200` (verified live). Only
 * the dispatch route tells the two apart, so the probe must send what a
 * dispatch sends — otherwise it reports a healthy proxy for a blocked one and
 * the operator learns nothing.
 */
import { describe, expect, test } from "bun:test";
import { buildProviderProbeRequest, isProbeableProvider } from "../../src/providers/provider-probe";

describe("provider probe", () => {
  test("only IP-scoped providers are probeable", () => {
    // A 403 from an account-keyed provider belongs to the credential, so a
    // probe would report a pool as refused for a reason replacing it cannot fix.
    expect(isProbeableProvider("opencode")).toBe(true);
    expect(isProbeableProvider("anthropic")).toBe(false);
    expect(isProbeableProvider("some-byok-slug")).toBe(false);
  });

  test("an unprobeable provider has no request to build", async () => {
    expect(await buildProviderProbeRequest("anthropic")).toBeUndefined();
  });

  test("the probe hits the dispatch route, not the catalog", async () => {
    const probe = await buildProviderProbeRequest("opencode");
    expect(probe?.url).toBe("https://opencode.ai/inference/v1/chat/completions");
  });

  test("it carries the adapter's own identity headers", async () => {
    const probe = await buildProviderProbeRequest("opencode");
    const headers = probe?.headers ?? {};
    // Without the session headers and the anonymous bearer the gate refuses a
    // healthy address, which would read as "this proxy is blocked".
    expect(headers["authorization"]).toBe("Bearer public");
    expect(headers["x-opencode-client"]).toBeDefined();
    expect(headers["x-opencode-session"]).toBeDefined();
    expect(headers["user-agent"]).toContain("opencode/");
  });

  test("it carries the full agent tool set and forces streaming", async () => {
    const probe = await buildProviderProbeRequest("opencode");
    const body = probe?.body as {
      model?: string;
      stream?: boolean;
      messages?: unknown[];
      tools?: { function?: { name?: string } }[];
    };
    // `big-pickle` is the free id the listing always carries.
    expect(body.model).toBe("big-pickle");
    expect(body.stream).toBe(true);
    // The gate reads tool membership *and* each recognised definition; a probe
    // without the set is refused on a healthy address, and so is one carrying
    // a stub. Thirteen is the CLI's own tool-name set.
    expect(body.tools?.length).toBe(13);
    const names = (body.tools ?? []).map((tool) => tool.function?.name);
    expect(names).toContain("shell");
    expect(names).toContain("read");
  });

  test("the probe carries the stream controls a real dispatch does", async () => {
    const probe = await buildProviderProbeRequest("opencode");
    const body = probe?.body as { stream_options?: { include_usage?: boolean } };
    // A streamed dispatch attaches `stream_options.include_usage`. The probe
    // omitted it, so its upstream body was missing a field the real one
    // carries — exactly the class of difference that lets a provider accept
    // the probe and reject live traffic.
    expect(body.stream_options?.include_usage).toBe(true);
  });

  test("it sends one short turn, not an empty message list", async () => {
    const probe = await buildProviderProbeRequest("opencode");
    const body = probe?.body as { messages?: unknown[] };
    // An empty list was the original design, on the theory that the gate runs
    // before the body is read. It does not: an allowed address answers
    // `400 messages must not be empty` instead of serving the dispatch, so the
    // probe reported every healthy egress as unusable. One word is the cheapest
    // body that gets past validation.
    expect(body.messages).toHaveLength(1);
    expect(body.messages?.[0]).toMatchObject({ role: "user" });
  });
});
