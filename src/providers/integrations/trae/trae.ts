// Trae adapter.
//
// Realm-aware: `trae` (intl) and `traecn` (CN) share this code but nothing of
// the address, the authorization scheme, or the roster. The intl deployment
// additionally gates on the *current* client version, which is why the version
// here comes from `getTraeVersion()` (a live resolver) rather than a constant.

import { GatewayError } from "../../../protocol/gateway-error";
import type { CanonicalEvent, CanonicalRequest, CanonicalStopReason } from "../../../protocol/canonical-model";
import { usageFromProvider } from "../../provider-usage";
import {
  readCredentialSecret,
  type ProviderAdapter,
  type ProviderDispatchContext,
  type ProviderDispatchTarget,
  type ProviderId,
} from "../../provider-contracts";
import { mapUpstreamHttpError } from "../../../transport/failure-policy";
import { getTraeVersion } from "../../operations/client-versions";
import { abortGatewayError, createUpstreamDeadlineLifecycle } from "../../operations/upstream-deadline";
import { TRAE_CN_MODELS, TRAE_INTL_MODELS, traeMaxContextWindow } from "./trae-catalog";
import { buildTraeHeaders } from "./trae-headers";
import { buildTraeChatBody, parseTraeSse, TRAE_CHAT_ENDPOINT } from "./trae-protocol";
import { TRAE_REALMS, traeCoreCandidates, type TraeRealm } from "./trae-realm";

export interface TraeAdapterOptions {
  readonly providerId?: string;
  readonly realm?: TraeRealm;
  readonly fetch?: typeof fetch;
}

/** Identity resolved from a persisted credential. */
interface TraeAuth {
  readonly token: string;
  readonly uid: string;
}

const TRAE_PROVIDER_ID = "trae";
const TRAE_CN_PROVIDER_ID = "traecn";

/** Upstream finish reason → canonical stop reason. */
const STOP_REASONS: Readonly<Record<string, CanonicalStopReason>> = {
  stop: "stop",
  length: "length",
  tool_calls: "tool_use",
  function_call: "tool_use",
  content_filter: "content_filter",
};

/**
 * Reads the credential.
 *
 * Trae credentials are OAuth token pairs, so the whole JSON export is the
 * secret: extracting only the access token would drop the refresh token and
 * leave the account permanently unrefreshable. The refresh itself runs through
 * the registered OAuth refresher (`trae-oauth.ts`), not here — this only needs
 * the access token to authorize a request.
 */
function traeAuth(secret: string, accountId: string | undefined): TraeAuth {
  const token = extractToken(secret);
  if (token === undefined) {
    throw new GatewayError("authentication_failed", 401, "Trae credential has no access token", {}, "upstream");
  }
  return { token, uid: accountId ?? "" };
}

function extractToken(secret: string): string | undefined {
  const trimmed = secret.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const candidates = ["accessToken", "access_token", "token", "x-ide-token"];
      for (const key of candidates) {
        const value = parsed[key];
        if (typeof value === "string" && value.length > 0) return value;
      }
    } catch {
      // Fall through to the bare-token reading below.
    }
  }
  return trimmed.length > 0 ? trimmed : undefined;
}

class TraeAdapter implements ProviderAdapter {
  readonly provider_id: ProviderId;
  private readonly realm: TraeRealm;
  private readonly fetchFn: typeof fetch;

  constructor(options: TraeAdapterOptions = {}) {
    this.provider_id = (options.providerId ?? TRAE_PROVIDER_ID) as ProviderId;
    this.realm = options.realm ?? "intl";
    this.fetchFn = options.fetch ?? globalThis.fetch;
  }

