import { describe, expect, test } from "bun:test";
import type { CanonicalEvent } from "../../src/protocol/canonical-model";
import { encodeResponsesWireEvents } from "../../src/transport/surface/responses/encode";

/**
 * Responses contract — reasoning→text and text→reasoning must close one item
 * before opening the next.
 *
 * The hy4-preview-f family exposed the bug clearly: the wire landed as
 * `output_item.added(reasoning)` → reasoning deltas →
 * `output_item.added(message)` → message deltas → `output_item.done(message)`
 * → `reasoning_summary_text.done` → `reasoning_summary_part.done` →
 * `output_item.done(reasoning)`. The second `output_item.added` arrived while
 * the first item was still open on the wire, which a strict client surfaces
 * as "thinking block still streaming while the answer is already landing" —
 * UI pecah di tengah stream.
 *
 * The fix closes the active non-tool item before opening the next one. Tool
 * calls still park because upstream genuinely interleaves parallel-call args;
 * `openTool`'s parked lookup is what keeps the second A-delta on the same
 * `output_item` instead of forking a duplicate.
 */

function makeStart(): CanonicalEvent {
  return {
    type: "response_start",
    sequence_number: 1,
    model: "test-model",
    event_id: "resp-1",
  };
}

function makeReasoningDelta(summary: string, summaryIndex = 0): CanonicalEvent {
  return {
    type: "content_delta",
    sequence_number: 2,
    item_id: "r1",
    content: {
      kind: "reasoning",
      payload: null,
      summary,
      summary_index: summaryIndex,
    },
  };
}

function makeTextDelta(text: string): CanonicalEvent {
  return {
    type: "content_delta",
    sequence_number: 3,
    content: { kind: "text", text },
  };
}

function makeTerminal(): CanonicalEvent {
  return {
    type: "terminal",
    sequence_number: 10,
    state: "complete",
    stop_reason: "stop",
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cached_input_tokens: 0,
      cache_write_tokens: 0,
      uncached_input_tokens: 10,
      reasoning_tokens: 2,
      estimated_cost: 0,
    },
  };
}

/** Returns the wire event `type` list in order, so order is the assertion. */
function wireOrder(events: readonly { type: string }[]): string[] {
  return events.map((event) => event.type);
}

describe("Responses encoder — item lifecycle on a reasoning→text switch", () => {
  test("the reasoning item is fully done before the message item is added", () => {
    const events = encodeResponsesWireEvents([
      makeStart(),
      makeReasoningDelta("Thinking about 2 + 2."),
      makeTextDelta("4"),
      makeTerminal(),
    ]);
    const types = wireOrder(events);

    const reasoningAdded = types.indexOf("response.output_item.added");
    const reasoningSummaryDone = types.indexOf("response.reasoning_summary_text.done");
    const reasoningPartDone = types.indexOf("response.reasoning_summary_part.done");
    const reasoningItemDone = types.indexOf("response.output_item.done");
    const messageAdded = types.indexOf(
      "response.output_item.added",
      reasoningAdded + 1,
    );
    const messageItemDone = types.indexOf("response.output_item.done", reasoningItemDone + 1);

    expect(reasoningSummaryDone).toBeGreaterThan(reasoningAdded);
    expect(reasoningPartDone).toBeGreaterThan(reasoningSummaryDone);
    expect(reasoningItemDone).toBeGreaterThan(reasoningPartDone);
    // The whole reasoning lifecycle lands before the message is added. This is
    // the invariant that keeps a strict client from seeing two open items.
    expect(messageAdded).toBeGreaterThan(reasoningItemDone);
    expect(messageItemDone).toBeGreaterThan(messageAdded);
  });

  test("every opened item has a matching done event", () => {
    const events = encodeResponsesWireEvents([
      makeStart(),
      makeReasoningDelta("thinking"),
      makeTextDelta("hello"),
      makeTerminal(),
    ]);
    const added = events.filter((event) => event.type === "response.output_item.added");
    const done = events.filter((event) => event.type === "response.output_item.done");
    expect(done.length).toBe(added.length);
    for (const [index, add] of added.entries()) {
      // Same output_index on each pair, same order: this is what proves the
      // closes are not just happening at the terminal catch-all.
      expect(done[index]?.output_index).toBe(add.output_index);
    }
  });

  test("done events for the reasoning item appear in output order, not final-flush order", () => {
    const events = encodeResponsesWireEvents([
      makeStart(),
      makeReasoningDelta("thinking"),
      makeTextDelta("answer"),
      makeTerminal(),
    ]);
    // Group events by output_index and assert each item's events are a
    // contiguous run — if the reasoning item's done events are flushed only
    // at the terminal, the first group would be interleaved by the second.
    let currentIndex: number | undefined;
    const runs: number[][] = [];
    for (const event of events) {
      const idx = (event as { output_index?: number }).output_index;
      if (idx === undefined) continue;
      if (idx !== currentIndex) {
        runs.push([idx]);
        currentIndex = idx;
        continue;
      }
      runs[runs.length - 1]?.push(idx);
    }
    // Each distinct output_index should appear once in `runs` (one contiguous
    // block). A regression would make the reasoning index (0) appear in two
    // non-adjacent runs: once for added+deltas, once for the trailing dones.
    const distinctRuns = new Set(runs.map((run) => run[0]));
    expect(runs.length).toBe(distinctRuns.size);
  });
});
