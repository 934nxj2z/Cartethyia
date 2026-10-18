/**
 * Event emission and response buffering for one streamed attempt.
 *
 * Owns the surface encoder (SSE framing), the client transcript copy used by
 * telemetry, and the per-event bookkeeping — the terminal event, usage, and
 * the first-byte / first-content timestamps — that stream completion reads
 * afterwards. Extracted from `dispatchStreamingAttempt` as a seam, not a
 * behavior change: method bodies are the original closure bodies, and the
 * observable ordering (buffer bookkeeping → terminal/usage capture →
 * client-visible tracking → encode + enqueue) is preserved exactly.
 */
import type { CanonicalEvent, SourceSurface, UsageRecord } from "../../../protocol/canonical-model";
import { MimoThinkSplitter } from "../../../providers/integrations/xiaomi-mimo/think-stream";
import { createDispatchStreamEncoder, type DispatchStreamEncoder } from "../stream-bridge";

/** The terminal event shape every stream settles (or fails to settle) on. */
export type StreamTerminalEvent = Extract<CanonicalEvent, { type: "terminal" }>;

/**
 * SSE comment frame: valid framing on every streamed surface, ignored by
 * EventSource clients. Never part of content/telemetry.
 */
export const KEEPALIVE_COMMENT_BYTES = new TextEncoder().encode(": keepalive\n\n");

/** Diagnostic transcript budget. Client-facing frames remain uncapped here. */
const CLIENT_RESPONSE_CAP = 512 * 1024;
const EVENT_TRANSCRIPT_CAP = 512 * 1024;
const EVENT_TRANSCRIPT_HEAD_CAP = EVENT_TRANSCRIPT_CAP / 2;
const EVENT_TRANSCRIPT_TAIL_CAP = EVENT_TRANSCRIPT_CAP - EVENT_TRANSCRIPT_HEAD_CAP;

interface TruncatedEventTranscript {
  readonly _truncated: true;
  readonly _omitted_events: number;
  readonly events: readonly (CanonicalEvent & { timestamp: number })[];
  readonly usage?: UsageRecord;
  readonly terminal?: {
    readonly type: "terminal";
    readonly sequence_number: number;
    readonly state: StreamTerminalEvent["state"];
    readonly stop_reason?: StreamTerminalEvent["stop_reason"];
    readonly usage?: UsageRecord;
  };
}

/** Error-frame input in the shape the dispatch stream encoder accepts. */
export type StreamErrorFrameInput = Parameters<DispatchStreamEncoder["encodeError"]>[0];

/**
 * Per-event state and framing for one stream. Client framing and protocol
 * bookkeeping process every event; only the telemetry transcript is bounded.
 */
export class StreamEventPipeline {
  /** Terminal event once the upstream produced one (or a synthetic truncation terminal was emitted). */
  terminal: StreamTerminalEvent | undefined;
  usage: UsageRecord | undefined;
  /** Wall-clock ms of the first byte actually enqueued to the client. */
  firstByteAt: number | undefined;
  firstContentDeltaAtMs: number | undefined;
  lastEventAtMs: number | undefined;
  /** The model the upstream named in its own response, captured from the
   * opening event. Absent when the stream carried none — some providers omit
   * it, and the requested id is not a substitute. */
  reportedModel: string | undefined;
  private readonly eventTranscriptHead: Array<CanonicalEvent & { timestamp: number }> = [];
  private readonly eventTranscriptTail: Array<{ event: CanonicalEvent & { timestamp: number }; bytes: number }> = [];
  private eventTranscriptTailStart = 0;
  private eventTranscriptHeadBytes = 0;
  private eventTranscriptTailBytes = 0;
  private totalEventCount = 0;

  private readonly recoverableResponsesPrelude: boolean;
  private clientVisibleEvent = false;
  // Decoded chunks collected per event and joined once at finalize: `+=` on
  // every chunk reallocates the whole prefix (O(n^2) up to the 512 KiB cap).
  private readonly clientResponseChunks: string[] = [];
  private clientResponseLength = 0;
  private clientResponseTruncated = false;
  // One decoder per stream: `new TextDecoder()` per chunk would allocate
  // on every upstream event for the telemetry transcript copy.
  private readonly clientResponseDecoder = new TextDecoder();
  private readonly streamEncoder: DispatchStreamEncoder;
  // One splitter per stream: a thinking tag can straddle two provider chunks,
  // and the text/idle bookkeeping below must see the split result, not the raw
  // tagged chunk.
  private readonly thinkSplitter = new MimoThinkSplitter();
  private lastSequenceNumber = -1;

  constructor(
    surface: SourceSurface,
    encoderOptions: Record<string, unknown>,
    recoverableResponsesPrelude: boolean,
  ) {
    this.streamEncoder = createDispatchStreamEncoder(surface, encoderOptions);
    this.recoverableResponsesPrelude = recoverableResponsesPrelude;
  }

  /** Number of canonical events processed, including those omitted from diagnostics. */
  get eventCount(): number {
    return this.totalEventCount;
  }

