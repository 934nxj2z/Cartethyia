// Trae wire protocol: request body and SSE translation.
//
// Two upstream rules drive everything here:
//
// 1. The model key is `model_name`, not `model`. Sending `model` is silently
//    ignored and upstream answers with its default model, so the caller gets a
//    different model than it asked for with no error.
// 2. Message `content` must be an array of parts. A plain string is refused
//    (400/4001), so every message is normalized to parts even when there is
//    only text.
//
// Sourced from the donor hub `Public/trae2api-hub` (`build_chat_body` and
// `iter_events` in `trae_client.py`).

import type { CanonicalRequest, ContentPart } from "../../../protocol/canonical-model";
import { TRAE_CHAT_PATH, TRAE_MODEL_LIST_PATH, TRAE_REALMS, type TraeRealm } from "./trae-realm";

/** Upstream chat body. */
export interface TraeChatBody {
  readonly model_name: string;
  readonly messages: readonly TraeMessage[];
  readonly stream: boolean;
  readonly region: string;
  readonly ai_region: string;
  readonly temperature?: number;
  readonly top_p?: number;
  readonly max_tokens?: number;
  readonly stop?: readonly string[];
  readonly presence_penalty?: number;
  readonly frequency_penalty?: number;
  readonly session_id?: string;
}

export interface TraeMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: readonly TraeContentPart[];
  readonly tool_call_id?: string;
  readonly tool_calls?: readonly TraeToolCall[];
}

export type TraeContentPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image_url"; readonly image_url: { readonly url: string } };

export interface TraeToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: { readonly name: string; readonly arguments: string };
}

/**
 * Generation fields upstream accepts.
 *
 * Undeclared fields are deliberately omitted: the donor notes that sending
 * anything outside this set risks a 4001, so `provider_options` is never
 * spread into the body wholesale.
 */
const PASSTHROUGH_OPTIONS = ["temperature", "top_p", "max_tokens", "stop"] as const;

function textOf(part: ContentPart): string {
  return part.kind === "text" ? part.text : "";
}

/**
 * Renders an image part as a URL upstream accepts.
 *
 * The canonical image payload is opaque (`payload`), because every surface
 * spells an image differently: base64 with a media type, a bare URL, or a
 * provider file id. Only the first two have an upstream representation, so a
 * payload this adapter cannot recognize is dropped rather than sent as a
 * malformed data URI.
 */
function dataUriOf(part: Extract<ContentPart, { kind: "image" }>): string | undefined {
  const payload = part.payload;
  if (typeof payload === "string") {
    return /^https?:\/\//i.test(payload) ? payload : undefined;
  }
  if (typeof payload !== "object" || payload === null) return undefined;
  const record = payload as Record<string, unknown>;
  const url = record["url"];
  if (typeof url === "string" && url.length > 0) return url;
  const data = record["data"];
  const mediaType = record["media_type"] ?? record["mediaType"];
  if (typeof data === "string" && typeof mediaType === "string") {
    // `data` may already carry its own `data:` prefix from a previous hop.
    return data.startsWith("data:") ? data : `data:${mediaType};base64,${data}`;
  }
  const b64 = record["b64_json"] ?? record["base64"];
  if (typeof b64 === "string" && typeof mediaType === "string") {
    return `data:${mediaType};base64,${b64}`;
  }
  return undefined;
}

/** Maps one canonical part onto the upstream part shape. */
function toTraePart(part: ContentPart): TraeContentPart | undefined {
  if (part.kind === "text") return { type: "text", text: part.text };
  if (part.kind === "image") {
    const url = dataUriOf(part);
    return url === undefined ? undefined : { type: "image_url", image_url: { url } };
  }
  return undefined;
}

/** Serializes tool-call arguments, which arrive parsed rather than as text. */
function toolArguments(args: unknown): string {
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args ?? {});
  } catch {
    return "{}";
  }
}

/** Flattens a tool result's content to the single string upstream takes. */
function toolResultText(content: readonly ContentPart[] | string): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.kind === "text" ? part.text : ""))
    .filter((text) => text.length > 0)
    .join("\n");
}

/**
 * Builds the upstream chat body from a canonical request.
 *
 * System content is promoted to a leading `system` message: upstream has no
 * separate system field, and dropping it (rather than promoting it) is what
 * silently loses the caller's instructions.
 */
