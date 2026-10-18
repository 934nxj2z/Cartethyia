/**
 * Which streamed tool-call deltas the chat encoder forwards.
 *
 * Copilot streams one call as many events: every event but the last carries a
 * slice of the id and a slice of the arguments, and no name. Those slices must
 * not reach the client as calls of their own.
 *
 * The bug this pins: the slice test keyed on a `call_` id prefix. That also
 * dropped the *argument* continuation of any call whose id is shaped
 * differently — Anthropic's `toolu_…`, the decoder's synthesized
 * `call-N-frag` — so the client assembled the call with no arguments at all,
 * intermittently and only on some providers.
 */
import { describe, expect, test } from "bun:test";
import type { CanonicalEvent } from "../../src/protocol/canonical-model";
import { ChatStreamEncoder } from "../../src/transport/surface/chat/encode";

type ToolFrame = Record<string, unknown>;

function toolFrames(events: CanonicalEvent[]): ToolFrame[] {
  const encoder = new ChatStreamEncoder({}, "test-model", "chatcmpl-test");
  const frames: ToolFrame[] = [];
  for (const event of events) {
    for (const chunk of encoder.push(event)) {
      const choices = chunk["choices"] as Record<string, unknown>[] | undefined;
      const delta = choices?.[0]?.["delta"] as Record<string, unknown> | undefined;
      const calls = delta?.["tool_calls"] as ToolFrame[] | undefined;
      if (calls) frames.push(...calls);
    }
  }
  return frames;
}

function toolDelta(
  sequenceNumber: number,
  callId: string,
  extra: { name?: string; arguments_delta?: string; index?: number },
): CanonicalEvent {
  return {
    type: "tool_call_delta",
    sequence_number: sequenceNumber,
    call_id: callId,
    ...extra,
  } as CanonicalEvent;
}

describe("chat tool-call slices", () => {
  test("drops the nameless id slices Copilot sends before the real call", () => {
    const frames = toolFrames([
      toolDelta(1, "ca", { arguments_delta: '{"pa', index: 0 }),
      toolDelta(2, "ll_", { arguments_delta: 'th":', index: 0 }),
      toolDelta(3, "call_q2rb", { name: "write", arguments_delta: '{"path":"a.txt"}', index: 0 }),
    ]);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.["id"]).toBe("call_q2rb");
    const fn = frames[0]?.["function"] as Record<string, unknown>;
    expect(fn["name"]).toBe("write");
    expect(JSON.parse(fn["arguments"] as string)).toEqual({ path: "a.txt" });
  });

  test("keeps the arguments a provider streams after the name, whatever the id shape", () => {
    // Anthropic-shaped ids: `toolu_…`, which never starts with `call_`.
    const frames = toolFrames([
      toolDelta(1, "toolu_01abc", { name: "write", arguments_delta: '{"path":', index: 0 }),
      toolDelta(2, "toolu_01abc", { arguments_delta: '"a.txt"}', index: 0 }),
    ]);
    expect(frames).toHaveLength(2);
    const fn = frames[1]?.["function"] as Record<string, unknown>;
    expect(fn["arguments"]).toBe('"a.txt"}');
  });

  test("keeps a continuation the decoder identified by a synthesized id", () => {
    // An id-less wire fragment is minted `call-<n>-frag`, which is not `call_`.
    const frames = toolFrames([
      toolDelta(1, "call-0-frag", { name: "write", arguments_delta: '{"path":', index: 0 }),
      toolDelta(2, "call-0-frag", { arguments_delta: '"b.txt"}', index: 0 }),
    ]);
    expect(frames).toHaveLength(2);
  });
});
