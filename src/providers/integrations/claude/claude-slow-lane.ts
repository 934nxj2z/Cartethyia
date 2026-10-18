/**
 * Claude slow-lane support: per-response header parsing and the in-memory
 * per-account lane registry. The upstream response headers declare whether the
 * account is in the slow lane and what its lifecycle status is; this module
 * parses them into `ClaudeSlowStatus` / `ClaudeSlowOffer` and keeps the stamp
 * on the candidate so routing can order a slow account behind fresh siblings.
 *
 * Owner note: `claude-quota.ts` owns quota *endpoint* reads. The slow lane is a
 * per-*response* header observation — different lifecycle, different owner, so
 * it lives here.
 *
 * Scope: header parsing and the registry are implemented here. Routing
 * integration and retry behavior live at the caller
 * (`src/transport/routing/router.ts`, `applySlowLane`).
 */

/** Lifecycle status the upstream reports for the account's slow lane. */
export type ClaudeSlowStatus =
  | "active"
  | "not_needed"
  | "slot_busy"
  | "weekly_limit"
  | "budget_exhausted"
  | "ineligible"
  | "off"
  | "unrecognized";

/** Whether the account was offered entry into the slow lane. */
export type ClaudeSlowOffer = "treatment" | "control";

/**
 * Classifies one observed lane status for the retry loop (design doc §5).
 *
 * Three-way, because the loop must do three different things:
 * - `wait`: the account has no spare capacity *right now* but is still in the
 *   lane, so the retry belongs on the SAME account after the server-stated
 *   interval. It is not a failure and must record no health.
 * - `terminal`: the lane itself ended (weekly/budget exhausted, switched off,
 *   ineligible). Staying would spin, so this is the point where health is
 *   written and the attempt fails over.
 * - `served`: the lane answered or was not needed. Nothing to wait for.
 */
export type ClaudeSlowRetryClass = "wait" | "terminal" | "served";

export function classifyClaudeSlowStatus(
  status: ClaudeSlowStatus | undefined,
): ClaudeSlowRetryClass {
  switch (status) {
    case "slot_busy":
      return "wait";
    case "weekly_limit":
    case "budget_exhausted":
    case "ineligible":
    case "off":
      return "terminal";
    case "active":
    case "not_needed":
      return "served";
    default:
      // `unrecognized` and an absent status: the lane said nothing actionable.
      // Treating an unknown as `wait` would spin on a status nobody reads;
      // treating it as terminal would write health for a non-event.
      return "served";
  }
}

export interface ClaudeSlowSignal {
  offer?: ClaudeSlowOffer;
  status?: ClaudeSlowStatus;
  retryAfterMs?: number;
  maxWaitMs?: number;
  budgetUtilization?: number;
  budgetResetAtSec?: number;
  unifiedResetAtSec?: number;
  fiveHourResetAtSec?: number;
  weeklyResetAtSec?: number;
  unifiedLimitClaim: boolean;
  overageInUse: boolean;
  overageAllowed?: boolean;
  graceUtilization?: { fiveHour: number; sevenDay: number };
}

/** Anything with a `Headers`-shaped single-key read. */
export type ClaudeSlowHeaderSource =
  | Pick<Headers, "get">
  | Record<string, string | undefined>;

const SLOW_PREFIX = "anthropic-ratelimit-unified-slow-";
const UNIFIED_PREFIX = "anthropic-ratelimit-unified-";

const HEADER_OFFER = `${SLOW_PREFIX}offer`;
const HEADER_STATUS = `${SLOW_PREFIX}status`;
const HEADER_RETRY_AFTER = `${SLOW_PREFIX}retry-after`;
const HEADER_MAX_WAIT = `${SLOW_PREFIX}max-wait`;
const HEADER_BUDGET_UTILIZATION = `${SLOW_PREFIX}budget-utilization`;
const HEADER_BUDGET_RESET = `${SLOW_PREFIX}budget-reset`;
const HEADER_UNIFIED_RESET = `${UNIFIED_PREFIX}reset`;
const HEADER_5H_RESET = `${UNIFIED_PREFIX}5h-reset`;
const HEADER_7D_RESET = `${UNIFIED_PREFIX}7d-reset`;
const HEADER_REPRESENTATIVE_CLAIM = `${UNIFIED_PREFIX}representative-claim`;
const HEADER_OVERAGE_STATUS = `${UNIFIED_PREFIX}overage-status`;
const HEADER_OVERAGE_IN_USE = `${UNIFIED_PREFIX}overage-in-use`;
const HEADER_GRACE_5H = `${UNIFIED_PREFIX}grace-5h-utilization`;
const HEADER_GRACE_7D = `${UNIFIED_PREFIX}grace-7d-utilization`;

