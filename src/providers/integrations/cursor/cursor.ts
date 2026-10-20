// The canonical Cursor adapter.
//
// Cursor speaks Connect-RPC over protobuf on a bidirectional HTTP/2 stream, so
// this adapter frames its own protocol instead of going through a wire codec. It
// owns the whole tool loop in both directions:
//
//   - a Cursor executable tool request becomes a client `tool_call_delta`;
//   - the client's next request carries that tool's result and the *same*
//     upstream Run answers it, so the model continues where it left off.
//
// Two rules govern what is executed. Only Cursor's authoritative
// `exec_server_message.mcp_args` is a tool call — `interaction_update`'s
// `tool_call_started` / `tool_call_completed` are display notifications, and
// Cursor's native shell/filesystem/workspace tools are never run here. And an
// `mcp_args` request is executable only when its namespace and function name
// match a tool the current request declared; anything else is answered
// `rejected` so the model can continue without the gateway ever touching a
// filesystem or a shell on the caller's behalf.
import { GatewayError } from "../../../protocol/gateway-error";
import type {
  CanonicalEvent,
  CanonicalRequest,
  CanonicalStopReason,
  ContentPart,
  UsageRecord,
} from "../../../protocol/canonical-model";
import { resolveImageSource, splitDataUrl } from "../../../protocol/codecs";
import { IMAGE_CLAMP_MAX_BYTES } from "../../../protocol/image-clamp";
import type { ProviderAdapter, ProviderDispatchContext, ProviderDispatchTarget } from "../../provider-contracts";
import { readCredentialSecret } from "../../provider-contracts";
import type { Http2BidiEndReason, ValidatedHttp2BidiStream } from "../../../network/http2-bidi";
import type { ProviderContinuationScope } from "../../provider-contracts";
import { CURSOR_PROVIDER_ID, RUN_IDLE_TTL_MS, isAllowedAgentHost } from "./cursor-shared";
import {
  CURSOR_MCP_NAMESPACE as MCP_NAMESPACE,
  buildCancelAction,
  buildKvGetBlobResult,
  buildKvSetBlobResult,
  buildMcpRejected,
  buildMcpResult,
  buildMcpStateResult,
  buildHeartbeat,
  buildRequestContextResult,
  buildRunRequest,
  historyFromRequest,
  liveUserText,
  systemPromptFrom,
  toolDescriptorsFor,
  type CursorImageInput,
  type CursorToolDescriptor,
} from "./cursor-request";
import { cursorRunTerminationError, decodeServerMessages, openCursorRun } from "./cursor-http2";
import { cursorRunSessions } from "./cursor-session-manager";
import type { CursorContinuationScope, CursorRunSession } from "./cursor-session-manager";
import { fetchCursorRunOrigin } from "./cursor-catalog";
import { defaultParameterValues, fetchCursorModels } from "./cursor-catalog";
import type { CursorModelInfo } from "./cursor-catalog";
import { decodeValueToJson, decodeStructEntriesToJson } from "./protocol/struct";

/**
 * Client-heartbeat cadence for every Cursor Run.
 *
 * The edge answers a turn only after it has seen at least one client
 * heartbeat, and the donor pins this to 5s (`heartbeatMs` in its continuation
 * policy). A longer cadence is a Run that streams heartbeats and never
 * answers; a shorter one is traffic the upstream does not ask for.
 */
const CURSOR_HEARTBEAT_INTERVAL_MS = 5_000;

/**
 * How long one account's model roster is reused for `parameters` lookups.
 *
 * A Run needs the model's declared default parameter tuple, but the roster is
 * per-account and moves rarely, so it is fetched once and cached rather than on
 * every dispatch.
 */
const CURSOR_ROSTER_TTL_MS = 300_000;
/** credential → { roster, fetchedAt } for the parameter lookup. */
const rosterCache = new Map<string, { roster: readonly CursorModelInfo[]; fetchedAt: number }>();
/** Client-heartbeat cadence the Cursor edge expects (donor `heartbeatMs`). */
const CURSOR_HEARTBEAT_INTERVAL_OVERRIDE = (() => {
  const raw = process.env.CARTETHYIA_CURSOR_HEARTBEAT_MS?.trim();
  if (raw === undefined || raw === "") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
})();

