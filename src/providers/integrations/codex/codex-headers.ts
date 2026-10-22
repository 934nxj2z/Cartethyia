/**
 * Codex ChatGPT identity headers and the `client_metadata` / turn-metadata
 * envelope. Kept with the provider (not in `src/protocol/codecs.ts`)
 * because it depends on Codex account identity via `getCodexAccountId`.
 */
import { getCodexAccountId } from "./codex-identity";
import type { ResolvedCredential } from "../../provider-contracts";
import { toAsciiJsonString } from "../../../protocol/codecs";
import { buildCodexUserAgent } from "../../operations/cli-platform";

interface CodexIdentityHeadersOptions {
  readonly credential: ResolvedCredential;
  readonly version: string;
  readonly attestation?: string | undefined;
  readonly residency?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly threadId?: string | undefined;
  readonly windowId?: string | undefined;
  readonly turnMetadataJson?: string | undefined;
  readonly betaFeatures?: string | undefined;
  readonly subAgent?: string | undefined;
  readonly responsesLite?: boolean | undefined;
  readonly turnState?: string | undefined;
}

/**
 * Assembles the request headers the reference ChatGPT-OAuth Responses
 * dispatch sends (`codex-rs` rust-v0.160.0):
 *
 * - default client headers (`default_headers`): `originator`, `user-agent`
 *   (no `version` header at this tag);
 * - auth (`add_auth_headers`): `authorization`, `chatgpt-account-id`;
 * - per-request extras (`build_responses_options`): `x-codex-beta-features`?,
 *   `x-codex-turn-state`?, `x-oai-attestation`?, lite header when Responses
 *   Lite, the compatibility projection (`x-codex-window-id`,
 *   `x-codex-turn-metadata`, `x-codex-parent-thread-id`?, `x-openai-subagent`?);
 * - transport options (`ApiResponsesOptions` + stream wrapper):
 *   `x-client-request-id` / `session-id` / `thread-id` / `x-openai-subagent`?.
 *
 * Identity values that moved into the body (`client_metadata` — installation,
 * turn id, parent turn id) are absent here by design. `conversation-id`,
 * `turn-id`, `parent-turn-id` direct headers and `x-codex-routing-hint`
 * (WebSocket-only at this tag) are not emitted.
 */
export function buildCodexIdentityHeaders(
  options: CodexIdentityHeadersOptions,
): Record<string, string> {
  const headers: Record<string, string> = {};
  headers["user-agent"] = buildCodexUserAgent(options.version);
  headers["originator"] = "codex_cli_rs";
  const token =
    options.credential.secret === undefined
      ? undefined
      : new TextDecoder().decode(options.credential.secret);
  const accountId =
    options.credential.account_id ??
    (token === undefined ? undefined : getCodexAccountId(token));
  if (accountId !== undefined && accountId.length > 0)
    headers["chatgpt-account-id"] = accountId;
  if (options.attestation !== undefined && options.attestation.length > 0)
    headers["x-oai-attestation"] = options.attestation;
  if (options.residency !== undefined && options.residency.length > 0)
    headers["x-openai-internal-codex-residency"] = options.residency;
  if (options.sessionId !== undefined && options.sessionId.length > 0) {
    headers["session-id"] = options.sessionId;
  }
  if (options.threadId !== undefined && options.threadId.length > 0) {
    headers["thread-id"] = options.threadId;
    headers["x-client-request-id"] = options.threadId;
  }
  if (options.windowId !== undefined && options.windowId.length > 0)
    headers["x-codex-window-id"] = options.windowId;
  if (
    options.turnMetadataJson !== undefined &&
    options.turnMetadataJson.length > 0
  ) {
    headers["x-codex-turn-metadata"] = options.turnMetadataJson;
  }
  if (options.betaFeatures !== undefined && options.betaFeatures.length > 0) {
    headers["x-codex-beta-features"] = options.betaFeatures;
  }
  if (options.subAgent !== undefined && options.subAgent.length > 0) {
    headers["x-openai-subagent"] = options.subAgent;
  }
  if (options.responsesLite === true) {
    headers["x-openai-internal-codex-responses-lite"] = "true";
  }
  if (options.turnState !== undefined && options.turnState.length > 0) {
    headers["x-codex-turn-state"] = options.turnState;
  }
  return headers;
}

/**
 * Builds the Codex `client_metadata` envelope and turn-metadata JSON.
 */
export function createCodexRequestMetadata(args: {
  installationId: string;
  sessionId: string;
  threadId: string;
  windowId: string;
  turnId: string;
  parentTurnId?: string;
  subAgent?: string;
  requestKind?: string;
  turnStartedAtUnixMs?: number;
  compaction?: Record<string, unknown>;
}): {
  clientMetadata: Record<string, string>;
  turnMetadataJson: string;
} {
  const requestKind = args.requestKind ?? "turn";
  const turnMetadata: Record<string, unknown> = {
    installation_id: args.installationId,
    session_id: args.sessionId,
    thread_id: args.threadId,
    turn_id: args.turnId,
    window_id: args.windowId,
    request_kind: requestKind,
  };
  if (args.parentTurnId !== undefined && args.parentTurnId.length > 0)
    turnMetadata["parent_turn_id"] = args.parentTurnId;
  if (args.compaction !== undefined)
    turnMetadata["compaction"] = args.compaction;
  if (args.turnStartedAtUnixMs !== undefined)
    turnMetadata["turn_started_at_unix_ms"] = args.turnStartedAtUnixMs;
  const turnMetadataJson = toAsciiJsonString(turnMetadata);
  const clientMetadata: Record<string, string> = {
    "x-codex-installation-id": args.installationId,
    session_id: args.sessionId,
    thread_id: args.threadId,
    "x-codex-window-id": args.windowId,
    turn_id: args.turnId,
  };
  if (args.parentTurnId !== undefined && args.parentTurnId.length > 0)
    clientMetadata["parent_turn_id"] = args.parentTurnId;
  if (args.subAgent !== undefined && args.subAgent.length > 0)
    clientMetadata["x-openai-subagent"] = args.subAgent;
  clientMetadata["x-codex-turn-metadata"] = turnMetadataJson;
  return { clientMetadata, turnMetadataJson };
}
