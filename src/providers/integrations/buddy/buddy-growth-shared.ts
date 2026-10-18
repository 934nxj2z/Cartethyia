/**
 * The buddy growth/credit endpoints, as one call each.
 *
 * Six upstream capabilities the reference gateways exercise and we did not:
 * streak makeup, milestone redeem, streak lottery, cat travel, first-buddy
 * adoption, and the trial gift pack. Each is a "claim once per day" (or once
 * per account) surface, and every one of them is a *credit gain* — which is why
 * they exist here at all: an account that never claims them pays for credits it
 * was entitled to.
 *
 * Two rules shape every function in this module:
 *
 * 1. **A duplicate is a success.** `409 duplicate`, business code `14051`, and
 *    the "not enough days / no chances / not eligible" family are all normal
 *    upstream states, not failures. Reporting them as errors would flood the
 *    log with one line per account per day and, worse, would let a gamification
 *    failure mark an account unhealthy.
 * 2. **Nothing here throws.** A growth endpoint that 404s (the international
 *    sites do not serve all of them) yields `skipped`, never a cooldown.
 *
 * The reference gateways gate part of this chain on CN: the international
 * `/activity/growth/*` paths exist but a fresh international account answers
 * 500 on the first read. Rather than hard-coding that, each task reports
 * `skipped` when the endpoint does not answer, so an operator can switch a task
 * off with `CARTETHYIA_DISABLED_TASKS` if a variant is noisy.
 */
import { randomUUID } from "node:crypto";
import type { FetchLike } from "../../quota/quota-contracts";
import { record as asRecord, text as asText } from "../../quota/quota-contracts";

/** Abort budget for one growth request. */
const TIMEOUT_MS = 15_000;

/**
 * The base the growth endpoints hang off.
 *
 * Growth is a chat-host surface, not a billing-host one: the reference sends
 * these to `chatBase` (the provider's console origin) with billing identity
 * headers. `providerBaseUrl` is that origin for every buddy provider, and the
 * `/v2` segment — which the billing meter needs and growth does not — is the
 * one thing that differs, so it is stripped rather than assumed.
 */
function growthBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v2$/, "");
}

/** One growth/credit call's outcome. */
export type BuddyGrowthState = "claimed" | "already" | "not_eligible" | "skipped" | "error";

export interface BuddyGrowthResult {
  readonly state: BuddyGrowthState;
  /** Provider-facing detail for the log; `null` on success. */
  readonly error: string | null;
  /** Credits granted, when the upstream reported them. */
  readonly credit: number | null;
}

export interface BuddyGrowthCall {
  readonly baseUrl: string;
  readonly headers: Record<string, string>;
  readonly credential: string;
  readonly fetcher: FetchLike;
  /** Account UID for the `X-User-Id` identity header. */
  readonly uid?: string | undefined;
  /** Which account and provider the call belongs to — needed by the activity report. */
  readonly accountId: string;
  readonly providerId: string;
  /** Injectable idempotency token generator (tests). */
  readonly token?: (prefix: string) => string;
}

/** `client_token` is `<prefix>-<uuid>` per call: reusing one is an idempotent no-op upstream. */
function clientToken(call: BuddyGrowthCall, prefix: string): string {
  return (call.token ?? ((name: string) => `${name}-${randomUUID()}`))(prefix);
}

interface Reply {
  readonly status: number;
  readonly payload: Record<string, unknown> | null;
  readonly data: Record<string, unknown> | null;
  readonly code: number | null;
  readonly message: string;
  readonly ok: boolean;
  readonly transport: string | null;
}

/**
 * One growth request, unwrapped.
 *
 * `ok === false` with `transport === null` is a *business* refusal (the
 * endpoint answered and said no), which is the state most of this module treats
 * as normal. `transport !== null` is a real failure — the endpoint did not
 * answer at all.
 */
