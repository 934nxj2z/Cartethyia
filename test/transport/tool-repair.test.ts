/**
 * Tool-use auto-repair.
 *
 * The behaviour under test is the positional matching rule: a `toolResult`
 * answers only a `toolCall` in an EARLIER message, never one in the same turn
 * or a later one. That is what stops a replayed stale turn from satisfying the
 * call declared beside it, and stops a result for batch N from silencing a
 * same-id call the client reuses in batch N+1.
 *
 * The last test is a complexity guard, not a micro-benchmark: the repair used
 * to slice the remaining history per assistant turn and scan it per call id
 * (O(n^2·p)), so a long agentic conversation paid a quadratic cost on the
 * request path. It is now one sweep, so the timing is bounded by a constant
 * rather than by the square of the history length.
 */
import { describe, expect, test } from "bun:test";
import type { CanonicalMessage, ContentPart } from "../../src/protocol/canonical-model";
import { repairMissingToolResponses } from "../../src/transport/translation/tool-repair";

function assistantTurn(callIds: readonly string[]): CanonicalMessage {
  return {
    role: "assistant",
    content: callIds.map(
      (call_id): ContentPart => ({ kind: "toolCall", call_id, name: "t", arguments: "{}" }),
    ),
  };
}

function toolTurn(callId: string, text = "ok"): CanonicalMessage {
  return {
    role: "tool",
    content: [{ kind: "toolResult", call_id: callId, content: text, is_error: false }],
  };
}

/** Synthetic error results the repair inserted, as `{ callId, isError }`. */
function synthesized(messages: readonly CanonicalMessage[]): { callId: string; isError: boolean }[] {
  const out: { callId: string; isError: boolean }[] = [];
  for (const message of messages) {
    for (const part of message.content) {
      if (part.kind !== "toolResult") continue;
      if (part.content === "<missing tool output>") {
        out.push({ callId: part.call_id, isError: part.is_error === true });
      }
    }
  }
  return out;
}

describe("repairMissingToolResponses", () => {
  test("synthesizes an error result for an unanswered call", () => {
    const repaired = repairMissingToolResponses([assistantTurn(["c1"])]);
    expect(synthesized(repaired)).toEqual([{ callId: "c1", isError: true }]);
    // The synthetic message follows the assistant turn that declared the call.
    expect(repaired).toHaveLength(2);
    expect(repaired[1]?.role).toBe("tool");
  });

  test("leaves an answered call alone", () => {
    const history = [assistantTurn(["c1"]), toolTurn("c1")];
    expect(synthesized(repairMissingToolResponses(history))).toEqual([]);
    expect(repairMissingToolResponses(history)).toHaveLength(2);
  });

  test("a result before its call does not answer it", () => {
    // The positional rule: only results in LATER messages count. A client that
    // replays a stale turn first must still get its call repaired.
    const history = [toolTurn("c1"), assistantTurn(["c1"])];
    expect(synthesized(repairMissingToolResponses(history))).toEqual([
      { callId: "c1", isError: true },
    ]);
  });

  test("a reused id is answered per batch, not globally", () => {
    // The client reuses `c1` in a second batch. The first is answered; the
    // second is orphaned and must be synthesized.
    const history = [assistantTurn(["c1"]), toolTurn("c1"), assistantTurn(["c1"])];
    expect(synthesized(repairMissingToolResponses(history))).toEqual([
      { callId: "c1", isError: true },
    ]);
    // Two original assistant turns, two original tool turns, one synthetic.
    expect(repairMissingToolResponses(history)).toHaveLength(4);
  });

  test("synthesizes only the unanswered member of a partial batch", () => {
    const history = [assistantTurn(["c1", "c2"]), toolTurn("c1")];
    expect(synthesized(repairMissingToolResponses(history))).toEqual([
      { callId: "c2", isError: true },
    ]);
  });

  test("a long history with one orphan stays linear, not quadratic", () => {
    // 1 000 assistant turns, each answered, plus one orphan up front. The old
    // implementation sliced and rescanned the tail per assistant turn, so its
    // cost grew with the square of this length; the ceiling below is far above
    // the linear cost but far below the quadratic one.
    const history: CanonicalMessage[] = [assistantTurn(["orphan"])];
    for (let index = 0; index < 1000; index += 1) {
      history.push(assistantTurn([`k${index}`]));
      history.push(toolTurn(`k${index}`));
    }

    // Warm the JIT so the measurement is not a first-call compile.
    repairMissingToolResponses(history);
    const startedAt = performance.now();
    const repaired = repairMissingToolResponses(history);
    const elapsedMs = performance.now() - startedAt;

    expect(synthesized(repaired)).toEqual([{ callId: "orphan", isError: true }]);
    expect(elapsedMs).toBeLessThan(50);
  });
});