  async *dispatch(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent> {
    if (candidate.wire_family !== "chat") {
      throw new GatewayError(
        "capability_unsupported",
        400,
        `trae supports chat only, got ${candidate.wire_family}`,
      );
    }
    const secret = readCredentialSecret(context.credential, "Trae credential is required");
    const modelId = candidate.model_id || request.model;
    const lifecycle = createUpstreamDeadlineLifecycle(context);
    const outboundFetch =
      (context.outbound_fetch as unknown as typeof fetch | undefined) ?? this.fetchFn;

    // intl refuses a stale client version with 4015, so the resolved version is
    // part of every request rather than a startup detail.
    const version = getTraeVersion();
    const auth = traeAuth(secret, context.credential.account_id);
    const body = buildTraeChatBody(modelId, request, this.realm);
    const headers = buildTraeHeaders({
      realm: this.realm,
      token: auth.token,
      uid: auth.uid,
      clientVersion: version,
      stream: true,
    });

    const primary = traeCoreCandidates(this.realm)[0] ?? "";
    const url =
      candidate.endpoint_path && candidate.endpoint_path.startsWith("http")
        ? candidate.endpoint_path
        : `${primary}${TRAE_CHAT_ENDPOINT}`;

    try {
      const response = await outboundFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: lifecycle.signal,
      });
      if (!response.ok) throw await mapUpstreamHttpError(response, this.provider_id);
      if (!response.body) {
        throw new GatewayError("platform_unavailable", 502, "Trae returned empty body", {}, "upstream");
      }
      // Headers arrived, so the pre-stream deadline has served its purpose;
      // from here the gateway's own stall watchdog governs the body.
      lifecycle.release();
      yield* this.#events(
        response.body as ReadableStream<Uint8Array>,
        lifecycle.signal,
        request.model,
      );
    } catch (err: unknown) {
      const abortError = abortGatewayError(lifecycle, err, context.abort_signal);
      if (abortError) throw abortError;
      throw err;
    } finally {
      lifecycle.release();
    }
  }

  async *#events(
    body: ReadableStream<Uint8Array>,
    _signal: AbortSignal,
    requestModel: string,
  ): AsyncIterable<CanonicalEvent> {
    let seq = 1;
    yield { type: "response_start", sequence_number: seq++, model: requestModel } as CanonicalEvent;
    let stopReason: CanonicalStopReason = "stop";
    let usage: Record<string, unknown> | undefined;

    for await (const frame of parseTraeSse(body)) {
      if (frame.event === "done") {
        const data = frame.data as { finish_reason?: unknown };
        if (typeof data.finish_reason === "string") {
          stopReason = STOP_REASONS[data.finish_reason] ?? "stop";
        }
        continue;
      }
      if (frame.event === "error") {
        const data = frame.data as { message?: unknown };
        const message = typeof data.message === "string" ? data.message : "Trae stream error";
        throw new GatewayError("platform_unavailable", 502, message, {}, "upstream");
      }
      if (typeof frame.data !== "object" || frame.data === null) continue;
      const record = frame.data as Record<string, unknown>;
      const chunk = record["chunk"];
      if (typeof chunk !== "object" || chunk === null) {
        if (record["usage"] !== undefined && typeof record["usage"] === "object") {
          usage = record["usage"] as Record<string, unknown>;
        }
        continue;
      }
      const payload = chunk as Record<string, unknown>;
      const text = payload["content"];
      if (typeof text === "string" && text.length > 0) {
        yield {
          type: "content_delta",
          sequence_number: seq++,
          content: { kind: "text", text },
        } as CanonicalEvent;
      }
      const reasoning = payload["reasoning_content"];
      if (typeof reasoning === "string" && reasoning.length > 0) {
        yield {
          type: "content_delta",
          sequence_number: seq++,
          content: { kind: "reasoning", payload: reasoning, summary: reasoning },
        } as CanonicalEvent;
      }
      if (typeof payload["finish_reason"] === "string") {
        stopReason = STOP_REASONS[payload["finish_reason"]] ?? "stop";
      }
      if (typeof payload["usage"] === "object" && payload["usage"] !== null) {
        usage = payload["usage"] as Record<string, unknown>;
      }
    }

    if (usage !== undefined) {
      yield* this.#usageEvent(usage, seq++);
    }
    yield { type: "response_stop", sequence_number: seq, stop_reason: stopReason } as unknown as CanonicalEvent;
  }

  /**
   * Emits the terminal usage event, or none at all.
   *
   * Trae reports usage with the OpenAI spelling (`prompt_tokens` /
   * `completion_tokens`). `usageFromProvider` normalizes both spellings and
   * returns `undefined` when nothing was actually reported, and an absent
   * usage event is correct in that case — emitting zeros would record a
   * request that cost nothing.
   */
  async *#usageEvent(usage: Record<string, unknown>, seq: number): AsyncIterable<CanonicalEvent> {
    const record = usageFromProvider(usage);
    if (record === undefined) return;
    yield { type: "usage", sequence_number: seq, usage: record } as unknown as CanonicalEvent;
  }
}

export function createTraeAdapter(options: TraeAdapterOptions = {}): ProviderAdapter {
  return new TraeAdapter(options);
}

/** Adapter for the China deployment: different host, auth scheme, and roster. */
export function createTraeCnAdapter(options: TraeAdapterOptions = {}): ProviderAdapter {
  return new TraeAdapter({
    ...options,
    realm: "cn",
    providerId: TRAE_CN_PROVIDER_ID,
  });
}

/**
 * Live model discovery.
 *
 * Only CN answers this endpoint; intl returns `403 no schema found`. The
 * adapter does not retry past that — the static roster is the honest answer for
 * intl, and pretending a fetch succeeded would leave a stale empty roster.
 */
export async function discoverTraeModels(input: {
  readonly realm: TraeRealm;
  readonly token: string;
  readonly uid: string;
  readonly fetcher: typeof fetch;
  readonly signal?: AbortSignal;
  readonly providerId?: string;
}): Promise<readonly { id: string; ctx: number | undefined }[]> {
  if (!TRAE_REALMS[input.realm].modelListSupported) return [];
  const headers = buildTraeHeaders({
    realm: input.realm,
    token: input.token,
    uid: input.uid,
  });
  const url = `${traeCoreCandidates(input.realm)[0] ?? ""}/api/ide/v1/model_list`;
  const response = await input.fetcher(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ type: "chat" }),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!response.ok) return [];
  const parsed = (await response.json()) as { data?: unknown; models?: unknown };
  const rows = Array.isArray(parsed.models) ? parsed.models : Array.isArray(parsed.data) ? parsed.data : [];
  return rows
    .filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null)
    .map((row) => ({
      id: String(row["name"] ?? row["id"] ?? "").trim(),
      ctx: traeMaxContextWindow(row),
    }))
    .filter((row) => row.id.length > 0);
}

export { TRAE_CN_MODELS, TRAE_INTL_MODELS };