async function call(
  options: BuddyGrowthCall,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
): Promise<Reply> {
  const url = `${growthBase(options.baseUrl)}${path}`;
  let response: Response;
  try {
    response = await options.fetcher(url, {
      method,
      headers: {
        ...options.headers,
        ...(options.uid === undefined || options.uid.length === 0
          ? {}
          : { "X-User-Id": options.uid }),
        Authorization: `Bearer ${options.credential}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return {
      status: 0,
      payload: null,
      data: null,
      code: null,
      message: error instanceof Error ? error.message : "request failed",
      ok: false,
      transport: error instanceof Error ? error.message : "request failed",
    };
  }
  let payload: Record<string, unknown> | null = null;
  let text = "";
  try {
    text = await response.text();
    payload = text.length > 0 ? asRecord(JSON.parse(text)) : null;
  } catch {
    payload = null;
  }
  const code = payload === null || !("code" in payload) ? null : Number(payload["code"]);
  const message = asText(payload?.["msg"]) ?? asText(payload?.["message"]) ?? text.slice(0, 200);
  const data = asRecord(payload?.["data"]) ?? (payload !== null && !("code" in payload) ? payload : null);
  if (!response.ok) {
    return {
      status: response.status,
      payload,
      data,
      code: Number.isFinite(code) ? code : null,
      message,
      ok: false,
      // A 409/403/400 here is the upstream's own answer, not a transport fault.
      transport: null,
    };
  }
  if (Number.isFinite(code) && code !== 0) {
    return { status: response.status, payload, data, code, message, ok: false, transport: null };
  }
  return { status: response.status, payload, data, code, message, ok: true, transport: null };
}

/** A refusal whose message carries any of `markers` — the "already / not eligible" family. */
function refused(reply: Reply, status: number, markers: readonly string[]): boolean {
  if (reply.ok || reply.status !== status) return false;
  const lower = reply.message.toLowerCase();
  return markers.some((marker) => lower.includes(marker));
}

/** A business code that means "already claimed" rather than "failed". */
function coded(reply: Reply, code: number): boolean {
  return !reply.ok && reply.code === code;
}

function done(reply: Reply, credit?: number | null): BuddyGrowthResult {
  if (reply.ok) {
    return { state: "claimed", error: null, credit: credit ?? creditOf(reply) };
  }
  return { state: "error", error: reply.message || `HTTP ${reply.status}`, credit: null };
}

function creditOf(reply: Reply): number | null {
  if (reply.data === null) return null;
  const raw = reply.data["credit"] ?? reply.data["credit_granted"] ?? reply.data["reward_credit"];
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

// ---------------------------------------------------------------------------
// 1. Streak: read, find a missed day, spend a makeup card on it
// ---------------------------------------------------------------------------

const STREAK_PATH = "/activity/growth/streak";
const HEATMAP_PATH = "/activity/growth/heatmap";
const MAKEUP_PATH = "/activity/growth/makeup-cards/use";

export interface BuddyStreakState {
  readonly days: number;
  readonly makeupCards: number;
}

/** Reads the streak length and the makeup-card balance (one GET). */
export async function readBuddyStreak(
  options: BuddyGrowthCall,
): Promise<BuddyStreakState | null> {
  const reply = await call(options, "GET", STREAK_PATH);
  if (!reply.ok) return null;
  const streak = asRecord(reply.data?.["streak"]);
  const cards = asRecord(reply.data?.["makeup_cards"]);
  return {
    days: Number(streak?.["days"] ?? 0) || 0,
    makeupCards: Number(cards?.["balance"] ?? 0) || 0,
  };
}

/** One heatmap cell: a day and its activity score (`0` means missed). */
export interface BuddyHeatmapCell {
  readonly date: string;
  readonly score: number;
}

export async function readBuddyHeatmap(
  options: BuddyGrowthCall,
): Promise<readonly BuddyHeatmapCell[] | null> {
  const reply = await call(options, "GET", HEATMAP_PATH);
  if (!reply.ok || reply.data === null) return null;
  const list = reply.data["cells"];
  if (!Array.isArray(list)) return null;
  return list.flatMap((entry) => {
    const row = asRecord(entry);
    const date = asText(row?.["date"])?.slice(0, 10);
    if (date === undefined || date.length === 0) return [];
    return [{ date, score: Number(row?.["score"] ?? 0) || 0 }];
  });
}

/** `YYYY-MM-DD` for yesterday in CST (+08:00), the upstream's own day boundary. */
export function cstYesterday(now: Date = new Date()): string {
  const shifted = new Date(now.getTime() + 8 * 3600_000);
  return new Date(shifted.getTime() - 86_400_000).toISOString().slice(0, 10);
}

/**
 * Spends a makeup card on a missed day so the streak does not break.
 *
 * A broken streak costs seven days to rebuild, which is far more than a card —
 * so the conditions are checked first (yesterday scored zero, and a card is
 * available) and every other outcome is `skipped` rather than `error`.
 */
export async function useBuddyMakeupCard(
  options: BuddyGrowthCall,
  targetDate: string = cstYesterday(),
): Promise<BuddyGrowthResult> {
  const [heatmap, streak] = await Promise.all([
    readBuddyHeatmap(options),
    readBuddyStreak(options),
  ]);
  if (heatmap === null) return { state: "skipped", error: "heatmap unavailable", credit: null };
  const cell = heatmap.find((entry) => entry.date === targetDate);
  // No cell for the day means the heatmap does not cover it — no evidence of a
  // miss, so nothing is spent.
  if (cell === undefined || cell.score !== 0) {
    return { state: "skipped", error: null, credit: null };
  }
  if (streak === null || streak.makeupCards <= 0) {
    return { state: "skipped", error: null, credit: null };
  }
  const reply = await call(options, "POST", MAKEUP_PATH, { target_date: targetDate });
  // No card, no miss, or already made up — all normal.
  if (refused(reply, 400, ["no card", "insufficient", "already", "无卡", "已补"])) {
    return { state: "already", error: null, credit: null };
  }
  return done(reply);
}

// ---------------------------------------------------------------------------
// 2. Milestone redeem
// ---------------------------------------------------------------------------

const REDEEM_PATH = "/activity/growth/redeem";

/** The three milestone tiers the streak unlocks. */
export const BUDDY_REDEEM_TIERS = ["7d", "14d", "28d"] as const;
export type BuddyRedeemTier = (typeof BUDDY_REDEEM_TIERS)[number];

/** A tier's own state, as the streak endpoint reports it. */
export type BuddyTierStatus = "available" | "claimed" | "locked" | "unknown";

export interface BuddyRedemptionStatus {
  readonly tiers: Readonly<Record<BuddyRedeemTier, BuddyTierStatus>>;
  readonly remainingDays: number | null;
}

const TIER_FIELDS: Readonly<Record<BuddyRedeemTier, string>> = {
  "7d": "tier_7d_status",
  "14d": "tier_14d_status",
  "28d": "tier_28d_status",
};

/** Reads each tier's claim state from the same streak response. */
export async function readBuddyRedemption(
  options: BuddyGrowthCall,
): Promise<BuddyRedemptionStatus | null> {
  const reply = await call(options, "GET", STREAK_PATH);
  if (!reply.ok || reply.data === null) return null;
  const status = asRecord(reply.data["redemption_status"]) ?? {};
  const tiers = {} as Record<BuddyRedeemTier, BuddyTierStatus>;
  for (const tier of BUDDY_REDEEM_TIERS) {
    const value = asText(status[TIER_FIELDS[tier]])?.toLowerCase();
    tiers[tier] =
      value === "available" || value === "claimed" || value === "locked" ? value : "unknown";
  }
  const remaining = Number(status["remaining_days"]);
  return { tiers, remainingDays: Number.isFinite(remaining) ? remaining : null };
}

/**
 * Claims one milestone tier.
 *
 * `409 duplicate` and a 403 "days not enough" are both success-equivalent: the
 * first means this month's claim already happened, the second means the tier is
 * not reachable yet. Neither is worth a retry or a log line.
 */
export async function redeemBuddyStreakTier(
  options: BuddyGrowthCall,
  tier: BuddyRedeemTier,
): Promise<BuddyGrowthResult> {
  const reply = await call(options, "POST", REDEEM_PATH, {
    tier,
    client_token: clientToken(options, `redeem-${tier}`),
  });
  if (coded(reply, 409) || refused(reply, 409, ["duplicate", "已领取"])) {
    return { state: "already", error: null, credit: null };
  }
  if (refused(reply, 403, ["not enough", "insufficient", "未达标", "天数不足"])) {
    return { state: "not_eligible", error: null, credit: null };
  }
  return done(reply);
}

// ---------------------------------------------------------------------------
// 3. Streak lottery
// ---------------------------------------------------------------------------

const LOTTERY_CHANCES_PATH = "/activity/growth/lottery/chances";
const LOTTERY_DRAW_PATH = "/activity/growth/lottery/draw";

/** Remaining draw chances granted by a redeemed tier. */
export async function readBuddyLotteryChances(
  options: BuddyGrowthCall,
): Promise<number | null> {
  const reply = await call(options, "GET", LOTTERY_CHANCES_PATH);
  if (!reply.ok || reply.data === null) return null;
  const value = Number(reply.data["balance"]);
  return Number.isFinite(value) ? value : null;
}

/**
 * Draws once. A fresh `client_token` per draw: reusing one lets the upstream
 * treat the draw as a duplicate and swallow it.
 */
export async function drawBuddyLottery(
  options: BuddyGrowthCall,
): Promise<BuddyGrowthResult> {
  const reply = await call(options, "POST", LOTTERY_DRAW_PATH, {
    client_token: clientToken(options, "draw"),
  });
  if (refused(reply, 400, ["insufficient", "disabled", "no chance", "未开启"])) {
    return { state: "not_eligible", error: null, credit: null };
  }
  return done(reply);
}

// ---------------------------------------------------------------------------
// 4. Cat travel
// ---------------------------------------------------------------------------

const TRAVEL_STATUS_PATH = "/activity/growth/buddy/travel/status";
const TRAVEL_CONFIG_PATH = "/activity/growth/buddy/travel/config";
const TRAVEL_DEPART_PATH = "/activity/growth/buddy/travel/depart";
const TRAVEL_CLAIM_PATH = "/activity/growth/buddy/travel/claim";
/**
 * Departure location. The reference fixes 4 ("古镇客栈"): all four locations
 * pay the same range over the same duration, so there is no optimum to chase.
 */
const TRAVEL_LOCATION_ID = 4;

export type BuddyTravelState = "idle" | "traveling" | "arrived" | "unknown";

export interface BuddyTravelStatus {
  readonly state: BuddyTravelState;
  readonly dailyLimitReached: boolean;
  readonly recordId: number | null;
  readonly rewardCredit: number | null;
}

export async function readBuddyTravelStatus(
  options: BuddyGrowthCall,
): Promise<BuddyTravelStatus | null> {
  const reply = await call(options, "GET", TRAVEL_STATUS_PATH);
  if (!reply.ok || reply.data === null) return null;
  const raw = asText(reply.data["state"])?.toLowerCase();
  const state: BuddyTravelState =
    raw === "idle" || raw === "traveling" || raw === "arrived" ? raw : "unknown";
  const record = Number(reply.data["record_id"]);
  const reward = Number(reply.data["reward_credit"]);
  return {
    state,
    dailyLimitReached: reply.data["daily_limit_reached"] === true,
    recordId: Number.isFinite(record) ? record : null,
    rewardCredit: Number.isFinite(reward) ? reward : null,
  };
}

/** The travel configuration; informational, and the depart pre-check. */
export async function readBuddyTravelConfig(
  options: BuddyGrowthCall,
): Promise<Record<string, unknown> | null> {
  const reply = await call(options, "GET", TRAVEL_CONFIG_PATH);
  return reply.ok ? reply.data : null;
}

export async function departBuddyTravel(
  options: BuddyGrowthCall,
  locationId: number = TRAVEL_LOCATION_ID,
): Promise<BuddyGrowthResult> {
  const reply = await call(options, "POST", TRAVEL_DEPART_PATH, { location_id: locationId });
  if (refused(reply, 400, ["already traveling", "location not available", "limit"])) {
    return { state: "already", error: null, credit: null };
  }
  return done(reply);
}

/** Claims an arrived cat's reward. `record_id` is mandatory on this call. */
export async function claimBuddyTravel(
  options: BuddyGrowthCall,
  recordId: number,
): Promise<BuddyGrowthResult> {
  const reply = await call(options, "POST", TRAVEL_CLAIM_PATH, { record_id: recordId });
  return done(reply);
}

// ---------------------------------------------------------------------------
// 5. First-buddy adoption
// ---------------------------------------------------------------------------

const BUDDY_INFO_PATH = "/activity/growth/buddy/info";
const BUDDY_TASKS_PATH = "/v2/activity/growth/tasks";
const BUDDY_AGREEMENT_PATH = "/activity/growth/buddy/agreement";
const BUDDY_FIRST_PATH = "/activity/growth/buddy/first";

/** The task code that gates adoption. */
const FIRST_BUDDY_TASK = "first_buddy";
/** `accept_status` values that count as "the task is live or already accepted". */
const ACCEPTED_STATUSES: readonly string[] = [
  "not_accepted",
  "accepted",
  "in_progress",
  "completed",
];

/** True when this account already has a cat. */
export async function readBuddyInfo(
  options: BuddyGrowthCall,
): Promise<{ readonly hasBuddy: boolean } | null> {
  const reply = await call(options, "GET", BUDDY_INFO_PATH);
  if (!reply.ok || reply.data === null || !("buddy" in reply.data)) return null;
  const buddy = reply.data["buddy"];
  return { hasBuddy: buddy !== null && typeof buddy === "object" };
}

/**
 * Finds the single `first_buddy` task.
 *
 * The reference requires exactly one match and an unlocked, buddy-rewarding
 * task in an accepted state: anything else is not evidence that adoption is
 * available, and adopting blind is a write to an account's growth state.
 */
export async function readBuddyFirstTask(
  options: BuddyGrowthCall,
): Promise<Record<string, unknown> | null> {
  const reply = await call(options, "GET", BUDDY_TASKS_PATH);
  if (!reply.ok || reply.data === null) return null;
  const rows = reply.data["tasks"];
  if (!Array.isArray(rows)) return null;
  const matches = rows.filter(
    (row) => asRecord(row)?.["task_code"] === FIRST_BUDDY_TASK,
  );
  if (matches.length !== 1) return null;
  const task = asRecord(matches[0]);
  if (task === null) return null;
  if (task["locked"] !== false || task["reward_buddy"] !== true) return null;
  const status = asText(task["accept_status"])?.toLowerCase();
  if (status === undefined || !ACCEPTED_STATUSES.includes(status)) return null;
  return task;
}

/** Reads the agreement state before accepting it. */
export async function readBuddyAgreement(
  options: BuddyGrowthCall,
): Promise<Record<string, unknown> | null> {
  const reply = await call(options, "GET", BUDDY_AGREEMENT_PATH);
  return reply.ok ? reply.data : null;
}

/** Accepts the adoption agreement. Idempotent upstream. */
export async function agreeBuddyAgreement(
  options: BuddyGrowthCall,
): Promise<BuddyGrowthResult> {
  const reply = await call(options, "POST", BUDDY_AGREEMENT_PATH, { agree: true });
  return done(reply);
}

/**
 * Adopts the first cat.
 *
 * A 400 carrying `first_buddy task not completed yet` is the conversation-count
 * threshold not being met — expected, and a reason to stop trying today rather
 * than a failure.
 */
export async function adoptFirstBuddy(
  options: BuddyGrowthCall,
): Promise<BuddyGrowthResult> {
  const reply = await call(options, "POST", BUDDY_FIRST_PATH, {});
  if (refused(reply, 400, ["first_buddy task not completed", "task not completed"])) {
    return { state: "not_eligible", error: null, credit: null };
  }
  return done(reply);
}

// ---------------------------------------------------------------------------
// 6. Trial gift pack + gift/compensation claims
// ---------------------------------------------------------------------------

const TRIAL_PATH = "/billing/ide/trial";
const GIFT_PATH = "/billing/meter/claim-gift";
const COMPENSATION_PATH = "/billing/meter/claim-compensation";
/** "Already claimed" on the trial pack. */
const TRIAL_ALREADY_CODE = 14051;

/**
 * Claims the one-off trial credit pack.
 *
 * International only: the reference reports the CN hosts do not serve this
 * endpoint at all, and a 404 there is a `skip`, not a failure.
 */
export async function claimBuddyTrial(
  options: BuddyGrowthCall,
): Promise<BuddyGrowthResult> {
  const reply = await call(options, "POST", TRIAL_PATH, {});
  if (coded(reply, TRIAL_ALREADY_CODE) || refused(reply, 400, ["14051"])) {
    return { state: "already", error: null, credit: null };
  }
  // Not served on this host at all — a 404/405 here is a routing fact, not an
  // account problem.
  if (reply.status === 404 || reply.status === 405) {
    return { state: "skipped", error: null, credit: null };
  }
  return done(reply);
}

/**
 * Claims the newcomer gift, if one is present.
 *
 * Once per account; a business error afterwards is the normal "already claimed"
 * answer and is never a failure.
 */
export async function claimBuddyGift(
  options: BuddyGrowthCall,
): Promise<BuddyGrowthResult> {
  const reply = await call(options, "POST", GIFT_PATH, {});
  if (!reply.ok) return { state: "already", error: null, credit: null };
  return done(reply);
}

/** Claims an activity compensation, if one is present. Same once-only semantics. */
export async function claimBuddyCompensation(
  options: BuddyGrowthCall,
): Promise<BuddyGrowthResult> {
  const reply = await call(options, "POST", COMPENSATION_PATH, {});
  if (!reply.ok) return { state: "already", error: null, credit: null };
  return done(reply);
}
