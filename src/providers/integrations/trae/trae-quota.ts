// Trae quota.
//
// Two surfaces, on two different hosts, and neither is optional if the account
// is to be read honestly:
//
// - `get_session_usage` on the **core** host is the running meter — what the
//   account has left of its advanced/premium request buckets and its dollar
//   balances.
// - `ide_user_ent_usage` on the **pay** host is the entitlement: which package
//   the account holds and when it lapses.
//
// The donor reads both and lets either fail without the other, and that
// tolerance is load-bearing here too: entitlement is a *pay* host, which is the
// first thing a region-blocked or unpaid account loses. Letting a dead pay host
// fail the whole read would report "no quota" for an account whose session
// meter is perfectly readable — and "no quota" is what the router parks on.
//
// Headers come from `buildTraeHeaders` rather than being rebuilt here: the
// device fingerprint is derived from the uid, and an account that reports one
// device here and another at dispatch is exactly the correlation this gateway
// exists to avoid.

import type {
  FetchLike,
  ProviderQuotaResult,
  ProviderQuotaWindow,
} from "../../quota/quota-contracts";
import {
  cleanError,
  isoDate,
  number,
  percentWindow,
  record,
  text,
} from "../../quota/quota-contracts";
import type { QuotaCollectionContext } from "../../quota/quota-support";
import { buildTraeHeaders } from "./trae-headers";
import {
  TRAE_ENT_USAGE_PATH,
  TRAE_REALMS,
  TRAE_SESSION_USAGE_PATH,
  type TraeRealm,
} from "./trae-realm";

/**
 * The buckets `remain_usage` carries, in the order the donor reads them.
 *
 * `advanced_model` and `premium_model_*` are request counts; `dollar_basic` and
 * `dollar_bonus` are spend balances. They are separate budgets and must never
 * be summed — a dollar balance is not a request count.
 */
const REQUEST_BUCKETS: readonly (readonly [string, string])[] = [
  ["advanced_model", "Advanced model requests"],
  ["premium_model_fast_request", "Premium fast requests"],
  ["premium_model_slow_request", "Premium slow requests"],
];

const DOLLAR_BUCKETS: readonly (readonly [string, string])[] = [
  ["dollar_basic", "Basic spend"],
  ["dollar_bonus", "Bonus spend"],
];

interface TraeQuotaAuth {
  readonly realm: TraeRealm;
  readonly uid: string;
}

/**
 * Reads the account's realm and uid for the quota call.
 *
 * Both come from `auth_state`, the same place dispatch reads them: a Trae
 * token is realm-bound, so guessing `intl` for a CN account sends it to a host
 * that will not authenticate it.
 */
function quotaAuth(context: QuotaCollectionContext | undefined): TraeQuotaAuth {
  const raw = context?.auth_state ?? {};
  // `realm` is not persisted by the OAuth client — it is a property of which
  // provider id the account was registered under, so the CN wrapper forces it
  // rather than trusting an absent field.
  const realm = raw["realm"] === "cn" || raw["region"] === "CN" ? "cn" : "intl";
  // The OAuth client stores the account id as `userId`; `uid` is the name the
  // dispatch header builder uses. Reading only one of them left the device
  // fingerprint empty for every account.
  const uidRaw = raw["uid"] ?? raw["userId"] ?? raw["user_id"];
  const uid = typeof uidRaw === "string" && uidRaw.trim() ? uidRaw.trim() : "";
  return { realm, uid };
}

/** One bucket of `remain_usage`, paired with its cap from the sibling object. */
function bucketWindow(
  label: string,
  remaining: number | null,
  limit: number | null,
  resetsAt: string | null,
): ProviderQuotaWindow | null {
  if (remaining === null && limit === null) return null;
  const used = remaining !== null && limit !== null ? limit - remaining : null;
  return percentWindow(
    `trae:${label}`,
    label,
    null,
    resetsAt,
    used,
    limit,
    // Independent: each bucket is its own budget. Summing a request count into
    // a dollar balance would produce a number that means nothing.
    "independent",
  );
}