/** Clamp/Default timing bounds, matching the donor's clamps. */
const RETRY_AFTER_MIN_SEC = 5;
const RETRY_AFTER_MAX_SEC = 600;
const RETRY_AFTER_DEFAULT_SEC = 20;
const MAX_WAIT_MIN_SEC = 60;
const MAX_WAIT_MAX_SEC = 6 * 60 * 60;
const MAX_WAIT_DEFAULT_SEC = 20 * 60;

const SEC_TO_MS = 1_000;

/** Statuses the upstream uses verbatim; anything else maps to `unrecognized`. */
const KNOWN_STATUSES: readonly ClaudeSlowStatus[] = [
  "active",
  "not_needed",
  "slot_busy",
  "weekly_limit",
  "budget_exhausted",
  "ineligible",
  "off",
];

/** Numeric seconds clamped into `[minSec, maxSec]`, or undefined when absent. */
function seconds(
  raw: string | undefined,
  bounds: { min: number; max: number },
): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed)) return undefined;
  return Math.min(Math.max(parsed, bounds.min), bounds.max) * SEC_TO_MS;
}

/** Utilization fraction clamped to 0..1, or undefined when absent/unparseable. */
function utilization(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed)) return undefined;
  return Math.min(Math.max(parsed, 0), 1);
}

/** Epoch-seconds reset, dropped when absent, unparseable, or already past. */
function futureEpochSec(raw: string | undefined, nowSec: number): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  if (parsed <= nowSec) return undefined;
  return parsed;
}

function readHeader(
  headers: ClaudeSlowHeaderSource,
  name: string,
): string | undefined {
  // The source is either a `Headers`-like reader or a plain bag. Both expose a
  // `get` member (the bag through its index signature), so narrow on its type:
  // a real function means read through it, bound to the source.
  const getter = headers.get;
  if (typeof getter === "function") {
    const value = getter.call(headers, name);
    return value === null || value === undefined ? undefined : String(value);
  }
  const bag = headers as Record<string, string | undefined>;
  const value = bag[name];
  return value === undefined ? undefined : String(value);
}

function parseStatus(raw: string | undefined): ClaudeSlowStatus | undefined {
  if (raw === undefined) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized.length === 0) return undefined;
  return KNOWN_STATUSES.includes(normalized as ClaudeSlowStatus)
    ? (normalized as ClaudeSlowStatus)
    : "unrecognized";
}

function parseOffer(raw: string | undefined): ClaudeSlowOffer | undefined {
  const normalized = raw?.trim().toLowerCase();
  return normalized === "treatment" || normalized === "control" ? normalized : undefined;
}

