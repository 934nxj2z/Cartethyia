import type { CanonicalEvent } from "../../protocol/canonical-model";

export interface ReasoningSummaryIdentity {
  readonly itemId?: string;
  readonly outputIndex?: number;
  readonly summaryIndex?: number;
}

/** Returns the source identity of one reasoning-summary delta, if present. */
export function reasoningSummaryIdentity(
  event: CanonicalEvent,
): ReasoningSummaryIdentity | undefined {
  if (event.type !== "content_delta" || event.content.kind !== "reasoning") return undefined;
  if (
    event.item_id === undefined &&
    event.output_index === undefined &&
    event.content.summary_index === undefined
  )
    return undefined;
  return {
    ...(event.item_id === undefined ? {} : { itemId: event.item_id }),
    ...(event.output_index === undefined ? {} : { outputIndex: event.output_index }),
    ...(event.content.summary_index === undefined
      ? {}
      : { summaryIndex: event.content.summary_index }),
  };
}

/** Whether two deltas belong to distinct source summary parts/items. */
export function reasoningSummaryHasBoundary(
  previous: ReasoningSummaryIdentity | undefined,
  current: ReasoningSummaryIdentity | undefined,
): boolean {
  if (previous === undefined || current === undefined) return false;
  return (
    (previous.itemId !== undefined &&
      current.itemId !== undefined &&
      previous.itemId !== current.itemId) ||
    (previous.outputIndex !== undefined &&
      current.outputIndex !== undefined &&
      previous.outputIndex !== current.outputIndex) ||
    previous.summaryIndex !== current.summaryIndex
  );
}

/**
 * Separates distinct summary parts without splitting a word.
 *
 * A boundary between two source items is not a boundary between two
 * sentences. Copilot streams one thought as many items, and the token that
 * ends one item is the first half of a word the next item finishes. Inserting
 * a break there painted `Gil` in the thinking pane and `iran` in the answer.
 *
 * The part that decides is the one that *opens*: a part starting with a
 * capital, or with the markdown marker a summary block begins with, is a new
 * thought; a part starting mid-word is a continuation. Requiring the previous
 * part to end a sentence as well dropped the break between two headers that
 * carry no terminal punctuation (`**Crafting a brief reply**`), which glued
 * separate thoughts into one line.
 */
export function reasoningSummarySeparator(
  previous: ReasoningSummaryIdentity | undefined,
  current: ReasoningSummaryIdentity | undefined,
  previousText: string | undefined,
  currentText: string,
): string {
  if (!reasoningSummaryHasBoundary(previous, current)) return "";
  if (/\s$/.test(previousText ?? "") || /^\s/.test(currentText)) return "";
  // The part that opens decides: a capital, or the markdown marker a summary
  // block starts with, begins a thought, so the break is a paragraph.
  if (/^[A-ZÀ-ÖØ-Þ*#\-]/.test(currentText)) return "\n\n";
  // A part opening mid-word is a continuation, not a new thought — that is the
  // `Gil` + `iran` case, and it gets nothing. But when the previous part closed
  // a sentence, the next one is a different artifact (the raw reasoning after a
  // summary), and gluing them produced `file.raw private reasoning`.
  if (/[.!?][)"'\]]*$/.test(previousText ?? "")) return " ";
  return "";
}