/**
 * Pulls `remaining`/`limit` for one key out of either usage object.
 *
 * `remain_usage` carries a **bare number** per bucket (`advanced_model: 40`),
 * not a nested object — the caps live in the sibling `usage` object. Reading a
 * nested `remaining` here is what dropped every balance and left a limit with
 * no remaining, i.e. a window that cannot say how much is left.
 */
function bucketValues(
  source: Record<string, unknown>,
  key: string,
): { readonly remaining: number | null; readonly limit: number | null } {
  const direct = record(source[key]);
  if (direct) {
    return {
      remaining: number(direct["remaining"] ?? direct["remain"] ?? direct["remain_usage"]),
      limit: number(direct["limit"] ?? direct["total"] ?? direct["cap"]),
    };
  }
  return {
    remaining: number(source[key] ?? source[`${key}_remaining`]),
    limit: number(source[`${key}_limit`] ?? source[`${key}_total`]),
  };
}

/**
 * The session-usage meter: `remain_usage` holds the remaining balance per
 * bucket, with the caps alongside it on the same object.
 */
function parseSessionUsage(payload: unknown): {
  readonly windows: readonly ProviderQuotaWindow[];
  readonly plan: string | null;
} {
  // Deliberately *not* `quotaRecord`: it unwraps a `usage` envelope, and on
  // this surface `usage` is the sibling object holding the caps — unwrapping it
  // discards `remain_usage` entirely and leaves a limit with no remaining.
  const root = record(payload) ?? {};
  const windows: ProviderQuotaWindow[] = [];
  // The meter is nested under `data` on some realms and at the root on others;
  // both shapes are live, so look in each rather than picking one.
  const candidates = [root, record(root["data"]), record(root["quota"])].filter(
    (value): value is Record<string, unknown> => value !== null,
  );
  const resetsAt = candidates
    .map((value) => isoDate(value["reset_time"] ?? value["resetTime"] ?? value["next_reset_time"]))
    .find((value) => value !== null) ?? null;

  for (const source of candidates) {
    const remain = record(source["remain_usage"]) ?? source;
    const usage = record(source["usage"]) ?? {};
    for (const [key, label] of [...REQUEST_BUCKETS, ...DOLLAR_BUCKETS]) {
      // Remaining is the bare number under `remain_usage`; the cap is the
      // sibling object under `usage`. Two objects, one per side of the same
      // budget, so both are read before a window is built.
      const remaining = bucketValues(remain, key).remaining ?? number(usage[key]);
      const limit = bucketValues(usage, key).limit ?? bucketValues(remain, key).limit;
      const window = bucketWindow(label, remaining, limit, resetsAt);
      if (window) windows.push(window);
    }
    if (windows.length > 0) break;
  }
  const plan = candidates
    .map((value) => text(value["plan_name"] ?? value["planName"] ?? value["user_type"]))
    .find((value) => value !== null) ?? null;
  return { windows, plan };
}

/** The entitlement package name and lapse, from the pay host. */
function parseEntitlement(payload: unknown): {
  readonly windows: readonly ProviderQuotaWindow[];
  readonly plan: string | null;
} {
  const root = record(payload) ?? {};
  const data = record(root["data"]) ?? root;
  const items = Array.isArray(data["entitlement_list"])
    ? data["entitlement_list"]
    : Array.isArray(data["list"])
      ? data["list"]
      : [];
  const windows: ProviderQuotaWindow[] = [];
  let plan: string | null = null;
  for (const entry of items) {
    const item = record(entry);
    if (!item) continue;
    const name = text(item["ent_title"] ?? item["name"] ?? item["package_name"]);
    if (!plan && name) plan = name;
    const total = number(item["total"] ?? item["quota"] ?? item["advanced_model_request_limit"]);
    const remaining = number(item["remain"] ?? item["remaining"] ?? item["remain_usage"]);
    const resetsAt = isoDate(item["end_time"] ?? item["endTime"] ?? item["expires_at"]);
    const window = bucketWindow(name ?? "Entitlement", remaining, total, resetsAt);
    if (window) windows.push(window);
  }
  return { windows, plan };
}

