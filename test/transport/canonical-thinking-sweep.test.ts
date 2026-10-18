/**
 * Thinking tags a provider writes into its *answer* text.
 *
 * The chat wire splits `…` in its own decoder, so chat looked correct
 * while messages and responses — and every other provider wire whose text
 * carries the tags — forwarded the raw reasoning to the client as the answer.
 * The sweep now lives in the canonical pipeline every surface shares.
 */
import { describe, expect, test } from "bun:test";
import type { CanonicalEvent } from "../../src/protocol/canonical-model";
import { StreamEventPipeline } from "../../src/transport/dispatch/streaming/encoder";

function pipeline(): StreamEventPipeline {
  return new StreamEventPipeline("responses", {}, false);
}

const controller = {
  enqueue: () => {},
} as unknown as ReadableStreamDefaultController<Uint8Array>;

function textDelta(text: string, sequenceNumber: number): CanonicalEvent {
  return {
    type: "content_delta",
    sequence_number: sequenceNumber,
    content: { kind: "text", text },
  };
}

function recorded(pipe: StreamEventPipeline): CanonicalEvent[] {
  const transcript = pipe.telemetryEventTranscript;
  return Array.isArray(transcript) ? (transcript as CanonicalEvent[]) : [];
}

function contentKinds(events: CanonicalEvent[]): string[] {
  const kinds: string[] = [];
  for (const event of events) {
    if (event.type === "content_delta") kinds.push(event.content.kind);
  }
  return kinds;
}

function textOf(events: CanonicalEvent[]): string | undefined {
  for (const event of events) {
    if (event.type === "content_delta" && event.content.kind === "text") return event.content.text;
  }
  return undefined;
}

function summaryOf(events: CanonicalEvent[]): string | undefined {
  for (const event of events) {
    if (event.type === "content_delta" && event.content.kind === "reasoning")
      return event.content.summary;
  }
  return undefined;
}

describe("canonical thinking sweep", () => {
  test("splits an inline think span out of the answer text", () => {
    const pipe = pipeline();
    pipe.enqueueEvent(textDelta("<think>secret plan</think>Hello", 1), controller);

    const events = recorded(pipe);
    expect(contentKinds(events)).toEqual(["reasoning", "text"]);
    expect(summaryOf(events)).toBe("secret plan");
    expect(textOf(events)).toBe("Hello");
  });

  test("drops a stray closing tag that has no opener", () => {
    const pipe = pipeline();
    pipe.enqueueEvent(textDelta("done</think>", 1), controller);

    expect(textOf(recorded(pipe))).toBe("done");
  });

  test("holds a tag split across two chunks and never leaks its bytes", () => {
    const pipe = pipeline();
    pipe.enqueueEvent(textDelta("<thi", 1), controller);
    pipe.enqueueEvent(textDelta("nk>a</think>b", 2), controller);

    const events = recorded(pipe);
    expect(contentKinds(events)).toEqual(["reasoning", "text"]);
    expect(summaryOf(events)).toBe("a");
    expect(textOf(events)).toBe("b");
    expect(pipe.clientResponseText).not.toContain("think");
  });

  test("releases held-back answer text before the terminal", () => {
    const pipe = pipeline();
    pipe.enqueueEvent(textDelta("tail</thi", 1), controller);
    pipe.enqueueEvent(
      { type: "terminal", sequence_number: 2, state: "complete" } as CanonicalEvent,
      controller,
    );

    const events = recorded(pipe);
    expect(textOf(events)).toBe("tail");
    // The released text precedes the terminal: a content event after it is
    // rejected by the surface encoders.
    expect(events.findIndex((event) => event.type === "terminal")).toBeGreaterThan(
      events.findIndex((event) => event.type === "content_delta"),
    );
  });
});
