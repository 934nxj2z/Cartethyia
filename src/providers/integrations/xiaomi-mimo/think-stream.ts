/**
 * Splits inline thinking tags in the Xiaomi MiMo Studio SSE stream.
 *
 * Studio interleaves `<think>` or `<thinking>` spans with answer text and
 * NUL padding. Desktop uses the separate `reasoning_content` chat field,
 * so its standard OpenAI-compatible stream decoder does not use this splitter.
 *
 * The splitter is stateful because a tag can straddle two SSE frames: the
 * `<thi` of one chunk and the `nk>` of the next are one opening tag, and a
 * stateless regex would emit the fragment as text. It therefore holds back a
 * trailing run that could still become a tag until the next chunk settles it.
 *
 * Two further quirks are handled here rather than at each call site:
 * - NUL bytes (`\u0000`) are injected by the upstream between thought tokens;
 *   forwarded verbatim they break JSON encoders and terminal renderers.
 * - Text before an opening tag is the answer (some models answer first and
 *   reason afterwards), so it stays content; only the enclosed span becomes
 *   reasoning.
 */

/** Tags whose enclosed span is reasoning, longest-first so `</thinking>` is never split as `<t`. */
const OPEN_TAGS = ["<thinking>", "<think>"] as const;
const CLOSE_TAGS = ["</thinking>", "</think>"] as const;

/**
 * Removes stray thinking tags from a settled string.
 *
 * Call sites that stream `reasoning_content` through to the client as a
 * canonical `reasoning` part forward the field verbatim, so when the upstream
 * double-wraps its own reasoning in `<think>…</think>` the tag bytes reach the
 * client. The hy4-preview-f buddy model does this intermittently: the real
 * answer appears inside the reasoning stream between `<think>` markers and the
 * `content` stream reads blank, which is why the model is sometimes read as
 * "not thinking" even though it was.
 *
 * The function is for a value that has already settled — a non-stream message
 * body, or a stream delta that is not being tracked across chunks — so it is
 * not stateful; a tag split across two chunks is a job for `MimoThinkSplitter`.
 * Both case variants pass through: `<Think>` and `<THINK>` survived everyone's
 * normalizer long enough for them not to be the leak this closes.
 */
export function stripThinkingTags(value: string): string {
  if (!value.includes("<")) return value;
  // Both the open-close pair and a stray marker on its own: an upstream that
  // dropped the opening tag before `reasoning_content` was committed still
  // leaves the closing one behind, and the lone tag reads just as badly to the
  // client as a paired one.
  return value
    .replace(/<think(?:ing)?\b[^>]*>/g, "")
    .replace(/<\/think(?:ing)?\s*>/g, "");
}

/** The longest suffix of `text` that is a proper prefix of any tag. */
function danglingTagPrefix(text: string): string {
  const tags = [...OPEN_TAGS, ...CLOSE_TAGS];
  const maxLength = Math.max(...tags.map((tag) => tag.length)) - 1;
  const limit = Math.min(maxLength, text.length);
  for (let length = limit; length > 0; length -= 1) {
    const suffix = text.slice(-length);
    if (tags.some((tag) => tag.startsWith(suffix))) return suffix;
  }
  return "";
}

/** Strips the NUL padding MiMo injects into thought streams. */
function stripNul(text: string): string {
  return text.includes("\u0000") ? text.replace(/\u0000/g, "") : text;
}

export interface ThinkSplit {
  /** Answer text, with all reasoning spans removed. */
  readonly text: string;
  /** Reasoning text, tag-free. Empty when the chunk carried no thought. */
  readonly reasoning: string;
}

/**
 * Splits one upstream text chunk into answer text and reasoning text.
 *
 * Call `flush()` once the upstream stream ends to release any text the
 * splitter held back while it waited for a possible tag to complete.
 */
export class MimoThinkSplitter {
  #buffer = "";
  #inReasoning = false;

  /** Feeds a chunk; returns the text/reasoning split for everything settled. */
  push(chunk: string): ThinkSplit {
    this.#buffer += stripNul(chunk);
    let text = "";
    let reasoning = "";

    for (;;) {
      if (!this.#inReasoning) {
        const opened = this.#findOpen();
        if (opened === undefined) break;
        text += this.#buffer.slice(0, opened.index);
        this.#buffer = this.#buffer.slice(opened.index + opened.length);
        this.#inReasoning = true;
        continue;
      }
      const closed = this.#findClose();
      if (closed === undefined) break;
      reasoning += this.#buffer.slice(0, closed.index);
      this.#buffer = this.#buffer.slice(closed.index + closed.length);
      this.#inReasoning = false;
    }

    // Hold back a suffix that could still grow into a tag; the rest is settled.
    const held = danglingTagPrefix(this.#buffer);
    const settled = held.length > 0 ? this.#buffer.slice(0, -held.length) : this.#buffer;
    this.#buffer = held;
    // A lone closing tag lands here when the upstream dropped the opener before
    // committing the answer — the same quirk `stripThinkingTags` handles for
    // settled values, and just as bad to forward: the tag bytes are rendered in
    // the chat. Inside a reasoning span the text is already tag-free, so only
    // the answer side is swept.
    if (this.#inReasoning) reasoning += settled;
    else text += stripThinkingTags(settled);

    return { text, reasoning };
  }

  /** Releases text held back for a tag that never completed. */
  flush(): ThinkSplit {
    const rest = this.#buffer;
    this.#buffer = "";
    return this.#inReasoning
      ? { text: "", reasoning: rest }
      : { text: stripThinkingTags(rest), reasoning: "" };
  }

  #findOpen(): { index: number; length: number } | undefined {
    let best: { index: number; length: number } | undefined;
    for (const tag of OPEN_TAGS) {
      const index = this.#buffer.indexOf(tag);
      if (index === -1) continue;
      if (best === undefined || index < best.index) best = { index, length: tag.length };
    }
    return best;
  }

  #findClose(): { index: number; length: number } | undefined {
    let best: { index: number; length: number } | undefined;
    for (const tag of CLOSE_TAGS) {
      const index = this.#buffer.indexOf(tag);
      if (index === -1) continue;
      if (best === undefined || index < best.index) best = { index, length: tag.length };
    }
    return best;
  }
}