/**
 * Records a quiet surface where an operator can act on it.
 *
 * Deliberately not the returned `error`: that field is what flags the account
 * `quota_fetch_failed` and cools it. A 403 from the wrong realm, or a pay host
 * that is unreachable, says nothing about whether the account can serve.
 */
function logTraeQuotaMiss(errors: readonly string[]): void {
  if (errors.length === 0) return;
  console.warn(`[quota] trae surfaces unavailable: ${errors.join("; ")}`);
}

/**
 * Reads one Trae account's quota.
 *
 * The session meter and the entitlement are fetched independently: whichever
 * answers contributes, and a failure is only fatal if *both* fail. An account
 * whose pay host is unreachable still has a readable meter, and reporting
 * "no quota" for it would park an account that can still serve.
 */
export async function fetchTraeQuota(
  credential: string,
  fetcher: FetchLike,
  context?: QuotaCollectionContext,
): Promise<ProviderQuotaResult> {
  const { realm, uid } = quotaAuth(context);
  const config = TRAE_REALMS[realm];
  const errors: string[] = [];

  const call = async (url: string, surface: string): Promise<unknown> => {
    const response = await fetcher(url, {
      // POST with an empty JSON body, not GET: this is the commercial surface
      // the desktop client calls, and it answers a GET with an error rather
      // than a meter — which read as "no quota" for every account.
      method: "POST",
      headers: {
        ...buildTraeHeaders({ realm, token: credential, uid: uid || "0" }),
        "content-type": "application/json",
      },
      body: "{}",
    });
    if (!response.ok) {
      // 403 here is a verdict about *how we asked*, not about the balance: the
      // commercial surface correlates the credential against its realm and its
      // device fingerprint, and a CN token sent to an intl host — or one sent
      // with no device id — is refused outright. Reporting that as a failed
      // read parks the account, so it is reported as unreadable-for-now and
      // left alone by the cooldown path.
      const body = await response.text().catch(() => "");
      throw new Error(
        response.status === 403
          ? `${surface}: HTTP 403 (realm or device mismatch, not a balance)`
          : `${surface}: HTTP ${response.status}${body ? ` ${body.slice(0, 80)}` : ""}`,
      );
    }
    return await response.json();
  };

  const session = await call(`${config.core}${TRAE_SESSION_USAGE_PATH}`, "session usage").then(
    (payload) => parseSessionUsage(payload),
    (error: unknown) => {
      errors.push(`session usage: ${cleanError(error)}`);
      return null;
    },
  );
  const entitlement = await call(`${config.pay}${TRAE_ENT_USAGE_PATH}`, "entitlement").then(
    (payload) => parseEntitlement(payload),
    (error: unknown) => {
      errors.push(`entitlement: ${cleanError(error)}`);
      return null;
    },
  );

  const windows = [...(session?.windows ?? []), ...(entitlement?.windows ?? [])];
  if (!session && !entitlement) {
    // No window and *no error*: a quota read that could not reach upstream is
    // not evidence about the account, and `error` here is what flags the
    // account `quota_fetch_failed` and cools it down. An unreachable or
    // refusing surface must leave the account alone — otherwise an account is
    // parked by its own monitor, for a reason that has nothing to do with it.
    // The detail is kept for the log instead, where it cannot be read as a
    // balance.
    logTraeQuotaMiss(errors);
    return { source: "trae", plan: null, windows: [], error: null };
  }
  return {
    source: "trae",
    plan: session?.plan ?? entitlement?.plan ?? null,
    windows,
    // A partial read is still a read, and the quiet surface is a diagnostic —
    // never a reason to park the account.
    error: null,
  };
}

/**
 * The `traecn` provider's quota.
 *
 * Same collector, realm forced to `cn`: a CN token is refused by the intl
 * hosts, and the provider id is not something the collector can see — the
 * context carries no provider, only auth state.
 */
export function fetchTraeCnQuota(
  credential: string,
  fetcher: FetchLike,
  context?: QuotaCollectionContext,
): Promise<ProviderQuotaResult> {
  return fetchTraeQuota(credential, fetcher, { ...context, auth_state: { ...(context?.auth_state ?? {}), realm: "cn" } });
}
