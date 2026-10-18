/**
 * The model an upstream reports, read from the response bytes.
 *
 * One reader, in `providers/operations/reported-model.ts`, because every
 * provider dispatch reaches the network through the same wrapper. The adapters
 * used to synthesize their opening event with the model *we asked for*, so a
 * provider answering `deepseek-v4.1-flash` to a `nemotron` request reported as
 * if it had complied — and fixing that per adapter meant six edits with a
 * seventh always missing.
 *
 * The value is taken **verbatim**: no prefix stripping, no comparison, no
 * fallback to the requested id. An earlier draft stripped the provider prefix
 * and hid the chip when the stripped names matched, which suppressed exactly
 * the case worth seeing.
 */
import { describe, expect, test } from "bun:test";
import { readReportedModel } from "../../src/providers/operations/reported-model";

function responseOf(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

describe("reported model from the response", () => {
  test("a chat SSE chunk names the model", async () => {
    // Byte-identical to the chunk an operator captured from WorkBuddy.
    const body =
      'data: {"id":"chatcmpl-cb147f63-0a18-4c55-ab0d-5172cc263cb1","object":"chat.completion.chunk",' +
      '"created":1792239564.016,"model":"deepseek-v4.1-flash","choices":[{"index":0,' +
      '"delta":{"role":"assistant","content":""},"finish_reason":null}],"usage":null}\n\n';
    expect(await readReportedModel(responseOf(body))).toBe("deepseek-v4.1-flash");
  });

  test("a prefixed id is returned exactly as written", async () => {
    const body = 'data: {"model":"bansos/glm-5.3-flash","choices":[]}\n\n';
    expect(await readReportedModel(responseOf(body))).toBe("bansos/glm-5.3-flash");
  });

  test("a non-streaming JSON body is read too", async () => {
    const body = JSON.stringify({ id: "x", model: "glm-5.3-flash", choices: [] });
    expect(await readReportedModel(responseOf(body))).toBe("glm-5.3-flash");
  });

  test("a Gemini frame is read from modelVersion", async () => {
    const body = JSON.stringify({ candidates: [], modelVersion: "gemini-2.5-flash" });
    expect(await readReportedModel(responseOf(body))).toBe("gemini-2.5-flash");
  });

  test("a Responses lifecycle frame is read from the nested response", async () => {
    const body = 'data: {"type":"response.created","response":{"model":"gpt-5.5"}}\n\n';
    expect(await readReportedModel(responseOf(body))).toBe("gpt-5.5");
  });

  test("a body that names no model yields nothing, not the requested id", async () => {
    // Absent means the upstream said nothing. Filling in the ask would report
    // the question as if it were the answer.
    expect(await readReportedModel(responseOf('data: {"choices":[]}\n\n'))).toBeUndefined();
  });

  test("the model is found before the whole stream is buffered", async () => {
    // The first frame carries it; the rest is bulk that must not be read.
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled === 1) {
          controller.enqueue(new TextEncoder().encode('data: {"model":"early-model"}\n\n'));
          return;
        }
        // Bulk that would cost real memory if the reader drained it. It must
        // never be reached: the model was in frame one.
        if (pulled > 200) {
          controller.close();
          return;
        }
        controller.enqueue(new TextEncoder().encode("data: " + "x".repeat(4096) + "\n\n"));
      },
    });
    expect(await readReportedModel(new Response(body))).toBe("early-model");
    // A diagnostic must not stream the whole answer into memory.
    expect(pulled).toBeLessThan(50);
  });

  test("a malformed body is not an error", async () => {
    expect(await readReportedModel(responseOf("not json at all"))).toBeUndefined();
  });
});