/** True for the common boolean-ish header spellings upstreams use. */
function parseFlag(raw: string | undefined): boolean {
  const normalized = raw?.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

/**
 * Parse the slow-lane / unified rate-limit headers off a Claude response.
 *
 * Returns `undefined` when no slow or unified header is present at all, so
 * callers can cheaply skip lane bookkeeping on the ordinary path.
 */
export function parseClaudeSlowHeaders(
  headers: ClaudeSlowHeaderSource,
  options: { nowMs?: number } = {},
): ClaudeSlowSignal | undefined {
  const nowSec = Math.floor((options.nowMs ?? Date.now()) / SEC_TO_MS);

  const offer = parseOffer(readHeader(headers, HEADER_OFFER));
  const status = parseStatus(readHeader(headers, HEADER_STATUS));

  // Open question 3 (§8): the donor waits up to 20 min, our request deadlines
  // may be far shorter. Design-doc default stands here (20s / 20min); §5
  // clamps the actual wait against the request deadline floor. Defaults apply
  // only when the response actually names a lane (offer/status present) —
  // otherwise every unrelated response would report pacing.
  const laneNamed = offer !== undefined || status !== undefined;

  const retryAfterMs =
    seconds(readHeader(headers, HEADER_RETRY_AFTER), {
      min: RETRY_AFTER_MIN_SEC,
      max: RETRY_AFTER_MAX_SEC,
    }) ?? (laneNamed ? RETRY_AFTER_DEFAULT_SEC * SEC_TO_MS : undefined);
  const maxWaitMs =
    seconds(readHeader(headers, HEADER_MAX_WAIT), {
      min: MAX_WAIT_MIN_SEC,
      max: MAX_WAIT_MAX_SEC,
    }) ?? (laneNamed ? MAX_WAIT_DEFAULT_SEC * SEC_TO_MS : undefined);
  const budgetUtilization = utilization(readHeader(headers, HEADER_BUDGET_UTILIZATION));
  const budgetResetAtSec = futureEpochSec(readHeader(headers, HEADER_BUDGET_RESET), nowSec);
  const unifiedResetAtSec = futureEpochSec(readHeader(headers, HEADER_UNIFIED_RESET), nowSec);
  const fiveHourResetAtSec = futureEpochSec(readHeader(headers, HEADER_5H_RESET), nowSec);
  const weeklyResetAtSec = futureEpochSec(readHeader(headers, HEADER_7D_RESET), nowSec);

  // The unified limit wall is "claimed" by either header: the representative
  // claim, or an overage-status that names a wall (e.g. `claimed`).
  const overageStatusRaw = readHeader(headers, HEADER_OVERAGE_STATUS);
  const unifiedLimitClaim =
    parseFlag(readHeader(headers, HEADER_REPRESENTATIVE_CLAIM)) ||
    (overageStatusRaw !== undefined && overageStatusRaw.trim().length > 0);
  const overageInUse = parseFlag(readHeader(headers, HEADER_OVERAGE_IN_USE));

  const overageStatus = overageStatusRaw?.trim().toLowerCase();
  const overageAllowed =
    overageStatus === undefined ? undefined : overageStatus === "allowed";

  const grace5h = utilization(readHeader(headers, HEADER_GRACE_5H));
  const grace7d = utilization(readHeader(headers, HEADER_GRACE_7D));
  const graceUtilization =
    grace5h === undefined && grace7d === undefined
      ? undefined
      : { fiveHour: grace5h ?? 0, sevenDay: grace7d ?? 0 };

  // No slow/unified headers at all → nothing to report.
  const present =
    offer !== undefined ||
    status !== undefined ||
    retryAfterMs !== undefined ||
    maxWaitMs !== undefined ||
    budgetUtilization !== undefined ||
    budgetResetAtSec !== undefined ||
    unifiedResetAtSec !== undefined ||
    fiveHourResetAtSec !== undefined ||
    weeklyResetAtSec !== undefined ||
    unifiedLimitClaim ||
    overageInUse ||
    overageStatusRaw !== undefined ||
    graceUtilization !== undefined;
  if (!present) return undefined;

  const signal: ClaudeSlowSignal = {
    unifiedLimitClaim,
    overageInUse,
  };
  if (offer !== undefined) signal.offer = offer;
  if (status !== undefined) signal.status = status;
  if (retryAfterMs !== undefined) signal.retryAfterMs = retryAfterMs;
  if (maxWaitMs !== undefined) signal.maxWaitMs = maxWaitMs;
  if (budgetUtilization !== undefined) signal.budgetUtilization = budgetUtilization;
  if (budgetResetAtSec !== undefined) signal.budgetResetAtSec = budgetResetAtSec;
  if (unifiedResetAtSec !== undefined) signal.unifiedResetAtSec = unifiedResetAtSec;
  if (fiveHourResetAtSec !== undefined) signal.fiveHourResetAtSec = fiveHourResetAtSec;
  if (weeklyResetAtSec !== undefined) signal.weeklyResetAtSec = weeklyResetAtSec;
  if (overageAllowed !== undefined) signal.overageAllowed = overageAllowed;
  if (graceUtilization !== undefined) signal.graceUtilization = graceUtilization;
  return signal;
}

// ─── §3. Lane-state registry ───────────────────────────────────────────────

/** Why a lane is blocked; drives the block deadline. */
export type ClaudeSlowBlockReason = "weekly" | "budget";

export type ClaudeSlowPhase =
  | { readonly kind: "idle" }
  | { readonly kind: "active"; readonly resetsAtSec: number }
  | {
      readonly kind: "blocked";
      readonly reason: ClaudeSlowBlockReason;
      readonly untilSec: number;
    };

export interface ClaudeSlowLane {
  phase: ClaudeSlowPhase;
  offer?: ClaudeSlowOffer;
  offerResetAtSec?: number;
  /** Set after the lane gives up on a max-wait budget; suppresses re-entry. */
  coolingOffUntilMs?: number;
  retryAfterMs?: number;
  maxWaitMs?: number;
  budgetUtilization?: number;
  wrapUpUntilSec?: number;
}

/** Active lanes expire this long *after* their stated reset. */
const ACTIVE_GRACE_SEC = 60;
/** Cooling-off period after a max-wait give-up. */
const COOLING_OFF_MS = 10 * 60 * SEC_TO_MS;
/** Hard ceiling on a `budget` block, whatever the upstream stated. */
const BUDGET_BLOCK_MAX_SEC = 8 * 24 * 60 * 60;
/** Cap on registry size so account fan-out cannot pin memory. */
const LANE_MAX_ENTRIES = 1024;

/**
 * In-memory per-account slow-lane registry.
 *
 * Deadline-driven, not timer-driven: every read first expires the lane against
 * the current clock. On process restart all lanes are idle — fail-closed to
 * today's behavior (session wall → `quota_exhausted`) until a fresh 429
 * re-derives the offer. That is intentional, per §3.
 */
export class ClaudeSlowLanes {
  private readonly lanes = new Map<string, ClaudeSlowLane>();
  private readonly maxEntries: number;

  constructor(options: { maxEntries?: number } = {}) {
    this.maxEntries = options.maxEntries ?? LANE_MAX_ENTRIES;
  }

  /**
   * Fold one observed signal into the account's lane. Returns the resulting
   * lane state. Expiry runs first, so a stale lane cannot shadow a fresh
   * observation.
   */
  observe(accountId: string, signal: ClaudeSlowSignal, nowMs = Date.now()): ClaudeSlowLane {
    const lane = this.lane(accountId, nowMs);
    const nowSec = Math.floor(nowMs / SEC_TO_MS);

    if (signal.offer !== undefined) {
      lane.offer = signal.offer;
      // The offer lives as long as the window that carried it.
      if (signal.unifiedResetAtSec !== undefined) {
        lane.offerResetAtSec = signal.unifiedResetAtSec;
      } else {
        delete lane.offerResetAtSec;
      }
      if (signal.offer === "control") {
        // Explicitly not offered the lane: drop any active phase.
        lane.phase = { kind: "idle" };
      }
    }
    if (signal.retryAfterMs !== undefined) lane.retryAfterMs = signal.retryAfterMs;
    if (signal.maxWaitMs !== undefined) lane.maxWaitMs = signal.maxWaitMs;
    if (signal.budgetUtilization !== undefined) {
      lane.budgetUtilization = signal.budgetUtilization;
    }

    // Wrap-up (grace) window: pre-lane stage, >0 means still serving.
    if (signal.graceUtilization !== undefined) {
      const serving = signal.graceUtilization.fiveHour > 0 || signal.graceUtilization.sevenDay > 0;
      const untilSec =
        signal.fiveHourResetAtSec ??
        signal.unifiedResetAtSec ??
        signal.weeklyResetAtSec ??
        lane.wrapUpUntilSec;
      if (serving && untilSec !== undefined) {
        lane.wrapUpUntilSec = untilSec;
      } else {
        delete lane.wrapUpUntilSec;
      }
    }

    // A `control` offer means the account may not enter the lane at all, so it
    // dominates any status carried on the same response.
    const laneForbidden = signal.offer === "control";

    switch (laneForbidden ? undefined : signal.status) {
      case "active":
      case "not_needed":
      case "slot_busy": {
        // The lane lives inside the window named by the hit limit's reset.
        const resetsAtSec =
          signal.unifiedResetAtSec ??
          signal.fiveHourResetAtSec ??
          signal.weeklyResetAtSec ??
          nowSec + ACTIVE_GRACE_SEC;
        lane.phase = { kind: "active", resetsAtSec };
        break;
      }
      case "weekly_limit": {
        lane.phase = {
          kind: "blocked",
          reason: "weekly",
          untilSec: signal.weeklyResetAtSec ?? signal.unifiedResetAtSec ?? nowSec,
        };
        break;
      }
      case "budget_exhausted": {
        const stated = signal.budgetResetAtSec ?? signal.unifiedResetAtSec ?? nowSec;
        lane.phase = {
          kind: "blocked",
          reason: "budget",
          untilSec: Math.min(stated, nowSec + BUDGET_BLOCK_MAX_SEC),
        };
        break;
      }
      case "ineligible":
      case "off":
      case "unrecognized":
        // Lane closed / unusable. `unrecognized` is not evidence of a live
        // lane, so it ends one rather than extending it.
        lane.phase = { kind: "idle" };
        break;
      default:
        break;
    }

    // Overage in use means extra usage is serving the request: the lane has
    // been superseded, so end it.
    if (signal.overageInUse || signal.unifiedLimitClaim) {
      lane.phase = { kind: "idle" };
    }

    return lane;
  }

  /** Read a lane, expiring it first. Idle (or absent) when nothing is live. */
  lane(accountId: string, nowMs = Date.now()): ClaudeSlowLane {
    const existing = this.lanes.get(accountId);
    if (existing === undefined) {
      return this.create(accountId, { kind: "idle" }, nowMs);
    }
    this.expire(existing, nowMs);
    return existing;
  }

  /** True when the account has a live slow lane (routing may send the header). */
  isActive(accountId: string, nowMs = Date.now()): boolean {
    return this.lane(accountId, nowMs).phase.kind === "active";
  }

  /**
   * Mark a max-wait give-up: the lane stops and the account cools off before
   * the lane may be re-entered.
   */
  coolOff(accountId: string, nowMs = Date.now()): void {
    const lane = this.lane(accountId, nowMs);
    lane.phase = { kind: "idle" };
    lane.coolingOffUntilMs = nowMs + COOLING_OFF_MS;
  }

  /** True while a give-up cool-off is still in force. */
  isCoolingOff(accountId: string, nowMs = Date.now()): boolean {
    const until = this.lanes.get(accountId)?.coolingOffUntilMs;
    return until !== undefined && nowMs < until;
  }

  /** Drop one lane (used after a terminal lane end). */
  reset(accountId: string): void {
    this.lanes.delete(accountId);
  }

  /** Drop every lane — restart-equivalent state. */
  clear(): void {
    this.lanes.clear();
  }

  /** Live lane count, for tests and diagnostics. */
  get size(): number {
    return this.lanes.size;
  }

  private create(
    accountId: string,
    phase: ClaudeSlowPhase,
    nowMs: number,
  ): ClaudeSlowLane {
    if (this.lanes.size >= this.maxEntries) {
      // Oldest-first eviction; Map preserves insertion order.
      const oldest = this.lanes.keys().next();
      if (!oldest.done) this.lanes.delete(oldest.value);
    }
    const lane: ClaudeSlowLane = { phase };
    this.lanes.set(accountId, lane);
    this.expire(lane, nowMs);
    return lane;
  }

  /** Deadline-driven expiry: fold a lapsed lane back to idle. */
  private expire(lane: ClaudeSlowLane, nowMs: number): void {
    const nowSec = Math.floor(nowMs / SEC_TO_MS);

    if (lane.coolingOffUntilMs !== undefined && nowMs >= lane.coolingOffUntilMs) {
      delete lane.coolingOffUntilMs;
    }
    if (lane.offerResetAtSec !== undefined && nowSec >= lane.offerResetAtSec) {
      delete lane.offerResetAtSec;
      delete lane.offer;
    }
    if (lane.wrapUpUntilSec !== undefined && nowSec >= lane.wrapUpUntilSec) {
      delete lane.wrapUpUntilSec;
    }

    const phase = lane.phase;
    if (phase.kind === "active") {
      // Active expires at its reset plus a grace window.
      if (nowSec >= phase.resetsAtSec + ACTIVE_GRACE_SEC) lane.phase = { kind: "idle" };
      return;
    }
    if (phase.kind === "blocked" && nowSec >= phase.untilSec) {
      lane.phase = { kind: "idle" };
    }
  }
}

/** Process-wide lane registry (§3: in-memory, all lanes idle on restart). */
export const sharedClaudeSlowLanes = new ClaudeSlowLanes();