/** Image MIME types Cursor accepts in `selected_images`. */
const ALLOWED_IMAGE_MIME_TYPES: Record<string, true> = {
  "image/png": true,
  "image/jpeg": true,
  "image/webp": true,
  "image/gif": true,
};

/** Largest image payload accepted, matching the shared pre-send clamp. */
const MAX_IMAGE_BYTES = IMAGE_CLAMP_MAX_BYTES;

/** Identifies an allowed image payload from its magic bytes. */
function sniffImageMime(bytes: Uint8Array): string | undefined {
  if (bytes.byteLength >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.byteLength >= 6 &&
    bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38
  ) {
    return "image/gif";
  }
  if (
    bytes.byteLength >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return undefined;
}

function base64ToBytes(data: string): Uint8Array | undefined {
  try {
    const binary = atob(data);
    const out = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
    return out;
  } catch {
    return undefined;
  }
}

/**
 * Validates one decoded image payload.
 *
 * The MIME type is verified by sniffing and only then compared against the
 * declared type: a caller-supplied `content-type` or data-URL media type is a
 * claim, and sending bytes the upstream will reject — or bytes that are not an
 * image at all — fails the whole request rather than being dropped silently.
 */
function finishImage(bytes: Uint8Array): CursorImageInput {
  const sniffed = sniffImageMime(bytes);
  const mimeType = sniffed;
  if (mimeType === undefined || ALLOWED_IMAGE_MIME_TYPES[mimeType] !== true) {
    throw new GatewayError(
      "invalid_request",
      400,
      "Cursor accepts PNG, JPEG, WebP and GIF image input only",
    );
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new GatewayError(
      "invalid_request",
      400,
      `Cursor image input exceeds the ${MAX_IMAGE_BYTES}-byte limit`,
    );
  }
  return { data: bytes, mimeType };
}

/** Reads one canonical image part into Cursor `selected_images` bytes. */
async function resolveImageInput(
  part: Extract<ContentPart, { kind: "image" }>,
  context: ProviderDispatchContext,
): Promise<CursorImageInput> {
  const source = resolveImageSource(part.payload);
  const url = source?.url;
  if (url === undefined) {
    throw new GatewayError(
      "invalid_request",
      400,
      "Cursor image input requires inline image data or an HTTPS image URL",
    );
  }
  const dataUrl = splitDataUrl(url);
  if (dataUrl !== undefined) {
    const bytes = base64ToBytes(dataUrl.data);
    if (bytes === undefined) {
      throw new GatewayError("invalid_request", 400, "Cursor image attachment is not valid base64");
    }
    return finishImage(bytes);
  }
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new GatewayError(
      "invalid_request",
      400,
      "Cursor image URLs must be HTTPS; private and non-TLS sources are not fetched",
    );
  }
  const fetcher = context.outbound_attachment_fetch;
  if (fetcher === undefined) {
    throw new GatewayError(
      "invalid_request",
      400,
      "Cursor has no validated egress to fetch this image URL",
    );
  }
  // Redirects are not followed: reject the response rather than letting a
  // public URL redirect the attachment fetch to a private address.
  const response = await fetcher(url, {
    method: "GET",
    redirect: "manual",
    signal: context.abort_signal,
  });
  if (!response.ok) {
    throw new GatewayError(
      "invalid_request",
      400,
      `Cursor could not fetch this image URL (${response.status})`,
    );
  }
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.byteLength > MAX_IMAGE_BYTES) {
    throw new GatewayError(
      "invalid_request",
      400,
      `Cursor image input exceeds the ${MAX_IMAGE_BYTES}-byte limit`,
    );
  }
  return finishImage(body);
}

/** Collects every canonical image part of a request into Cursor images. */
async function collectImages(
  request: CanonicalRequest,
  context: ProviderDispatchContext,
): Promise<CursorImageInput[]> {
  const images: CursorImageInput[] = [];
  for (const message of request.messages) {
    for (const part of message.content) {
      if (part.kind !== "image") continue;
      images.push(await resolveImageInput(part, context));
    }
  }
  return images;
}

