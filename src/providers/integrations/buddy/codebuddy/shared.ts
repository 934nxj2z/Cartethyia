import { withBearerAuthentication, type OpenAICompatibleAdapterConfig } from "../../../adapters/compatible-adapter";
import type { CanonicalRequest } from "../../../../protocol/canonical-model";
import type { ProviderDispatchContext, ProviderDispatchTarget, ProviderId } from "../../../provider-contracts";
import { resolveInboundSessionId } from "../../../operations/session-resolution";
import { buddyConversationHeaders } from "../buddy-conversation-headers";
import { buddyUserId, resolveBuddyIdentity } from "../buddy-identity";
import { buildCodeBuddyUserAgent, getCodeBuddyCnVersion, getCodeBuddyVersion } from "../../../operations/client-versions";
import { readBuddyDeviceToken } from "../workbuddy/shared";
import { buddyCliHeaders, buddyCliTraceHeaders } from "../buddy-cli-headers";

/** Client identity variant behind the per-request CodeBuddy headers. */
export type CodeBuddyVariant = "IDE" | "CLI";

export function codebuddyDomain(variant: CodeBuddyVariant): string {
  return variant === "IDE" ? "www.codebuddy.ai" : "copilot.tencent.com";
}


/**
 * Per-request CodeBuddy headers — exact provider contract shared by the
 * international (IDE identity) and CN (CLI identity). The stable conversation
 * header is preserved from the client when available; request IDs rotate.
 *
 * `cliIdentity` selects the real CLI contract rather than today's hybrid: the
 * reference CLI is issued by the OpenAI Node SDK, so it carries no browser
 * headers and no device token, and it adds the agent envelope. Left unset it
 * keeps the current behaviour for every provider.
 */
export async function codebuddyHeaders(
  variant: CodeBuddyVariant,
  context?: ProviderDispatchContext,
  request?: CanonicalRequest,
  cliIdentity?: boolean,
): Promise<Record<string, string>> {
  const identity = variant === "IDE" ? "IDE" : "CLI";
  const ua = buildCodeBuddyUserAgent(identity);
  const deviceToken = readBuddyDeviceToken(context);
  const conversationId = resolveInboundSessionId(context, request);
  const conversation = buddyConversationHeaders({
    ...(conversationId === undefined ? {} : { conversationId }),
  });
  if (resolveBuddyIdentity(context, cliIdentity) === "cli") {
    return {
      // The reference is explicit: the official CLI sends `Accept:
      // application/json` and no browser header at all — no
      // `X-Requested-With`, no `x-codebuddy-request`, no device token. A
      // request carrying both halves is a hybrid no real client produces.
      accept: "application/json",
      "User-Agent": `CLI/${getCodeBuddyVersion()} CodeBuddy/${getCodeBuddyVersion()}`,
      "X-Product": "SaaS",
      "X-IDE-Type": "CLI",
      "X-IDE-Name": "CLI",
      "X-IDE-Version": getCodeBuddyVersion(),
      "X-Domain": codebuddyDomain(variant),
      ...conversation,
      ...buddyCliTraceHeaders(conversation),
      ...buddyCliHeaders({ userId: buddyUserId(context) }),
    };
  }
  return {
    accept: "text/event-stream",
    "User-Agent": ua,
    "X-Product": "SaaS",
    "X-IDE-Type": identity,
    "X-IDE-Name": identity,
    // Every reference branch sends this, in both the desktop and the CLI
    // product; its absence here is what made a CodeBuddy dispatch the only
    // buddy caller with no client version on the wire.
    "X-IDE-Version": identity === "CLI" ? getCodeBuddyCnVersion() : getCodeBuddyVersion(),
    "X-Domain": codebuddyDomain(variant),
    "x-requested-with": "XMLHttpRequest",
    "x-codebuddy-request": "1",
    // Same family WorkBuddy sends: the upstream's channel check reads the
    // turn-level aggregation key, and a chat request without it is refused for a
    // missing conversation id.
    ...conversation,
    ...(deviceToken === undefined ? {} : { "X-Device-Token": deviceToken }),
  };
}

/**
 * Shared OpenAI-compatible chat-adapter config for both CodeBuddy variants:
 * bearer auth, chat-only wire contract, per-request identity headers, and the
 * variant's payload hook.
 */
export function codebuddyAdapterConfig(args: {
  providerId: ProviderId;
  baseUrl: string;
  variant: CodeBuddyVariant;
  prePayload: (
    payload: Record<string, unknown>,
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
  ) => void;
  fetchImpl?: typeof fetch;
  cliIdentity?: boolean;
}): OpenAICompatibleAdapterConfig {
  return withBearerAuthentication({
    provider_id: args.providerId,
    base_url: args.baseUrl,
    buildExtraHeaders: (context, request) =>
      codebuddyHeaders(args.variant, context, request, args.cliIdentity),
    prePayload: args.prePayload,
    ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
  });
}
