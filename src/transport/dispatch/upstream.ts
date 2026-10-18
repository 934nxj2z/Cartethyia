import type { CanonicalEvent } from "../../protocol/canonical-model";
import type { ValidatedOutboundFetch, ValidatedOutboundWebSocket } from "../../providers/provider-contracts";
import { GATEWAY_SECURITY_HEADERS } from "../../security/outbound-headers";

const FORWARDED_REQUEST_HEADERS = new Set([
  "user-agent",
  "anthropic-beta",
  "x-claude-code-session-id",
  "x-conversation-id",
  "x-session-id",
  "x-session-affinity",
  "x-opencode-session",
  "x-opencode-session-id",
  "x-opencode-project",
  "prompt-cache-key",
  "prompt_cache_key",
  "session-id",
]);

export function forwardedRequestHeaders(request: Request): Record<string, string> {
  const forwarded: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    if (FORWARDED_REQUEST_HEADERS.has(name.toLowerCase())) forwarded[name.toLowerCase()] = value;
  });
  return forwarded;
}

export function proxySuccessHeaders(state: { requestId: string }): Record<string, string> {
  return {
    "cache-control": "no-store",
    "x-request-id": state.requestId,
    ...GATEWAY_SECURITY_HEADERS,
  };
}

export function buildUpstreamDispatchContext(input: {
  readonly credential: unknown;
  readonly deadline: number;
  readonly signal: AbortSignal;
  readonly headers: Record<string, string>;
  readonly requestId?: string;
  readonly userAgent?: string;
  readonly outboundFetch?: ValidatedOutboundFetch;
  readonly outboundWebSocket?: ValidatedOutboundWebSocket;
  /** Stable per-conversation cache affinity (preferred over random ids). */
  readonly conversationAffinity?: string;
  /** Opaque identity shared by retries of one logical gateway request. */
  readonly requestIdentity?: object;
}): Record<string, unknown> {
  const credentialKind =
    typeof input.credential === "object" && input.credential !== null && "credential_kind" in input.credential
      ? input.credential.credential_kind
      : undefined;
  const userAgent = credentialKind === "oauth" || credentialKind === "scoped_access_token"
    ? undefined
    : input.userAgent;
  const sourceFetch = input.outboundFetch;
  const outboundFetch =
    sourceFetch && userAgent
      ? (request: RequestInfo | URL, init?: RequestInit) => {
          const requestHeaders =
            init?.headers ?? (request instanceof Request ? request.headers : undefined);
          const headers = new Headers(requestHeaders);
          // Provider identity is authoritative; route identity fills only a missing header.
          if (!headers.has("user-agent")) headers.set("user-agent", userAgent);
          return sourceFetch(request, { ...init, headers });
        }
      : sourceFetch;
  return {
    credential: input.credential,
    deadline: input.deadline,
    abort_signal: input.signal,
    ...(input.requestId === undefined ? {} : { request_id: input.requestId }),
    ...(userAgent ? { user_agent: userAgent } : {}),
    ...(Object.keys(input.headers).length > 0 ? { request_headers: input.headers } : {}),
    ...(outboundFetch ? { outbound_fetch: outboundFetch } : {}),
    ...(input.outboundWebSocket ? { outbound_websocket: input.outboundWebSocket } : {}),
    ...(input.conversationAffinity ? { conversation_affinity: input.conversationAffinity } : {}),
    ...(input.requestIdentity ? { request_identity: input.requestIdentity } : {}),
  } as Record<string, unknown>;
}

/**
 * The model id an upstream put in its own response, verbatim.
 *
 * `response_start` is the only event that carries it, and the wire parsers fill
 * it from the payload's own `model` field. Read as-is — no prefix stripping, no
 * comparison against the request, no fallback to the requested id. A provider
 * that answers a `muse-spark` request as `deepseek-v4.1-flash` is telling the
 * operator something the request cannot, and filling in the ask when the
 * response carried none would report the ask as if it were the answer.
 */
export function reportedModelFrom(events: readonly CanonicalEvent[]): string | undefined {
  for (const event of events) {
    if (event.type !== "response_start" && event.type !== "message_start") continue;
    const model = event.model;
    if (typeof model === "string" && model.trim().length > 0) return model;
  }
  return undefined;
}
