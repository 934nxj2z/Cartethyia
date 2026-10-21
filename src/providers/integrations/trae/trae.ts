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
import {
  buildTraeChatBody,
  isTraeAgentEndpoint,
  parseTraeSse,
  toTraeAgentBody,
  TRAE_AGENT_ENDPOINT,
  TRAE_CHAT_ENDPOINT,
} from "./trae-protocol";
import { TRAE_REGION_CORE_HOSTS, traeCoreCandidates, type TraeRealm } from "./trae-realm";

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
  /**
   * Maps a frame's `index` to the call id seen for it.
   *
   * Argument fragments arrive without the id, so the association has to be
   * remembered between frames rather than read from the fragment itself.
   */
  readonly #toolCallIds = new Map<string, string>();

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
    /**
     * The endpoint follows the model, not the provider.
     *
     * Trae's two surfaces are disjoint and neither serves the other's ids, so
     * the roster's own `endpoint_path` decides. Falling back to the agent path
     * rather than the chat one matters: the intl catalog is agent-only, and a
     * caller whose target carries no route would otherwise land on a surface
     * that rejects every model in it.
     */
    const agentSurface = isTraeAgentEndpoint(candidate.endpoint_path);
    const payload = agentSurface ? toTraeAgentBody(body) : body;
    const headers = buildTraeHeaders({
      realm: this.realm,
      token: auth.token,
      uid: auth.uid,
      clientVersion: version,
      stream: true,
    });

    const primary = traeCoreForAccount(this.realm, context.credential.auth_state);
    const path = agentSurface ? TRAE_AGENT_ENDPOINT : TRAE_CHAT_ENDPOINT;
    const url =
      candidate.endpoint_path && candidate.endpoint_path.startsWith("http")
        ? candidate.endpoint_path
        : `${primary}${path}`;

    try {
      const response = await outboundFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
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
    /**
     * Tool calls arrive fragmented across frames and the id is not repeated.
     *
     * Upstream streams one `tool_calls` array per frame where only the first
     * carries `id`, only early frames carry `name`, and `arguments` arrives as
     * successive JSON fragments. So name is announced once on first sight of
     * the id and arguments are accumulated; emitting each frame verbatim would
     * produce several calls with empty ids.
     */
    const announced = new Set<string>();

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
      /**
       * Two frame layouts reach here and both are live.
       *
       * The donor's client nests the answer under `chunk`; the region host this
       * gateway talks to sends it flat — `event: output` with
       * `{"response":"…"}` — and reports usage as a separate `token_usage`
       * frame with the OpenAI spelling at the top level. Reading only `chunk`
       * made a working upstream look like an empty stream.
       */
      const chunk = record["chunk"];
      if (typeof chunk !== "object" || chunk === null) {
        const flat = record["response"];
        if (typeof flat === "string" && flat.length > 0) {
          yield {
            type: "content_delta",
            sequence_number: seq++,
            content: { kind: "text", text: flat },
          } as CanonicalEvent;
        }
        const flatReasoning = record["reasoning_content"];
        if (typeof flatReasoning === "string" && flatReasoning.length > 0) {
          yield {
            type: "content_delta",
            sequence_number: seq++,
            content: { kind: "reasoning", payload: flatReasoning, summary: flatReasoning },
          } as CanonicalEvent;
        }
        yield* this.#toolCallDeltas(record["tool_calls"], announced, () => seq++);
        if (typeof record["finish_reason"] === "string") {
          stopReason = STOP_REASONS[record["finish_reason"] as string] ?? "stop";
        }
        // `token_usage` frames carry the counters themselves, not under `usage`.
        const counters =
          record["usage"] !== undefined && typeof record["usage"] === "object"
            ? (record["usage"] as Record<string, unknown>)
            : frame.event === "token_usage" || record["prompt_tokens"] !== undefined
              ? record
              : undefined;
        if (counters !== undefined) usage = counters;
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
    // The canonical terminal is `terminal`; a stream that ends without one is
    // read as "the upstream never reported a result".
    yield {
      type: "terminal",
      sequence_number: seq,
      state: "complete",
      stop_reason: stopReason,
    } as unknown as CanonicalEvent;
  }

  /**
   * Emits canonical tool-call deltas from one `tool_calls` array.
   *
   * Upstream nests the payload under `function_call`, not OpenAI's `function`,
   * and spreads one call over many frames with three different shapes: the
   * first carries id and name, the middle ones carry `arguments` as successive
   * JSON fragments with an **empty** id, and the last repeats the id with no
   * arguments. Grouping by `index` is what ties them together — the id is
   * absent exactly when the arguments are present, so keying on id would drop
   * every fragment and yield `arguments: "{}"`.
   */
  async *#toolCallDeltas(
    raw: unknown,
    announced: Set<string>,
    nextSeq: () => number,
  ): AsyncIterable<CanonicalEvent> {
    if (!Array.isArray(raw)) return;
    for (const entry of raw) {
      if (typeof entry !== "object" || entry === null) continue;
      const call = entry as Record<string, unknown>;
      const fn = call["function_call"];
      const fnRecord = typeof fn === "object" && fn !== null ? (fn as Record<string, unknown>) : undefined;
      const name = typeof fnRecord?.["name"] === "string" ? (fnRecord["name"] as string) : undefined;
      const args = typeof fnRecord?.["arguments"] === "string" ? (fnRecord["arguments"] as string) : "";
      const declaredId = typeof call["id"] === "string" ? call["id"] : "";
      const index = typeof call["index"] === "number" ? call["index"] : 0;
      const slot = `idx:${index}`;

      if (declaredId.length > 0) {
        this.#toolCallIds.set(slot, declaredId);
        // The closing frame repeats a known id with no payload; emitting it
        // again would append a duplicate empty call.
        if (announced.has(declaredId)) continue;
        announced.add(declaredId);
        yield {
          type: "tool_call_delta",
          sequence_number: nextSeq(),
          call_id: declaredId,
          name: name ?? "",
          arguments_delta: "",
        } as CanonicalEvent;
        continue;
      }

      if (args.length === 0) continue;
      const id = this.#toolCallIds.get(slot);
      if (id === undefined) continue;
      yield {
        type: "tool_call_delta",
        sequence_number: nextSeq(),
        call_id: id,
        arguments_delta: args,
      } as CanonicalEvent;
    }
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
 * The listing is per account region, not per realm: it answers on CN and on the
 * intl region host that serves the account (`coresg-normal.trae.ai` verified),
 * while the generic intl core answers `403 no schema found`. An empty result is
 * therefore a real "this account has no listing", and the static roster stays
 * the fallback rather than being replaced by nothing.
 */
export async function discoverTraeModels(input: {
  readonly realm: TraeRealm;
  readonly token: string;
  readonly uid: string;
  readonly fetcher: typeof fetch;
  readonly signal?: AbortSignal;
  readonly providerId?: string;
  /** Account region, so the listing is asked of the host that serves it. */
  readonly region?: string;
}): Promise<readonly { id: string; ctx: number | undefined }[]> {
  const headers = buildTraeHeaders({
    realm: input.realm,
    token: input.token,
    uid: input.uid,
  });
  const url = `${traeCoreForAccount(input.realm, input.region === undefined ? undefined : { region: input.region })}/api/ide/v1/model_list`;
  const response = await input.fetcher(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ type: "chat" }),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!response.ok) return [];
  const parsed = (await response.json()) as {
    data?: unknown;
    models?: unknown;
    model_configs?: unknown;
  };
  const rows = Array.isArray(parsed.model_configs)
    ? parsed.model_configs
    : Array.isArray(parsed.models)
      ? parsed.models
      : Array.isArray(parsed.data)
        ? parsed.data
        : [];
  return rows
    .filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null)
    .map((row) => ({
      // `model_name` is the key upstream's listing uses; the others are the
      // spellings the older donors assumed.
      id: String(row["model_name"] ?? row["name"] ?? row["id"] ?? "").trim(),
      ctx: traeMaxContextWindow(row),
    }))
    .filter((row) => row.id.length > 0);
}

export { TRAE_CN_MODELS, TRAE_INTL_MODELS };

/**
 * Core host for one account.
 *
 * An intl account is provisioned into a region and its token only authenticates
 * against that region's host, so the account's own `region` wins over the
 * realm default. Falling back to the realm keeps older accounts (stored before
 * the region was captured) working exactly as before.
 */
function traeCoreForAccount(
  realm: TraeRealm,
  authState: Readonly<Record<string, unknown>> | undefined,
): string {
  const region = typeof authState?.["region"] === "string" ? authState["region"].toLowerCase() : "";
  const regional = TRAE_REGION_CORE_HOSTS[region];
  if (regional !== undefined) return regional;
  return traeCoreCandidates(realm)[0] ?? "";
}
