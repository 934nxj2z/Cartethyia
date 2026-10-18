import { withBearerAuthentication, type OpenAICompatibleAdapterConfig } from "../../../adapters/compatible-adapter";
import type { CanonicalRequest } from "../../../../protocol/canonical-model";
import type { ProviderDispatchContext, ProviderDispatchTarget, ProviderId } from "../../../provider-contracts";
import { resolveInboundSessionId } from "../../../operations/session-resolution";
import { buddyConversationHeaders } from "../buddy-conversation-headers";
import { buildCodeBuddyUserAgent } from "../../../operations/client-versions";
import { readBuddyDeviceToken } from "../workbuddy/shared";

/** Client identity variant behind the per-request CodeBuddy headers. */
export type CodeBuddyVariant = "IDE" | "CLI";

export function codebuddyDomain(variant: CodeBuddyVariant): string {
  return variant === "IDE" ? "www.codebuddy.ai" : "copilot.tencent.com";
}


/**
 * Per-request CodeBuddy headers — exact provider contract shared by the
 * international (IDE identity) and CN (CLI identity). The stable conversation
 * header is preserved from the client when available; request IDs rotate.
 */
export async function codebuddyHeaders(
  variant: CodeBuddyVariant,
  context?: ProviderDispatchContext,
  request?: CanonicalRequest,
): Promise<Record<string, string>> {
  const identity = variant === "IDE" ? "IDE" : "CLI";
  const ua = buildCodeBuddyUserAgent(identity);
  const deviceToken = readBuddyDeviceToken(context);
  const conversationId = resolveInboundSessionId(context, request);
  return {
    accept: "text/event-stream",
    "User-Agent": ua,
    "X-Product": "SaaS",
    "X-IDE-Type": identity,
    "X-IDE-Name": identity,
    "X-Domain": codebuddyDomain(variant),
    "x-requested-with": "XMLHttpRequest",
    "x-codebuddy-request": "1",
    // Same family WorkBuddy sends: the upstream's channel check reads the
    // turn-level aggregation key, and a chat request without it is refused with
    // `400 · 11128 "conversation id missing"`.
    ...buddyConversationHeaders({
      ...(conversationId === undefined ? {} : { conversationId }),
    }),
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
}): OpenAICompatibleAdapterConfig {
  return withBearerAuthentication({
    provider_id: args.providerId,
    base_url: args.baseUrl,
    buildExtraHeaders: (context, request) => codebuddyHeaders(args.variant, context, request),
    prePayload: args.prePayload,
    ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
  });
}