  /** Whether any client-renderable event has been emitted (gates the Responses prelude retry). */
  get hasClientVisibleEvent(): boolean {
    return this.clientVisibleEvent;
  }

  /** The client-facing response transcript (decoded SSE/JSON) — distinct from the provider-side canonical events. */
  get clientResponseText(): string {
    const text = this.clientResponseChunks.join("");
    return this.clientResponseTruncated ? text.slice(0, CLIENT_RESPONSE_CAP) : text;
  }

  /** Bounded canonical-event transcript for telemetry; the wire stream is unaffected. */
  get telemetryEventTranscript():
    | readonly (CanonicalEvent & { timestamp: number })[]
    | TruncatedEventTranscript {
    const tail = this.eventTranscriptTail.slice(this.eventTranscriptTailStart).map((entry) => entry.event);
    const events = [...this.eventTranscriptHead, ...tail];
    const omittedEvents = this.totalEventCount - events.length;
    if (omittedEvents === 0) return events;
    const terminal = this.terminal;
    return {
      _truncated: true,
      _omitted_events: omittedEvents,
      events,
      ...(this.usage === undefined ? {} : { usage: this.usage }),
      ...(terminal === undefined
        ? {}
        : {
            terminal: {
              type: "terminal" as const,
              sequence_number: terminal.sequence_number,
              state: terminal.state,
              ...(terminal.stop_reason === undefined ? {} : { stop_reason: terminal.stop_reason }),
              ...(terminal.usage === undefined ? {} : { usage: terminal.usage }),
            },
          }),
    };
  }

  private recordTelemetryEvent(event: CanonicalEvent & { timestamp: number }): void {
    this.totalEventCount += 1;
    // Single serialization per event: the byte size is stored with the entry
    // so eviction subtracts without re-serializing the removed event.
    const eventBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
    if (this.eventTranscriptHeadBytes + eventBytes <= EVENT_TRANSCRIPT_HEAD_CAP) {
      this.eventTranscriptHead.push(event);
      this.eventTranscriptHeadBytes += eventBytes;
      return;
    }
    if (eventBytes > EVENT_TRANSCRIPT_TAIL_CAP) return;
    // Index-pointer queue: no O(N) shift() memmove per eviction. Compact the
    // backing array once the dead prefix grows past the live window.
    while (this.eventTranscriptTailBytes + eventBytes > EVENT_TRANSCRIPT_TAIL_CAP) {
      const removed = this.eventTranscriptTail[this.eventTranscriptTailStart];
      if (removed === undefined) break;
      this.eventTranscriptTailStart += 1;
      this.eventTranscriptTailBytes -= removed.bytes;
    }
    if (this.eventTranscriptTailStart > 1024 && this.eventTranscriptTailStart > this.eventTranscriptTail.length / 2) {
      this.eventTranscriptTail.splice(0, this.eventTranscriptTailStart);
      this.eventTranscriptTailStart = 0;
    }
    this.eventTranscriptTail.push({ event, bytes: eventBytes });
    this.eventTranscriptTailBytes += eventBytes;
  }

  private isClientVisibleEvent(event: CanonicalEvent): boolean {
    if (event.type === "tool_call_delta" || event.type === "tool_result") return true;
    if (event.type === "content_delta") {
      // Extension payloads carry no client-renderable content. Reasoning
      // deltas do: they drive the reasoning pane, and withholding them
      // until the first answer token left the client blank for the whole
      // reasoning phase (seconds to minutes). A reasoning delta commits
      // the candidate the same way answer text does.
      return event.content.kind !== "extension";
    }
    return event.type === "terminal" && event.state === "complete";
  }

  private appendClientResponse(bytes: Uint8Array): void {
    if (this.clientResponseTruncated) return;
    const chunk = this.clientResponseDecoder.decode(bytes, { stream: true });
    if (this.clientResponseLength + chunk.length > CLIENT_RESPONSE_CAP) {
      this.clientResponseChunks.push(chunk.slice(0, CLIENT_RESPONSE_CAP - this.clientResponseLength));
      this.clientResponseLength = CLIENT_RESPONSE_CAP;
      this.clientResponseTruncated = true;
      return;
    }
    this.clientResponseChunks.push(chunk);
    this.clientResponseLength += chunk.length;
  }

  private pushEncodedEvent(
    event: CanonicalEvent & { timestamp: number },
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): boolean {
    const toEnqueue = this.streamEncoder.push(event);
    if (toEnqueue.length > 0 && this.firstByteAt === undefined) this.firstByteAt = Date.now();
    for (const bytes of toEnqueue) {
      controller.enqueue(bytes);
      this.appendClientResponse(bytes);
    }
    return toEnqueue.length > 0;
  }

