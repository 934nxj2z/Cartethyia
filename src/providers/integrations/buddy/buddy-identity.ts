import type { ProviderDispatchContext } from "../../provider-contracts";

/**
 * Which upstream client a buddy provider presents itself as.
 *
 * `desktop` is what every buddy provider sends today and stays the default for
 * all four. `cli` is the identity the reference gateways use for CLI traffic: a
 * different header set, a different User-Agent formula, and a different CN
 * upstream.
 *
 * Nothing flips to `cli` implicitly. Being wrong here is what gets an account
 * blocked upstream, so a provider changes identity only when an operator or an
 * account says so.
 */
export type BuddyIdentity = "desktop" | "cli";

/**
 * Resolves the identity one buddy dispatch presents.
 *
 * Precedence is account then provider: an account authorized as a CLI keeps
 * that identity even when the provider default changes, because the upstream
 * recorded it at login. The provider-level flag is
 * `compatibilityProfile.cli_identity`, already declared, validated, and
 * defaulted — it just never reached these adapters before.
 */
export function resolveBuddyIdentity(
  context: ProviderDispatchContext | undefined,
  profileIdentity?: boolean | undefined,
): BuddyIdentity {
  const accountRaw = context?.credential.auth_state?.["cliIdentity"];
  if (accountRaw === true) return "cli";
  if (accountRaw === false) return "desktop";
  return profileIdentity === true ? "cli" : "desktop";
}

/**
 * The upstream's `X-User-Id` for a buddy dispatch.
 *
 * The reference CLI sends the literal `anonymous` when it has no uid rather
 * than omitting the header, so an unauthenticated dispatch still looks like a
 * client rather than like a caller that forgot a header.
 */
export function buddyUserId(context?: ProviderDispatchContext): string {
  const accountId = context?.credential.account_id;
  return accountId !== undefined && accountId.length > 0 ? accountId : "anonymous";
}
