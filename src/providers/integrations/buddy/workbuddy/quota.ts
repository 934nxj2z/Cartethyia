import type { FetchLike, ProviderQuotaResult } from "../../../quota/quota-contracts";
import type { QuotaCollectionContext } from "../../../quota/quota-support";
import { providerBaseUrl } from "../../../provider-metadata";
import {
  buildWorkBuddyUserAgent,
  getWorkBuddyClientVersion,
  getWorkBuddyCnClientVersion,
  getWorkBuddyCliVersion,
} from "../../../operations/client-versions";
import { WORKBUDDY_DOMAIN } from "./shared";
import { fetchTencentBillingQuota } from "../buddy-quota-shared";
import { fetchBuddyRequestUsage, type BuddyUsageResult } from "../buddy-usage-shared";
import { buddyAccountUid } from "../buddy-oauth-shared";

/**
 * WorkBuddy international billing quota.
 *
 * Endpoint: POST https://www.workbuddy.ai/v2/billing/meter/get-user-resource
 * Request:  Authorization: Bearer <accessToken||apiKey>, desktop-client headers,
 *           X-User-Id for the account UID, and the reference filter envelope
 *           (ProductCode p_tcaca, statuses [0, 3], 101-year package window).
 * Response: { code: 0, data: { Response: { Data: { Accounts: [...] } } } }
 *
 * Same Tencent billing envelope as CodeBuddy CN, so the parsing is the shared
 * one in `buddy-quota-shared.ts`; only the endpoint and identity headers are
 * WorkBuddy-specific.
 */

export const WORKBUDDY_USAGE_URL =
  `${providerBaseUrl("workbuddy")}/v2/billing/meter/get-user-resource`;

export const WORKBUDDY_REQUEST_USAGE_URL =
  `${providerBaseUrl("workbuddy")}/billing/meter/get-user-request-usage`;
export const WORKBUDDY_CN_REQUEST_USAGE_URL =
  `${providerBaseUrl("workbuddycn")}/billing/meter/get-user-request-usage`;

async function billingHeaders(
  domain: string,
  clientVersion: string,
  enterpriseId?: string,
): Promise<Record<string, string>> {
  return {
    "User-Agent": buildWorkBuddyUserAgent(clientVersion, getWorkBuddyCliVersion()),
    "X-Product": "SaaS",
    "X-Domain": domain,
    "X-Requested-With": "XMLHttpRequest",
    "X-CodeBuddy-Request": "1",
    "Accept-Language": "en-US",
    ...(enterpriseId === undefined || enterpriseId.length === 0
      ? {}
      : { "X-Tenant-Id": enterpriseId, "X-Enterprise-Id": enterpriseId }),
  };
}

/**
 * Fetches WorkBuddy quota via the Tencent billing endpoint.
 *
 * Auth: `Authorization: Bearer <credential>` (api_key and oauth both use
 * Bearer; the caller passes the resolved secret).
 */
export async function fetchWorkBuddyQuota(
  credential: string,
  fetcher: FetchLike,
  context?: QuotaCollectionContext,
): Promise<ProviderQuotaResult> {
  return fetchWorkBuddyQuotaFor({
    providerId: "workbuddy",
    display: "WorkBuddy",
    domain: WORKBUDDY_DOMAIN,
    credential,
    fetcher,
    ...(context === undefined ? {} : { context }),
  });
}

export async function fetchWorkBuddyCnQuota(
  credential: string,
  fetcher: FetchLike,
  context?: QuotaCollectionContext,
): Promise<ProviderQuotaResult> {
  return fetchWorkBuddyQuotaFor({
    providerId: "workbuddycn",
    display: "WorkBuddy CN",
    domain: "www.workbuddy.cn",
    credential,
    fetcher,
    ...(context === undefined ? {} : { context }),
  });
}

async function fetchWorkBuddyQuotaFor(args: {
  readonly providerId: "workbuddy" | "workbuddycn";
  readonly display: string;
  readonly domain: string;
  readonly credential: string;
  readonly fetcher: FetchLike;
  readonly context?: QuotaCollectionContext;
}): Promise<ProviderQuotaResult> {
  const { providerId, display, domain, credential, fetcher, context } = args;
  const authState = typeof context?.auth_state === "object" && context?.auth_state !== null
    ? (context.auth_state as Record<string, unknown>)
    : undefined;
  const enterpriseId = typeof authState?.enterpriseId === "string" ? authState.enterpriseId : undefined;
  const clientVersion = providerId === "workbuddycn"
    ? getWorkBuddyCnClientVersion()
    : getWorkBuddyClientVersion();
  return fetchTencentBillingQuota({
    source: providerId,
    display,
    url: `${providerBaseUrl(providerId)}/v2/billing/meter/get-user-resource`,
    headers: await billingHeaders(domain, clientVersion, enterpriseId),
    credential,
    fetcher,
    defaultPlan: display,
    uid: buddyAccountUid(credential),
  });
}

/**
 * Real credit deductions for one WorkBuddy account.
 *
 * Mirrors {@link fetchWorkBuddyQuotaFor} in every respect but the endpoint —
 * same billing host, same client-version identity headers, same account UID —
 * because the usage-detail surface is the billing meter's other read.
 */
export async function fetchWorkBuddyRequestUsage(
  credential: string,
  fetcher: FetchLike,
  args: {
    readonly providerId?: "workbuddy" | "workbuddycn";
    readonly days?: number;
    readonly context?: QuotaCollectionContext;
  } = {},
): Promise<BuddyUsageResult> {
  const providerId = args.providerId ?? "workbuddy";
  const domain = providerId === "workbuddycn" ? "www.workbuddy.cn" : WORKBUDDY_DOMAIN;
  const authState = typeof args.context?.auth_state === "object" && args.context?.auth_state !== null
    ? (args.context.auth_state as Record<string, unknown>)
    : undefined;
  const enterpriseId = typeof authState?.enterpriseId === "string" ? authState.enterpriseId : undefined;
  const clientVersion = providerId === "workbuddycn"
    ? getWorkBuddyCnClientVersion()
    : getWorkBuddyClientVersion();
  return fetchBuddyRequestUsage({
    url: `${providerBaseUrl(providerId)}/billing/meter/get-user-request-usage`,
    headers: await billingHeaders(domain, clientVersion, enterpriseId),
    credential,
    fetcher,
    days: args.days ?? 30,
    uid: buddyAccountUid(credential),
  });
}

export const fetchWorkBuddyCnRequestUsage = (
  credential: string,
  fetcher: FetchLike,
  days: number = 30,
): Promise<BuddyUsageResult> =>
  fetchWorkBuddyRequestUsage(credential, fetcher, { providerId: "workbuddycn", days });
