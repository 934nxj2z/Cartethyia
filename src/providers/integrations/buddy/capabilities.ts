import type { ProviderModuleCapabilities } from "../../provider-capabilities";
import { oauthCapability, quotaCapability } from "../../provider-capabilities";

type BuddyProviderId = "cb" | "cbcn" | "workbuddy" | "workbuddycn";

/**
 * Lazy capability declarations for Buddy's four independently identified
 * regional products.
 */
export const BUDDY_PROVIDER_CAPABILITIES = {
  cb: {
    loadAdapter: async () => (await import("./codebuddy/provider")).createCodeBuddyAdapter(),
    loadModels: async () => (await import("./codebuddy/provider")).CODEBUDDY_MODELS,
    loadModelDiscovery: async () => async ({ credential, fetcher }) =>
      (await import("./codebuddy/provider")).discoverCodeBuddyModels({
        credential,
        ...(fetcher === undefined ? {} : { fetcher }),
      }),
    loadAuthentication: oauthCapability(
      () => import("./codebuddy/oauth"),
      "codeBuddyOAuthClient",
      { withRefresher: true },
    ),
    loadQuotaCollector: quotaCapability(
      () => import("./codebuddy/quota"),
      "fetchCodeBuddyIntlQuota",
    ),
  },
  cbcn: {
    loadAdapter: async () => (await import("./codebuddy/cn-provider")).createCodeBuddyCnAdapter(),
    loadModels: async () => (await import("./codebuddy/cn-provider")).CODEBUDDY_CN_MODELS,
    loadModelDiscovery: async () => async ({ credential, fetcher }) =>
      (await import("./codebuddy/cn-provider")).discoverCodeBuddyCnModels({
        credential,
        ...(fetcher === undefined ? {} : { fetcher }),
      }),
    loadAuthentication: oauthCapability(
      () => import("./codebuddy/oauth"),
      "codeBuddyCnOAuthClient",
      { withRefresher: true },
    ),
    loadQuotaCollector: quotaCapability(
      () => import("./codebuddy/quota"),
      "fetchCodeBuddyCnQuota",
    ),
  },
  workbuddy: {
    loadAdapter: async () => (await import("./workbuddy/provider")).createWorkBuddyAdapter(),
    loadModels: async () => (await import("./workbuddy/provider")).WORKBUDDY_MODELS,
    loadModelDiscovery: async () => async ({ credential, fetcher }) =>
      (await import("./workbuddy/provider")).discoverWorkBuddyModels({
        credential,
        ...(fetcher === undefined ? {} : { fetcher }),
      }),
    loadAuthentication: oauthCapability(
      () => import("./workbuddy/oauth"),
      "workBuddyOAuthClient",
      { withRefresher: true },
    ),
    loadQuotaCollector: quotaCapability(
      () => import("./workbuddy/quota"),
      "fetchWorkBuddyQuota",
    ),
  },
  workbuddycn: {
    loadAdapter: async () => (await import("./workbuddy/cn-provider")).createWorkBuddyCnAdapter(),
    loadModels: async () => (await import("./workbuddy/cn-provider")).WORKBUDDY_CN_MODELS,
    loadModelDiscovery: async () => async ({ credential, fetcher }) =>
      (await import("./workbuddy/cn-provider")).discoverWorkBuddyCnModels({
        credential,
        ...(fetcher === undefined ? {} : { fetcher }),
      }),
    loadAuthentication: oauthCapability(
      () => import("./workbuddy/cn-oauth"),
      "workBuddyCnOAuthClient",
      { withRefresher: true },
    ),
    loadQuotaCollector: quotaCapability(
      () => import("./workbuddy/quota"),
      "fetchWorkBuddyCnQuota",
    ),
  },
} satisfies Readonly<Record<BuddyProviderId, ProviderModuleCapabilities>>;
