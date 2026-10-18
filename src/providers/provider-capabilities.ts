import type { ProviderModule, ProviderAuthentication } from "./provider-registry";
import type { OAuthLoginClient } from "./authentication/oauth-flow-store";
import type { QuotaFetcher } from "./quota/quota-support";

/** Provider implementation fields composed with canonical metadata. */
export type ProviderModuleCapabilities = Partial<Omit<ProviderModule, "loadAdapter">> &
  Pick<ProviderModule, "loadAdapter">;

/**
 * Creates a lazy authentication loader from a dynamic import and client export.
 * Most OAuth clients also refresh their own tokens.
 */
export function oauthCapability<M, K extends keyof M>(
  loader: () => Promise<M>,
  exportName: K,
  options: { readonly withRefresher?: boolean } = {},
): () => Promise<ProviderAuthentication> {
  return async () => {
    const module = await loader();
    const client = (module as Record<string, unknown>)[exportName as string] as OAuthLoginClient & { refresh: unknown };
    return options.withRefresher
      ? ({ client, refresher: client } as ProviderAuthentication)
      : ({ client } as ProviderAuthentication);
  };
}

/** Creates a lazy quota collector loader from a dynamic import and export name. */
export function quotaCapability<M, K extends keyof M>(
  loader: () => Promise<M>,
  exportName: K,
): () => Promise<QuotaFetcher> {
  return () => loader().then((module) => (module as Record<string, unknown>)[exportName as string] as QuotaFetcher);
}