  /**
   * Records one canonical event and frames it onto the client stream.
   * Returns whether any wire bytes were enqueued (an event can be
   * intentionally invisible on the selected client surface).
   */
  enqueueEvent(
    event: CanonicalEvent,
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): boolean {
    // The one place every surface shares. A provider that writes its reasoning
    // into the answer as `<think>…</think>` had that text forwarded verbatim:
    // the chat wire happened to split it in its own decoder, so chat looked
    // right while messages and responses — and any other provider wire whose
    // text carries the tags — showed the raw reasoning as the answer.
    if (event.type === "content_delta" && event.content.kind === "text") {
      const split = this.thinkSplitter.push(event.content.text);
      let enqueued = false;
      if (split.reasoning.length > 0) {
        enqueued =
          this.enqueueOne(
            { ...event, content: { kind: "reasoning", payload: null, summary: split.reasoning } },
            controller,
          ) || enqueued;
      }
      if (split.text.length > 0) {
        enqueued =
          this.enqueueOne({ ...event, content: { kind: "text", text: split.text } }, controller) ||
          enqueued;
      }
      return enqueued;
    }
    // Text held back for a tag that never completed must be released *before*
    // the terminal: a content event after it is rejected by the surface
    // encoders, and the tail of the answer would be lost instead.
    if (event.type === "terminal") {
      const rest = this.thinkSplitter.flush();
      if (rest.reasoning.length > 0) {
        this.enqueueOne(
          {
            type: "content_delta",
            sequence_number: event.sequence_number,
            content: { kind: "reasoning", payload: null, summary: rest.reasoning },
          },
          controller,
        );
      }
      if (rest.text.length > 0) {
        this.enqueueOne(
          {
            type: "content_delta",
            sequence_number: event.sequence_number,
            content: { kind: "text", text: rest.text },
          },
          controller,
        );
      }
    }
    return this.enqueueOne(event, controller);
  }

  private enqueueOne(
    event: CanonicalEvent,
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): boolean {
    // A split emits two events from one chunk, so the second repeats the source
    // sequence number. The Responses encoder requires strictly increasing
    // numbers, so bump only on a repeat: an already-increasing stream keeps the
    // decoder's own numbers untouched.
    const sequenceNumber = Math.max(event.sequence_number, this.lastSequenceNumber + 1);
    this.lastSequenceNumber = sequenceNumber;
    const timestampedEvent = { ...event, sequence_number: sequenceNumber, timestamp: Date.now() };
    this.recordTelemetryEvent(timestampedEvent);
    this.lastEventAtMs = timestampedEvent.timestamp;

    if (event.type === "content_delta" && this.firstContentDeltaAtMs === undefined) {
      this.firstContentDeltaAtMs = timestampedEvent.timestamp;
    }

    // Captured once, from the opening event. Later events do not repeat it, and
    // a stream that never opens carries no model at all — which is reported as
    // absent rather than backfilled from the request.
    if (
      this.reportedModel === undefined &&
      (event.type === "response_start" || event.type === "message_start") &&
      typeof event.model === "string" &&
      event.model.trim().length > 0
    ) {
      this.reportedModel = event.model;
    }

    if (event.type === "terminal") {
      this.terminal = event;
      if (event.usage) this.usage = event.usage;
    } else if (event.type === "usage") {
      this.usage = event.usage;
    }
    // A Responses prelude that carries no client-renderable content
    // (response_start, usage, extension deltas) is tracked so a provider
    // that closes before producing anything can be retried once. It is
    // streamed as it arrives, not held: holding it until the first answer
    // token blanked the client for the whole reasoning phase, which is the
    // perceived "first response is slow and doesn't chunk" behavior.
    if (this.recoverableResponsesPrelude && this.isClientVisibleEvent(event)) {
      this.clientVisibleEvent = true;
    }
    return this.pushEncodedEvent(timestampedEvent, controller);
  }

  /** Flushes the surface encoder's closing frames (including the `[DONE]` sentinel). */
  finishEncoders(controller: ReadableStreamDefaultController<Uint8Array>): void {
    for (const bytes of this.streamEncoder.finish()) {
      controller.enqueue(bytes);
      this.appendClientResponse(bytes);
    }
  }

  /** Frames and enqueues the terminal SSE error event, recording it in the client transcript. */
  emitErrorFrame(
    input: StreamErrorFrameInput,
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): void {
    for (const bytes of this.streamEncoder.encodeError(input)) {
      controller.enqueue(bytes);
      this.appendClientResponse(bytes);
    }
  }

  /**
   * Discards the buffered state of a Responses prelude that never reached
   * the client, so the single pre-content retry starts from a clean slate.
   * `clientVisibleEvent` is deliberately NOT reset: once anything
   * client-renderable was emitted the retry guard must stay closed.
   */
  resetUncommittedPrelude(): void {
    this.eventTranscriptHead.length = 0;
    this.eventTranscriptTail.length = 0;
    this.eventTranscriptHeadBytes = 0;
    this.eventTranscriptTailBytes = 0;
    this.totalEventCount = 0;
    this.terminal = undefined;
    this.usage = undefined;
    this.lastEventAtMs = undefined;
  }
}
