/**
 * Antigravity per-model quota: an exhausted bucket with no fraction.
 *
 * The upstream omits `remainingFraction` on a bucket that is spent, but still
 * reports when it resets. Dropping that shape let a healthy sibling window
 * stand in for a lane that is actually blocked — the card read "plenty left"
 * until the operator hit the wall. The summary path already read a disabled
 * bucket as 0%; the per-model path now agrees instead of skipping.
 */
import { describe, expect, test } from "bun:test";
import { fetchAntigravityQuota } from "../../src/providers/integrations/antigravity/antigravity-quota";
import type { ProviderQuotaResult, ProviderQuotaWindow } from "../../src/providers/quota/quota-contracts";

const RESET = "2026-10-22T00:00:00.000Z";

/** A fetcher answering `fetchAvailableModels` and refusing everything else. */
function fetcherFor(models: Record<string, unknown>): typeof fetch {
  return (async (url: string | URL) => {
    const href = typeof url === "string" ? url : url.toString();
    const usesModels = href.includes("fetchAvailableModels");
    return new Response(JSON.stringify(usesModels ? { models } : {}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

/** One reportable model carrying a single quota bucket. */
function model(quotaInfo: Record<string, unknown>): Record<string, unknown> {
  return { quotaInfo };
}

function claudeWindows(result: ProviderQuotaResult): readonly ProviderQuotaWindow[] {
  return result.windows.filter((window) => window.label.startsWith("Claude"));
}

describe("antigravity per-model quota", () => {
  test("a bucket with no fraction but a reset time reads as exhausted", async () => {
    const result = await fetchAntigravityQuota(
      JSON.stringify({ access_token: "token", projectId: "p" }),
      fetcherFor({
        "gemini-2.5-flash": model({ remainingFraction: 1, resetTime: RESET }),
        "claude-sonnet-4-6": model({ resetTime: RESET }),
      }),
    );
    const claude = claudeWindows(result);
    expect(claude.length).toBeGreaterThan(0);
    // Blocked until reset, not missing and not the healthy sibling's 100%.
    expect(claude.every((window) => window.remainingPercent === 0)).toBe(true);
  });

  test("an exhausted bucket keeps its reset time", async () => {
    const result = await fetchAntigravityQuota(
      JSON.stringify({ access_token: "token", projectId: "p" }),
      fetcherFor({ "claude-sonnet-4-6": model({ resetTime: RESET }) }),
    );
    const claude = claudeWindows(result);
    expect(claude.length).toBe(1);
    expect(claude[0]?.resetsAt).toBe(RESET);
  });

  test("a bucket with neither fraction nor reset is still skipped", async () => {
    // No reset time means genuinely unknown, not exhausted — inventing a 0%
    // row here would report a block the upstream never said existed.
    const result = await fetchAntigravityQuota(
      JSON.stringify({ access_token: "token", projectId: "p" }),
      fetcherFor({ "claude-sonnet-4-6": model({}) }),
    );
    expect(claudeWindows(result)).toEqual([]);
  });

  test("an exhausted bucket does not mask a healthy sibling of the same family", async () => {
    // Worst-variant wins: 0% and 60% in one family must report 0%, not the
    // average and not whichever parsed last.
    const result = await fetchAntigravityQuota(
      JSON.stringify({ access_token: "token", projectId: "p" }),
      fetcherFor({
        "claude-sonnet-4-6": model({ remainingFraction: 0.6, resetTime: RESET }),
        "claude-opus-4-6": model({ resetTime: RESET }),
      }),
    );
    const claude = claudeWindows(result);
    expect(claude.length).toBeGreaterThan(0);
    expect(claude.every((window) => window.remainingPercent === 0)).toBe(true);
  });
});