export function buildTraeChatBody(
  modelId: string,
  request: CanonicalRequest,
  realm: TraeRealm,
): TraeChatBody {
  if (modelId.length === 0) throw new Error("trae model name is required");

  const messages: TraeMessage[] = [];
  const systemParts: string[] = [];
  for (const part of request.system ?? []) {
    const text = textOf(part);
    if (text.length > 0) systemParts.push(text);
  }
  for (const part of request.instructions ?? []) {
    const text = textOf(part);
    if (text.length > 0) systemParts.push(text);
  }
  if (systemParts.length > 0) {
    messages.push({ role: "system", content: [{ type: "text", text: systemParts.join("\n\n") }] });
  }

  for (const message of request.messages) {
    // `system` was promoted into the leading turn above; appending it again
    // would leave a second, late instruction turn. `developer` has no upstream
    // equivalent and is folded into the same leading turn rather than dropped.
    if (message.role === "system" || message.role === "developer") {
      const text = message.content.map(textOf).filter((t) => t.length > 0).join("\n\n");
      if (text.length > 0) systemParts.push(text);
      continue;
    }
    const parts: TraeContentPart[] = [];
    const toolCalls: TraeToolCall[] = [];
    let toolResult: { callId: string; text: string } | undefined;
    for (const part of message.content) {
      if (part.kind === "toolCall") {
        toolCalls.push({
          id: part.call_id,
          type: "function",
          function: { name: part.name, arguments: toolArguments(part.arguments) },
        });
        continue;
      }
      if (part.kind === "toolResult") {
        toolResult = { callId: part.call_id, text: toolResultText(part.content) };
        continue;
      }
      const mapped = toTraePart(part);
      if (mapped !== undefined) parts.push(mapped);
    }

    // A tool answer becomes its own `tool` turn, which is the only shape
    // upstream accepts for it — leaving it inside the assistant turn is
    // rejected as a broken tool sequence.
    if (toolResult !== undefined) {
      messages.push({
        role: "tool",
        content: [{ type: "text", text: toolResult.text }],
        tool_call_id: toolResult.callId,
      });
      continue;
    }
    // Empty turns are skipped: upstream rejects them, and emitting
    // `content: ""` turns leaves a ghost turn in the conversation.
    if (parts.length === 0 && toolCalls.length === 0) continue;
    messages.push({
      role: message.role === "assistant" ? "assistant" : "user",
      content: parts.length > 0 ? parts : [{ type: "text", text: "" }],
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });
  }

  const config = TRAE_REALMS[realm];
  const controls = request.generation_controls;
  const body: Record<string, unknown> = {
    model_name: modelId,
    messages,
    stream: request.stream,
    region: config.region,
    ai_region: config.region,
    ...(request.session_id ? { session_id: request.session_id } : {}),
  };
  const options: Record<string, unknown> = {
    temperature: controls.temperature,
    top_p: controls.top_p,
    max_tokens: controls.max_tokens,
    stop: controls.stop,

  };
  for (const key of PASSTHROUGH_OPTIONS) {
    const value = options[key];
    if (value !== undefined && value !== null) body[key] = value;
  }
  return body as unknown as TraeChatBody;
}

/** Body for the live model list. Upstream requires a body even to list. */
export function buildTraeModelListBody(): Record<string, unknown> {
  return { type: "chat" };
}

export const TRAE_CHAT_ENDPOINT = TRAE_CHAT_PATH;
export const TRAE_MODEL_LIST_ENDPOINT = TRAE_MODEL_LIST_PATH;

/** One parsed SSE frame. */
export interface TraeSseFrame {
  readonly event: string;
  readonly data: unknown;
}

/**
 * Parses an SSE byte stream into frames.
 *
 * The done sentinel is a `data:` payload equal to `[DONE]`, which upstream
 * sends instead of a named `done` event. Comment lines (leading `:`) are
 * heartbeats and are skipped rather than treated as data.
 */
export async function* parseTraeSse(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<TraeSseFrame> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  let event = "message";
  let data: string[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line === "") {
          if (data.length > 0) {
            const payload = data.join("\n");
            data = [];
            if (payload.trim() === "[DONE]") {
              yield { event: "done", data: { finish_reason: "stop" } };
            } else {
              let parsed: unknown = payload;
              try {
                parsed = JSON.parse(payload);
              } catch {
                // Upstream occasionally emits non-JSON keepalives; a frame we
                // cannot parse is dropped rather than failing the stream.
                parsed = payload;
              }
              yield { event, data: parsed };
            }
            event = "message";
          }
        } else if (line.startsWith(":")) {
          continue;
        } else {
          const separator = line.indexOf(":");
          const field = separator < 0 ? line : line.slice(0, separator);
          let value = separator < 0 ? "" : line.slice(separator + 1);
          if (value.startsWith(" ")) value = value.slice(1);
          if (field === "event") event = value;
          else if (field === "data") data.push(value);
        }
        newline = buffer.indexOf("\n");
      }
    }
    if (data.length > 0) {
      const payload = data.join("\n");
      if (payload.trim() === "[DONE]") {
        yield { event: "done", data: { finish_reason: "stop" } };
      } else {
        let parsed: unknown = payload;
        try {
          parsed = JSON.parse(payload);
        } catch {
          parsed = payload;
        }
        yield { event, data: parsed };
      }
    }
  } finally {
    reader.releaseLock();
  }
}
