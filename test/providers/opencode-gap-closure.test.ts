import { describe, expect, test } from "bun:test";
import {
  isFreeTierZenModel,
  OPENCODE_FREE_SPEC,
} from "../../src/providers/integrations/opencode/provider";
import { fetchOpenCodeGoQuota } from "../../src/providers/integrations/opencode/opencode-go-quota";

/**
 * The three gaps closed against the reference gateway, each pinned where a
 * future edit would silently undo it.
 */

describe("free-tier Accept advertises what a real client sends", () => {
  test("a free dispatch carries the AI SDK's Accept value", async () => {
    // `opencode2api` sends `application/json, text/event-stream`
    // (upstream.go:1293); we used to claim the narrower
    // `text/event-stream`. Both work today — this pins the one a real
    // OpenCode 2.x client produces.
    const headers = await OPENCODE_FREE_SPEC.buildExtraHeaders?.(
      { conversation_affinity: undefined } as never,
      { model: "big-pickle" } as never,
    );
    expect(headers?.["accept"]).toBe("application/json, text/event-stream");
  });

  test("a billed dispatch still claims nothing, so the transport default stands", async () => {
    const headers = await OPENCODE_FREE_SPEC.buildExtraHeaders?.(
      { conversation_affinity: undefined } as never,
      { model: "gpt-6-astra" } as never,
    );
    expect(headers?.["accept"]).toBeUndefined();
  });
});

describe("the free-tier blocklist is correctable without a deploy", () => {
  const original = process.env.CARTETHYIA_OPENCODE_UNAVAILABLE_FREE;

  test("unset, the bundled measured list stands", () => {
    delete process.env.CARTETHYIA_OPENCODE_UNAVAILABLE_FREE;
    expect(isFreeTierZenModel("deepseek-v4-flash-free")).toBe(false);
    expect(isFreeTierZenModel("mimo-v2.5-free")).toBe(false);
  });

  test("`none` trusts the listing completely", () => {
    // The reference gateway's whole approach: it hardcodes no ids and trusts
    // metadata. An operator who wants that must be able to ask for it.
    process.env.CARTETHYIA_OPENCODE_UNAVAILABLE_FREE = "none";
    expect(isFreeTierZenModel("deepseek-v4-flash-free")).toBe(true);
  });

  test("a list replaces the bundled one, so an un-blocked id stays blocked", () => {
    process.env.CARTETHYIA_OPENCODE_UNAVAILABLE_FREE = "space-bunny-free";
    expect(isFreeTierZenModel("space-bunny-free")).toBe(false);
    // Replaced, not merged: an id the operator omitted is no longer refused.
    expect(isFreeTierZenModel("deepseek-v4-flash-free")).toBe(true);
  });

  test("separators alone fall back to the bundled list rather than trusting all", () => {
    // A typo must not un-block every refused model — that is never what the
    // keystroke meant.
    process.env.CARTETHYIA_OPENCODE_UNAVAILABLE_FREE = ", ,";
    expect(isFreeTierZenModel("deepseek-v4-flash-free")).toBe(false);
  });

  test("the suffix rule and its exception still hold", () => {
    delete process.env.CARTETHYIA_OPENCODE_UNAVAILABLE_FREE;
    expect(isFreeTierZenModel("big-pickle")).toBe(true);
    expect(isFreeTierZenModel("some-model-free")).toBe(true);
    expect(isFreeTierZenModel("claude-opus-5")).toBe(false);
  });

  test("cleanup restores the original environment", () => {
    if (original === undefined) delete process.env.CARTETHYIA_OPENCODE_UNAVAILABLE_FREE;
    else process.env.CARTETHYIA_OPENCODE_UNAVAILABLE_FREE = original;
    expect(true).toBe(true);
  });
});

describe("the Go plan reports a real subscription quota", () => {
  test("three named windows come back as independent budgets", async () => {
    const payload = {
      usage: {
        rolling: { percent: 12, resetsAt: "2026-10-20T00:00:00Z", status: "ok" },
        weekly: { percent: 40, resetsAt: "2026-10-27T00:00:00Z", status: "ok" },
        monthly: { percent: 75, resetsAt: "2026-11-01T00:00:00Z", status: "ok" },
      },
    };
    const fetcher = (async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as never;
    const result = await fetchOpenCodeGoQuota("key", fetcher);
    expect(result.error).toBeNull();
    expect(result.windows.map((window) => window.kind)).toEqual([
      "rolling",
      "weekly",
      "monthly",
    ]);
    // Subscription-wide percentages: several Go keys draw on one plan, so
    // adding these would double-count a single budget.
    for (const window of result.windows) expect(window.accounting).toBe("independent");
    expect(result.windows[0]?.usedPercent).toBe(12);
    expect(result.windows[0]?.remainingPercent).toBe(88);
    expect(result.windows[2]?.remainingPercent).toBe(25);
  });

  test("an unknown window is reported, not dropped", async () => {
    const fetcher = (async () =>
      new Response(
        JSON.stringify({ usage: { daily: { percent: 5 } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as never;
    const result = await fetchOpenCodeGoQuota("key", fetcher);
    expect(result.windows.map((window) => window.kind)).toEqual(["daily"]);
  });

  test("a window with no percentage is omitted rather than read as zero", async () => {
    // Reporting an absent measurement as 0 would tell the operator the plan
    // is exhausted when the upstream simply did not say.
    const fetcher = (async () =>
      new Response(
        JSON.stringify({ usage: { weekly: { resetsAt: "2026-10-27T00:00:00Z" } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as never;
    const result = await fetchOpenCodeGoQuota("key", fetcher);
    expect(result.windows).toEqual([]);
  });

  test("a percent beyond its range is clamped, not passed through", async () => {
    const fetcher = (async () =>
      new Response(
        JSON.stringify({ usage: { weekly: { percent: 140 } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as never;
    const result = await fetchOpenCodeGoQuota("key", fetcher);
    expect(result.windows[0]?.usedPercent).toBe(100);
    expect(result.windows[0]?.remainingPercent).toBe(0);
  });
});
