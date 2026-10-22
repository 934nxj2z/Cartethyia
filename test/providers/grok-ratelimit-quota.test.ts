/**
 * Grok's two quota numbers, and the fact that they disagree.
 *
 * The CLI plane returns a token bucket on every response
 * (`x-ratelimit-limit-tokens: 1000000`), but that figure is *eventually
 * consistent* — it can read full right after a request — and it is not the
 * figure that binds. The real free allowance for a model like `grok-4.6` is
 * 600k per rolling 24 hours, and upstream states it only in the body of a 429:
 *
 *   tokens (actual/limit): 603024/600000
 *   Usage resets over a rolling 24-hour window
 *
 * So the header is the everyday indicator and the 429 is the verdict. The
 * properties here are the ones that decide whether a healthy account gets
 * parked by a probe that was refused.
 */
import { describe, expect, test } from "bun:test";
import { fetchGrokQuota } from "../../src/providers/integrations/grok/grok-quota";
import {
  GROK_AUTHORITATIVE_WINDOW_KIND,
  GROK_HEADER_WINDOW_KIND,
  grokAuthoritativeWindow,
  grokHeaderWindow,
  parseGrokFreeUsageVerdict,
  readGrokRateLimitHeaders,
} from "../../src/providers/integrations/grok/grok-ratelimit";

/** A fetcher that answers billing generically and the probe from a factory. */
function grokFetcher(probe: () => Response): typeof fetch {
  return (async (url: unknown) => {
    const target = String(url);
    if (target.includes("/v1/responses")) return probe();
    if (target.includes("/v1/billing")) {
      return new Response(JSON.stringify({ creditUsagePercent: 12 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

const REFUSAL_BODY =
  "You have exceeded your free usage. tokens (actual/limit): 603024/600000. " +
  "Usage resets over a rolling 24-hour window";

describe("the header bucket is an indicator, not a verdict", () => {
  test("remaining and limit come off the response", () => {
    const reading = readGrokRateLimitHeaders({
      "x-ratelimit-limit-tokens": "1000000",
      "x-ratelimit-remaining-tokens": "996169",
      "x-ratelimit-remaining-requests": "20",
    });
    expect(reading.limitTokens).toBe(1000000);
    expect(reading.remainingTokens).toBe(996169);
    expect(reading.remainingRequests).toBe(20);
  });

  test("used is derived from the two figures", () => {
    const window = grokHeaderWindow(
      readGrokRateLimitHeaders({
        "x-ratelimit-limit-tokens": "1000000",
        "x-ratelimit-remaining-tokens": "996169",
      }),
    );
    expect(window?.used).toBe(3831);
    expect(window?.limit).toBe(1000000);
    // Independent, never pooled: this is the CLI request bucket, a different
    // budget from the free-usage allowance.
    expect(window?.accounting).toBe("independent");
  });

  test("a response with no bucket yields no window, not a zero", () => {
    // A zero here would read as "no tokens left" for an account that simply
    // was not measured.
    expect(grokHeaderWindow(readGrokRateLimitHeaders({}))).toBeNull();
  });
});

describe("the 429 body carries the authoritative allowance", () => {
  test("actual and limit are parsed out of the message", () => {
    const verdict = parseGrokFreeUsageVerdict(
      { code: "subscription:free-usage-exhausted", error: REFUSAL_BODY },
    );
    expect(verdict?.actual).toBe(603024);
    expect(verdict?.limit).toBe(600000);
    expect(verdict?.rolling).toBe(true);
  });

  test("the header's 1M does not overwrite the real 600k", () => {
    // This is the whole point of the document: the header advertises 1,000,000
    // and the binding figure is 600,000. They must both survive.
    const window = grokAuthoritativeWindow(
      parseGrokFreeUsageVerdict({ error: REFUSAL_BODY }) ?? {
        actual: null,
        limit: null,
        resetsAt: null,
        rolling: false,
      },
    );
    expect(window?.limit).toBe(600000);
    expect(window?.used).toBe(603024);
  });

  test("a refusal without the figures yields nothing rather than a guess", () => {
    expect(parseGrokFreeUsageVerdict({ error: "something else entirely" })).toBeNull();
  });
});

describe("fetchGrokQuota orders the indicator above the verdict", () => {
  test("a healthy account reports the header bucket", async () => {
    const result = await fetchGrokQuota(
      "token",
      grokFetcher(
        () =>
          new Response(JSON.stringify({ ok: 1 }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-ratelimit-limit-tokens": "1000000",
              "x-ratelimit-remaining-tokens": "996169",
            },
          }),
      ),
    );

    expect(result.windows[0]?.kind).toBe(GROK_HEADER_WINDOW_KIND);
    expect(result.error).toBeNull();
  });

  test("a refused account appends the authoritative window beneath the header", async () => {
    const result = await fetchGrokQuota(
      "token",
      grokFetcher(
        () =>
          new Response(
            JSON.stringify({ code: "subscription:free-usage-exhausted", error: REFUSAL_BODY }),
            {
              status: 429,
              headers: {
                "content-type": "application/json",
                "x-ratelimit-limit-tokens": "1000000",
                "x-ratelimit-remaining-tokens": "0",
              },
            },
          ),
      ),
    );

    const kinds = result.windows.map((window) => window.kind);
    expect(kinds[0]).toBe(GROK_HEADER_WINDOW_KIND);
    expect(kinds.at(-1)).toBe(GROK_AUTHORITATIVE_WINDOW_KIND);
    // The authoritative figure, not the header's, is what the account has.
    expect(result.windows.at(-1)?.limit).toBe(600000);
  });

  test("a probe refusal is account state, not a read failure", async () => {
    // If this were reported as an error the console would show a broken read
    // for an account that was measured perfectly well — it is out of free
    // usage, which is a balance, not a fault.
    const result = await fetchGrokQuota(
      "token",
      grokFetcher(
        () =>
          new Response(JSON.stringify({ code: "subscription:free-usage-exhausted", error: REFUSAL_BODY }), {
            status: 429,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    expect(result.error).toBeNull();
    expect(result.windows.length).toBeGreaterThan(0);
  });

  test("a transport failure yields no reading", async () => {
    const result = await fetchGrokQuota(
      "token",
      grokFetcher(() => {
        throw new Error("network down");
      }),
    );

    // No header bucket could be read, so none is invented.
    const kinds = result.windows.map((window) => window.kind);
    expect(kinds).not.toContain(GROK_HEADER_WINDOW_KIND);
    expect(result.error).toBeNull();
  });
});
