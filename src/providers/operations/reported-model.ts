/**
 * Reads the model an upstream named in its own response.
 *
 * One place, not one per adapter. Every provider dispatch — chat, responses,
 * messages, gemini, antigravity, factory, kiro, perplexity — reaches the
 * network through `context.outbound_fetch`, and every one of them puts the
 * model it actually ran somewhere in the response: a `model` field on a JSON
 * body, a `model` field on each SSE chunk, or `modelVersion` on a Gemini frame.
 *
 * Reading it here rather than in each adapter is not a convenience. The adapters
 * were each synthesizing their own opening event with the model *we asked for*,
 * so a provider answering `deepseek-v4.1-flash` to a `nemotron` request was
 * reported as having complied. Fixing that per adapter meant six edits with a
 * seventh always missing — and a provider nobody had thought of would report
 * the ask as the answer with nothing to indicate it.
 *
 * This module is deliberately transport-agnostic: it inspects bytes, not
 * canonical events, so it sees what the upstream wrote before any adapter has
 * had a chance to replace it.
 */

/** Fields an upstream uses to name the model it ran. */
const MODEL_KEYS = ["model", "modelVersion"] as const;

/** Enough of the body to contain the first SSE chunk or a small JSON envelope. */
const HEAD_BYTES = 8 * 1024;

/**
 * Pulls a model id out of one JSON object, looking at the nested shapes the
 * wires actually use.
 *
 * `response.model` covers the Responses lifecycle frames; `modelVersion` covers
 * Gemini and its clones. The top level covers plain chat completions.
 */
function modelFromObject(value: unknown, depth = 0): string | undefined {
  if (depth > 3 || typeof value !== "object" || value === null) return undefined;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = modelFromObject(entry, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of MODEL_KEYS) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate;
  }
  // Responses frames nest the payload: `{type:"response.created",response:{model}}`.
  for (const key of ["response", "candidate", "message", "data"] as const) {
    const found = modelFromObject(record[key], depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Parses one SSE `data:` line, or a whole JSON body. Returns undefined on anything else. */
function modelFromText(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  // A JSON body may be one object; an SSE body is a run of `data: {...}` lines.
  const candidates = trimmed.includes("data:")
    ? trimmed
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter((line) => line.length > 0 && line !== "[DONE]")
    : [trimmed];
  for (const candidate of candidates) {
    try {
      const found = modelFromObject(JSON.parse(candidate) as unknown);
      if (found !== undefined) return found;
    } catch {
      // A partial or non-JSON frame is not an answer; keep looking.
    }
  }
  return undefined;
}

/**
 * Reads the model from a response body without consuming it for the caller.
 *
 * The body is cloned, and only the head is read: a streamed answer can run to
 * megabytes, and the model appears in the first frame. When the head does not
 * contain it (a provider that names the model late), this returns nothing
 * rather than buffering the whole stream — a diagnostic must not change how
 * much memory a request costs.
 *
 * Never throws: a failure here must not affect a dispatch that is otherwise
 * fine.
 */
export async function readReportedModel(response: Response): Promise<string | undefined> {
  if (!response.body) return undefined;
  try {
    const reader = response.clone().body?.getReader();
    if (reader === undefined) return undefined;
    let text = "";
    let bytes = 0;
    let found: string | undefined;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      bytes += value.byteLength;
      text += new TextDecoder().decode(value, { stream: true });
      found = modelFromText(text);
      if (found !== undefined) break;
      if (bytes >= HEAD_BYTES) break;
    }
    // Cancel without awaiting: on a stream whose producer is still running,
    // `cancel()` settles only once the source cooperates, and a diagnostic must
    // never hold the request open waiting for that. The reader is dropped either
    // way, and an unread clone is garbage.
    void reader.cancel().catch(() => undefined);
    return found ?? modelFromText(text);
  } catch {
    return undefined;
  }
}
