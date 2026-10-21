/**
 * Provider-card status counts, against the shape the API actually returns.
 *
 * A throttled account used to be counted as healthy. An account-wide cooldown
 * writes `status: "cooldown"`, but a model-scoped backoff leaves `status:
 * "active"` and writes `modelCooldowns` instead — so a card built from status
 * alone read "1 Healthy · 1 Cooling" for a single account that could not serve
 * the model being asked for. That is the case pinned here.
 *
 * These are counts, not markup: the badge text is derived from these numbers,
 * so asserting the numbers is what catches a miscount. A markup assertion would
 * pass on a card that reports two problems for one connection.
 */
import { describe, expect, test } from "bun:test";
import { summarizeAccounts } from "../../src/features/providers/ProvidersPage";
import type { ProviderAccountResponse } from "../../src/data/contracts";

/** Minutes from now, as the ISO string the API writes into the cooldown maps. */
function minutesFromNow(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function account(
  status: ProviderAccountResponse["status"],
  modelCooldowns?: Record<string, string>,
): ProviderAccountResponse {
  return {
    id: `acct-${Math.random().toString(36).slice(2, 8)}`,
    providerId: "cb",
    label: "test",
    status,
    ...(modelCooldowns === undefined ? {} : { modelCooldowns }),
  } as ProviderAccountResponse;
}

describe("provider card status counts", () => {
  test("a model-cooled account is not counted as healthy", () => {
    // The reported bug: status stays "active" for a per-model throttle, so this
    // account is connected but cannot serve. It must not appear under Healthy.
    const counts = summarizeAccounts([
      account("active", { "deepseek-v4.1-pro": minutesFromNow(30) }),
    ]);
    expect(counts.healthy).toBe(0);
    expect(counts.throttled).toBe(1);
    expect(counts.cooling).toBe(1);
  });

  test("an account-wide cooldown is throttled, not healthy", () => {
    const counts = summarizeAccounts([account("cooldown")]);
    expect(counts.healthy).toBe(0);
    expect(counts.throttled).toBe(1);
    // Not "cooling": the whole account is held back, which is a different fact
    // and the badge says which.
    expect(counts.cooling).toBe(0);
  });

  test("an expired per-model backoff stops counting", () => {
    // A stale entry must not hold the account out of Healthy forever.
    const counts = summarizeAccounts([
      account("active", { "deep-model": minutesAgo(5) }),
    ]);
    expect(counts.healthy).toBe(1);
    expect(counts.throttled).toBe(0);
  });

  test("counts are mutually exclusive and add up to the total", () => {
    // One connection is never reported as two problems.
    const accounts = [
      account("active"),
      account("active", { "hy3-preview": minutesFromNow(10) }),
      account("cooldown", { "deep-model": minutesFromNow(10) }),
      account("disabled"),
    ];
    const counts = summarizeAccounts(accounts);
    expect(counts.healthy).toBe(1);
    expect(counts.throttled).toBe(2);
    expect(counts.disabled).toBe(1);
    expect(counts.healthy + counts.throttled + counts.disabled).toBe(accounts.length);
  });

  test("a clean set of accounts is all healthy", () => {
    const counts = summarizeAccounts([account("active"), account("active")]);
    expect(counts.healthy).toBe(2);
    expect(counts.throttled).toBe(0);
  });
});