function usageFromTurnEnded(turnEnded: Record<string, unknown>): UsageRecord {
  const count = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;
  const input = count(turnEnded["input_tokens"]);
  const output = count(turnEnded["output_tokens"]);
  const cacheRead = count(turnEnded["cache_read"]);
  return {
    input_tokens: input,
    cached_input_tokens: cacheRead,
    cache_write_tokens: count(turnEnded["cache_write"]),
    uncached_input_tokens: Math.max(0, input - cacheRead),
    output_tokens: output,
    reasoning_tokens: count(turnEnded["reasoning_tokens"]),
    estimated_cost: null,
    total_tokens: input + output,
  };
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyStringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Reads one inbound `mcp_args` request.
 *
 * Returns `undefined` for anything that is not an executable call. Cursor's own
 * host tools arrive under their own server identifiers (or none at all) and are
 * never executed here — refusing them is what keeps a model's request from
 * turning into a shell command on the gateway's host.
 */
function readExecutableMcpCall(
  mcpArgs: Record<string, unknown>,
  descriptors: readonly CursorToolDescriptor[],
): { toolName: string; arguments: string } | undefined {
  if (nonEmptyStringOf(mcpArgs["provider_identifier"]) !== MCP_NAMESPACE) return undefined;
  const toolName = nonEmptyStringOf(mcpArgs["tool_name"]);
  if (toolName === undefined) return undefined;
  if (!descriptors.some((descriptor) => descriptor.toolName === toolName)) return undefined;
  return { toolName, arguments: decodeMcpArguments(mcpArgs) };
}

/**
 * Decodes Cursor's `McpArgs.args` — a `map<string, google.protobuf.Value>`
 * carried as repeated map-entry messages — into a canonical arguments string.
 */
function decodeMcpArguments(mcpArgs: Record<string, unknown>): string {
  const entries = mcpArgs["args"];
  const raw = Array.isArray(entries)
    ? entries.filter((entry): entry is Uint8Array => entry instanceof Uint8Array)
    : [];
  if (raw.length === 0) return "{}";
  try {
    return JSON.stringify(decodeStructEntriesToJson(raw));
  } catch {
    return "{}";
  }
}

/** One image-bearing block of a tool result, ready for `McpToolResultContentItem`. */
interface ResultImage {
  readonly data: Uint8Array;
  readonly mimeType: string;
}

/** Reads the images out of one canonical tool result. */
function resultImages(part: Extract<ContentPart, { kind: "toolResult" }>): ResultImage[] {
  if (typeof part.content === "string") return [];
  const images: ResultImage[] = [];
  for (const child of part.content) {
    if (child.kind !== "image") continue;
    const source = resolveImageSource(child.payload);
    const url = source?.url;
    if (url === undefined) continue;
    const dataUrl = splitDataUrl(url);
    if (dataUrl === undefined) continue;
    const bytes = base64ToBytes(dataUrl.data);
    if (bytes === undefined) continue;
    const mimeType = sniffImageMime(bytes) ?? dataUrl.mediaType;
    if (ALLOWED_IMAGE_MIME_TYPES[mimeType] !== true) continue;
    if (bytes.byteLength > MAX_IMAGE_BYTES) continue;
    images.push({ data: bytes, mimeType });
  }
  return images;
}

/** One Run's live state while this adapter is pumping it. */
interface RunHandle {
  readonly stream: ValidatedHttp2BidiStream;
  readonly write: (message: Uint8Array) => Promise<void>;
  close(reason?: string): void;
}

class CursorAdapter implements ProviderAdapter {
  readonly provider_id = CURSOR_PROVIDER_ID;

  /**
   * Dispatches one canonical request.
   *
   * Two entry shapes, decided before anything is dialed:
   *
   * - **Continuation** — the request carries a tool result for a call this
   *   process is holding. The already-open Run is resumed: no new Run, no new
   *   account lease, no new pool slot.
   * - **Fresh turn** — a new Run. If the request carries complete assistant +
   *   tool history but no live session (a restart, or an expired idle Run), the
   *   whole history is rebased into the new Run so the model still sees the
   *   conversation.
   */
  async *dispatch(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent> {
    const pending = readPendingToolResult(request, context);
    if (pending !== undefined && pending.length > 0) {
      yield* this.#continueRun(request, candidate, context, pending);
      return;
    }
    yield* this.#startRun(request, candidate, context);
  }

  /**
   * Resumes the held Run for one tool result.
   *
   * Every pending call must resolve to the *same* Run and the same account. A
   * request whose calls resolve to different Runs — or to no live Run at all —
   * is refused rather than partially applied: writing one result to another
   * account's Run would corrupt both conversations, and silently starting a new
   * Run would answer a tool call the model is still waiting on.
   */
  async *#continueRun(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
    pending: readonly PendingToolResult[],
  ): AsyncIterable<CanonicalEvent> {
    const scope = context.continuation_scope;
    if (scope === undefined) {
      throw new GatewayError(
        "invalid_request",
        400,
        "This tool result cannot be matched to a live Cursor Run; resend the complete conversation.",
      );
    }
    const resolved = pending.map((item) => cursorRunSessions.resolveCall(item.callId, scope));
    if (resolved.some((entry) => entry === undefined)) {
      throw new GatewayError(
        "invalid_request",
        400,
        "This tool result refers to a Cursor tool call that is no longer pending. Resend the complete conversation.",
        { callIds: pending.map((item) => item.callId) },
      );
    }
    const runId = resolved[0]?.session.runId;
    if (runId === undefined) {
      throw new GatewayError("invalid_request", 400, "Cursor Run is no longer live");
    }
    if (resolved.some((entry) => entry?.session.runId !== runId)) {
      throw new GatewayError(
        "invalid_request",
        400,
        "These tool results belong to different Cursor Runs; resend them one Run at a time.",
      );
    }
    const session = cursorRunSessions.get(runId);
    if (session === undefined) {
      throw new GatewayError("invalid_request", 400, "Cursor Run is no longer live");
    }
    const handle = this.#handles.get(runId);
    if (handle === undefined) {
      // The Run's socket is gone even though the record survived (a transport
      // failure the pump did not observe). Rebase rather than answer into a
      // dead stream.
      cursorRunSessions.terminate(runId, "Cursor Run transport is gone");
      yield* this.#startRun(request, candidate, context);
      return;
    }
    let sequence = 0;
    const next = (): number => (sequence += 1);
    try {
      for (const item of pending) {
        const entry = cursorRunSessions.resolveCall(item.callId, scope);
        if (entry === undefined) continue;
        await handle.write(
          buildMcpResult({
            execId: entry.call.execId,
            text: item.text,
            isError: item.isError,
            ...(item.images.length > 0 ? { images: item.images } : {}),
          }),
        );
        cursorRunSessions.clearPendingCall(runId, item.callId);
      }
      yield* this.#pump({
        request,
        candidate,
        context,
        handle,
        runId,
        session,
        next,
        continuation: true,
      });
    } finally {
      // The Run stays open only while it still owes an answer. A terminal close
      // is the session manager's single release path.
      if (cursorRunSessions.get(runId) === undefined) this.#handles.delete(runId);
      else if (!this.#awaitsToolResult && session.pending.size === 0) {
        cursorRunSessions.terminate(runId);
        this.#handles.delete(runId);
      }
    }
  }

  async *#startRun(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent> {
    const outboundHttp2 = context.outbound_http2;
    if (outboundHttp2 === undefined) {
      throw new GatewayError(
        "admission_unavailable",
        503,
        "Cursor requires validated HTTP/2 egress; none is configured for this route",
        { providerId: CURSOR_PROVIDER_ID },
      );
    }
    const credential = readCredentialSecret(
      context.credential,
      "Cursor account credential is missing or empty; reconnect the account",
    );
    const origin = await this.#resolveOrigin(credential, context);
    const rawModelId = candidate.model_id.length > 0 ? candidate.model_id : request.model;
    const modelId = resolveCursorWireModelId(rawModelId);
    // Cursor declares per-model parameter tuples (effort / context / fast). A
    // fresh Run must carry the model's declared default tuple: with an empty
    // `parameters` the Run streams only heartbeats and never turns.
    const parameterValues = defaultParameterValues(
      await this.#rosterFor(credential, context).then((roster) =>
        roster.find((model) => model.id === modelId),
      ),
    );
    const images = await collectImages(request, context);
    const descriptors = toolDescriptorsFor(request.tools);
    const systemPrompt = systemPromptFrom(request);
    const conversationId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const opened = await openCursorRun({
      origin,
      credential,
      outboundHttp2,
      signal: context.abort_signal,
    });
    let closed = false;
    const handle: RunHandle = {
      stream: opened.stream,
      write: opened.write,
      close: (reason) => {
        if (closed) return;
        closed = true;
        if (reason !== undefined && reason.length > 0) {
          void opened.write(buildCancelAction(reason)).catch(() => undefined);
        }
        opened.stream.abort();
      },
    };
    this.#handles.set(runId, handle);
    const session: CursorRunSession = {
      runId,
      conversationId,
      scope: sessionScope(context),
      descriptors,
      pending: new Map(),
      calls: new Map(),
      usage: undefined,
      failure: undefined,
    };
    let sequence = 0;
    const next = (): number => (sequence += 1);
    try {
      await opened.write(
        buildRunRequest({
          text: liveUserText(request),
          modelId,
          conversationId,
          runId,
          ...(images.length > 0 ? { images } : {}),
          ...(descriptors.length > 0 ? { descriptors } : {}),
          ...(systemPrompt === undefined ? {} : { systemPrompt }),
          ...(parameterValues.length > 0 ? { parameterValues } : {}),
          // A fresh Run always rebases the client's history into its user text:
          // Cursor's own checkpoint cannot be reconstructed after a restart, and
          // `root_prompt_messages_json` would suppress the RequestContext rules.
          history: historyFromRequest(request),
        }),
      );
      // Registered before the first frame is pumped: a tool call can arrive on
      // the very first frame, and the Run must already be claimable.
      cursorRunSessions.register({
        session,
        releaseLease: context.lease_ownership?.transferToProviderSession(),
        close: (reason) => handle.close(reason),
        idleTtlMs: RUN_IDLE_TTL_MS,
      });
      yield* this.#pump({
        request,
        candidate,
        context,
        handle,
        runId,
        session,
        next,
        continuation: false,
      });
    } catch (error) {
      cursorRunSessions.terminate(runId, error instanceof Error ? error.message : undefined);
      this.#handles.delete(runId);
      throw error;
    } finally {
      if (cursorRunSessions.get(runId) === undefined) this.#handles.delete(runId);
      // A Run whose tool call is registered and unanswered is *held*, not
      // finished. The consumer may stop reading before the pump reaches its
      // terminal (a stream the client already has enough of), and tearing the
      // Run down there loses the call it just handed out — the next request's
      // tool result then resolves nothing.
      else if (!this.#awaitsToolResult && session.pending.size === 0) {
        cursorRunSessions.terminate(runId);
        this.#handles.delete(runId);
      }
    }
  }

  /** Live Run handles, keyed by run id. Process-local, like the sessions. */
  readonly #handles = new Map<string, RunHandle>();
  /** Set by the pump when the last terminal it emitted still owes a tool result. */
  #awaitsToolResult = false;

  /**
   * Resolves the Run origin for one account.
   *
   * Cursor routes an account to a region-specific host, and the wrong host
   * silently refuses the Run; the API host serves auth and catalog calls but is
   * not the origin `GetServerConfig` names for Run. A resolution failure is a
   * transport fault, never a fallback to the API host.
   */
  async #resolveOrigin(credential: string, context: ProviderDispatchContext): Promise<string> {
    try {
      const origin = await fetchCursorRunOrigin({
        credential,
        ...(context.outbound_fetch === undefined
          ? {}
          : { fetcher: context.outbound_fetch as unknown as typeof fetch }),
        signal: context.abort_signal,
      });
      if (!isAllowedAgentHost(new URL(origin).hostname)) {
        throw new Error("resolved origin is not a Cursor host");
      }
      return origin;
    } catch (error) {
      throw new GatewayError(
        "platform_unavailable",
        502,
        `Cursor Run origin could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
        { providerId: CURSOR_PROVIDER_ID },
        "upstream",
      );
    }
  }

  /**
   * The account's model roster, for the default parameter tuple.
   *
   * Cached per credential and never fatal: a Run whose model is not in the
   * roster (or whose roster fetch failed) still runs with no parameters rather
   * than failing the dispatch. The tuple is an optimization, not a requirement.
   */
  async #rosterFor(
    credential: string,
    context: ProviderDispatchContext,
  ): Promise<readonly CursorModelInfo[]> {
    const cached = rosterCache.get(credential);
    if (cached !== undefined && Date.now() - cached.fetchedAt < CURSOR_ROSTER_TTL_MS) {
      return cached.roster;
    }
    try {
      const roster = await fetchCursorModels({
        credential,
        ...(context.outbound_fetch === undefined
          ? {}
          : { fetcher: context.outbound_fetch as unknown as typeof fetch }),
        signal: context.abort_signal,
      });
      rosterCache.set(credential, { roster, fetchedAt: Date.now() });
      return roster;
    } catch {
      return cached?.roster ?? [];
    }
  }

  async *#pump(input: {
    readonly request: CanonicalRequest;
    readonly candidate: ProviderDispatchTarget;
    readonly context: ProviderDispatchContext;
    readonly handle: RunHandle;
    readonly runId: string;
    readonly session: CursorRunSession;
    readonly next: () => number;
    readonly continuation: boolean;
  }): AsyncIterable<CanonicalEvent> {
    const { context, handle, runId, session } = input;
    let sawToolCall = false;
    let terminalUsage: UsageRecord | undefined;
    let stopReason: CanonicalStopReason = "stop";
    let failure: GatewayError | undefined;
    const unsubscribe = handle.stream.onTerminal((reason: Http2BidiEndReason) => {
      if (reason.kind === "local-close") return;
      const mapped = cursorRunTerminationError({ stream: handle.stream, reason });
      if (mapped !== undefined) failure = mapped;
    });
    // The Cursor edge answers a Run only after it sees a client heartbeat (the
    // donor's continuation policy pins `heartbeatMs` to 5s). One heartbeat is
    // sent eagerly on open here and then on the interval; clearing it when the
    // body reader ends is safe because the reader's end already means the Run
    // is over.
    const beat = (): void =>
      void handle.write(buildHeartbeat()).catch(() => undefined);
    const onAbort = (): void => clearInterval(heartbeatTimer);
    const heartbeatTimer = setInterval(
      beat,
      CURSOR_HEARTBEAT_INTERVAL_OVERRIDE ?? CURSOR_HEARTBEAT_INTERVAL_MS,
    );
    void beat();
    context.abort_signal.addEventListener("abort", onAbort, { once: true });
    if (context.abort_signal.aborted) onAbort();
    heartbeatTimer.unref();
    try {
      for await (const message of decodeServerMessages(handle.stream.body)) {
        if (context.abort_signal.aborted) {
          failure = new GatewayError("transport_closed", 499, "request was cancelled");
          break;
        }
        const execServer = recordOf(message["exec_server_message"]);
        if (execServer !== undefined) {
          const handled = await this.#handleExecServerMessage(execServer, session, handle);
          if (handled.kind !== "tool_call") continue;
          const callId = `call_cursor_${runId}_${handled.execId}`;
          const scope = context.continuation_scope;
          if (scope === undefined) {
            // Without a scope, no later request could be authorized to answer
            // this call, so the Run must not be held open for one.
            await handle.write(buildMcpRejected(handled.execId, "tool call is not answerable"));
            continue;
          }
          if (!cursorRunSessions.registerPendingCall(runId, { callId, execId: handled.execId, toolName: handled.toolName })) {
            await handle.write(buildMcpRejected(handled.execId, "tool call is not answerable"));
            continue;
          }
          sawToolCall = true;
          yield {
            type: "tool_call_delta",
            sequence_number: input.next(),
            call_id: callId,
            name: handled.toolName,
            arguments_delta: handled.arguments,
          };
          continue;
        }

        const kv = recordOf(message["kv_server_message"]);
        if (kv !== undefined && (await this.#handleKvMessage(kv, handle))) continue;

        const interaction = recordOf(message["interaction_update"]);
        if (interaction === undefined) continue;

        const textDelta = recordOf(interaction["text_delta"]);
        if (textDelta !== undefined) {
          const text = typeof textDelta["text"] === "string" ? textDelta["text"] : "";
          if (text.length > 0) {
            yield {
              type: "content_delta",
              sequence_number: input.next(),
              content: { kind: "text", text },
            };
          }
          continue;
        }
        const thinking = recordOf(interaction["thinking_delta"]);
        if (thinking !== undefined) {
          const text = typeof thinking["text"] === "string" ? thinking["text"] : "";
          if (text.length > 0) {
            yield {
              type: "content_delta",
              sequence_number: input.next(),
              content: { kind: "reasoning", payload: null, summary: text },
            };
          }
          continue;
        }
        // `tool_call_started` / `tool_call_completed` are display notifications:
        // they report what Cursor's host did, not a call this gateway executes.
        // Only `turn_ended` is authoritative for the turn's end and its usage.
        const turnEnded = recordOf(interaction["turn_ended"]);
        if (turnEnded !== undefined) {
          terminalUsage = usageFromTurnEnded(turnEnded);
          break;
        }
      }
    } catch (error) {
      failure =
        error instanceof GatewayError
          ? error
          : new GatewayError(
              "platform_unavailable",
              502,
              `Cursor Run failed: ${error instanceof Error ? error.message : String(error)}`,
              { providerId: CURSOR_PROVIDER_ID },
              "upstream",
            );
    } finally {
      unsubscribe();
    clearInterval(heartbeatTimer);
    context.abort_signal.removeEventListener("abort", onAbort);
    }

    if (failure !== undefined) {
      this.#awaitsToolResult = false;
      cursorRunSessions.terminate(runId, failure.message);
      yield {
        type: "terminal",
        sequence_number: input.next(),
        state: "failed",
        stop_reason: "error",
        // The refusal text, so the caller sees "you hit your usage limit"
        // instead of a terminal with no reason attached.
        stop_details: { code: failure.code, status: failure.status, message: failure.message },
        ...(terminalUsage === undefined ? {} : { usage: terminalUsage }),
      };
      return;
    }
    if (sawToolCall) {
      // The interim terminal: the client must answer the tool call, and this Run
      // stays open for it. `usage_deferred` tells the settle path not to charge
      // estimated tokens for a turn whose real usage arrives with the Run's
      // `turn_ended` on the continuation request.
      this.#awaitsToolResult = true;
      cursorRunSessions.touch(runId);
      yield {
        type: "terminal",
        sequence_number: input.next(),
        state: "complete",
        stop_reason: "tool_use",
        usage_deferred: true,
      };
      return;
    }
    this.#awaitsToolResult = false;
    cursorRunSessions.terminate(runId);
    yield {
      type: "terminal",
      sequence_number: input.next(),
      state: "complete",
      stop_reason: stopReason,
      ...(terminalUsage === undefined ? {} : { usage: terminalUsage }),
    };
  }

  /**
   * Handles one Cursor exec request.
   *
   * The control paths are mandatory, not optional: `request_context_args`,
   * `mcp_state_exec_args`, and the KV channel all stall the Run forever if the
   * client never answers. Only `mcp_args` — and only for a declared tool —
   * becomes a tool call; every other variant is refused rather than executed.
   */
  async #handleExecServerMessage(
    execServer: Record<string, unknown>,
    session: CursorRunSession,
    handle: RunHandle,
  ): Promise<{ kind: "handled" } | { kind: "tool_call"; execId: number; toolName: string; arguments: string }> {
    const execId = typeof execServer["id"] === "number" ? execServer["id"] : 0;
    if (recordOf(execServer["request_context_args"]) !== undefined) {
      await handle.write(buildRequestContextResult(execId, probeContextFor(session.descriptors)));
      return { kind: "handled" };
    }
    if (recordOf(execServer["mcp_state_exec_args"]) !== undefined) {
      await handle.write(buildMcpStateResult(execId, session.descriptors));
      return { kind: "handled" };
    }
    const mcpArgs = recordOf(execServer["mcp_args"]);
    if (mcpArgs !== undefined) {
      const call = readExecutableMcpCall(mcpArgs, session.descriptors);
      if (call === undefined) {
        await handle.write(
          buildMcpRejected(execId, "this tool is not one the request declared"),
        );
        return { kind: "handled" };
      }
      return { kind: "tool_call", execId, toolName: call.toolName, arguments: call.arguments };
    }
    // Every other exec variant is a Cursor host tool (shell, read, edit, glob,
    // subagent, …). Refusing it is the security boundary: the gateway does not
    // run filesystem or shell operations the client never asked for.
    await handle.write(buildMcpRejected(execId, "Cursor host tools are not executed by this gateway"));
    return { kind: "handled" };
  }

  /** Answers one KV blob request; `false` when the message carried none. */
  async #handleKvMessage(kv: Record<string, unknown>, handle: RunHandle): Promise<boolean> {
    const id = typeof kv["id"] === "number" ? kv["id"] : 0;
    if (recordOf(kv["set_blob_args"]) !== undefined) {
      await handle.write(buildKvSetBlobResult(id));
      return true;
    }
    const getArgs = recordOf(kv["get_blob_args"]);
    if (getArgs !== undefined) {
      const blobId = getArgs["blob_id"];
      const data = blobId instanceof Uint8Array ? blobId : new Uint8Array(0);
      await handle.write(buildKvGetBlobResult(id, data));
      return true;
    }
    return false;
  }
}

/** RequestContext Cursor receives in reply to a context probe. */
function probeContextFor(descriptors: readonly CursorToolDescriptor[]): Record<string, unknown> {
  return {
    tools: descriptors.map((descriptor) => ({
      name: descriptor.name,
      description: descriptor.description,
      input_schema: descriptor.inputSchema,
      provider_identifier: descriptor.providerIdentifier,
      tool_name: descriptor.toolName,
    })),
    mcp_info_complete: true,
    rules_info_complete: true,
    env_info_complete: true,
  };
}

/**
 * The continuation scope of one dispatch.
 *
 * Derived from the route's own account identity plus the caller's tenant and API
 * key. A route with no account cannot scope a continuation, and a Run that
 * cannot be scoped must not be held open across requests at all.
 */
function sessionScope(context: ProviderDispatchContext): CursorContinuationScope {
  const scope: ProviderContinuationScope | undefined = context.continuation_scope;
  return {
    tenantId: scope?.tenantId ?? "",
    apiKeyId: scope?.apiKeyId ?? "",
    providerId: CURSOR_PROVIDER_ID,
    providerAccountId: scope?.providerAccountId ?? context.credential.account_id ?? "",
  };
}

/** One tool result the client sent back for a call this process is holding. */
interface PendingToolResult {
  readonly callId: string;
  readonly text: string;
  readonly isError: boolean;
  readonly images: readonly ResultImage[];
}

/**
 * Reads the tool results this request wants delivered to a held Run.
 *
 * Only ids in the `call_cursor_<run-id>_<exec-id>` shape are considered: any
 * other id is the client's own, belongs to a different provider's conversation,
 * and must not be sent to Cursor.
 */
function readPendingToolResult(
  request: CanonicalRequest,
  _context: ProviderDispatchContext,
): PendingToolResult[] | undefined {
  const results: PendingToolResult[] = [];
  for (const message of request.messages) {
    for (const part of message.content) {
      if (part.kind !== "toolResult") continue;
      if (!part.call_id.startsWith("call_cursor_")) continue;
      const text =
        typeof part.content === "string"
          ? part.content
          : part.content.map((child) => (child.kind === "text" ? child.text : "")).join("\n");
      results.push({
        callId: part.call_id,
        text,
        isError: part.is_error === true,
        images: resultImages(part),
      });
    }
  }
  return results.length > 0 ? results : undefined;
}

/** Reconstructs one tool result's text and images for the adapter's tests. */
export { decodeStructEntriesToJson, decodeValueToJson };

export function createCursorAdapter(): ProviderAdapter {
  return new CursorAdapter();
}

export const cursorAdapter: ProviderAdapter = createCursorAdapter();
/** Maps virtual/canonical client model IDs to upstream Cursor wire IDs. */
function resolveCursorWireModelId(rawModelId: string): string {
  const id = rawModelId.trim().toLowerCase();
  // Only `auto` is an alias: Cursor's own roster names its Auto model
  // `default`. `grok-4.6` is already the upstream id, and rewriting it to
  // `cursor-grok-4.6` made every Grok Run answer "AI Model Not Found".
  if (id === "auto") return "default";
  return rawModelId;
}

