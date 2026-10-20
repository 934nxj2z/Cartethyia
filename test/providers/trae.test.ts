import { describe, expect, test } from "bun:test";
import {
  TRAE_REALMS,
  traeCoreCandidates,
  traeRealmForProvider,
} from "../../src/providers/integrations/trae/trae-realm";
import { TRAE_CN_MODELS, TRAE_INTL_MODELS, traeMaxContextWindow } from "../../src/providers/integrations/trae/trae-catalog";
import { buildTraeHeaders, traeDeviceIdentity } from "../../src/providers/integrations/trae/trae-headers";
import { buildTraeChatBody, parseTraeSse } from "../../src/providers/integrations/trae/trae-protocol";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";

function request(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: "gpt-5.5",
    messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
    generation_controls: {},
    stream: true,
    source_surface: "openai-chat",
    ...overrides,
  } as CanonicalRequest;
}

describe("trae realms", () => {
  test("provider id selects the deployment", () => {
    expect(traeRealmForProvider("traecn")).toBe("cn");
    expect(traeRealmForProvider("trae")).toBe("intl");
  });

  test("CN has exactly one core host and intl has fallbacks", () => {
    expect(traeCoreCandidates("cn")).toEqual([TRAE_REALMS.cn.core]);
    expect(traeCoreCandidates("intl").length).toBeGreaterThan(1);
  });

  test("only CN supports the live model list", () => {
    // intl answers `403 no schema found`, so discovery must not claim success.
    expect(TRAE_REALMS.cn.modelListSupported).toBe(true);
    expect(TRAE_REALMS.intl.modelListSupported).toBe(false);
  });

  test("the realms do not share a core host", () => {
    // A shared host would mean one of them is dispatched to the wrong
    // deployment, which upstream refuses outright.
    expect(TRAE_REALMS.cn.core).not.toBe(TRAE_REALMS.intl.core);
  });
});

describe("trae rosters", () => {
  test("each realm keeps its own roster", () => {
    const cn = new Set(TRAE_CN_MODELS.map((m) => m.modelId));
    const intl = new Set(TRAE_INTL_MODELS.map((m) => m.modelId));
    expect(cn.size).toBeGreaterThan(0);
    expect(intl.size).toBeGreaterThan(0);
    for (const id of intl) expect(cn.has(id)).toBe(false);
  });

  test("CN advertises the selectable maximum, not the active window", () => {
    // 116k is the active window; upstream also offers 1M. Reading only the
    // active window is what made the fetcher always pick the low number.
    const deepseek = TRAE_CN_MODELS.find((m) => m.modelId === "DeepSeek-V4-Flash-Official");
    expect(deepseek?.contextLimit).toBe(1_000_000);
  });
});

describe("traeMaxContextWindow", () => {
  test("prefers the largest selectable window", () => {
    expect(
      traeMaxContextWindow({
        context_window_size: { default: 116000, max: [1000000, 256000] },
      }),
    ).toBe(1_000_000);
  });

  test("falls back to the active window when no max is offered", () => {
    expect(traeMaxContextWindow({ context_window_size: { default: 256000, max: null } })).toBe(256000);
  });

  test("reads the older context_window_tokens spelling", () => {
    expect(traeMaxContextWindow({ context_window_tokens: { dev: 200000, max: 1000000 } })).toBe(1_000_000);
  });

  test("answers undefined rather than guessing", () => {
    expect(traeMaxContextWindow({})).toBeUndefined();
    expect(traeMaxContextWindow(null)).toBeUndefined();
  });
});

describe("trae device identity", () => {
  test("one account is stable and two accounts never share a device", () => {
    const a = traeDeviceIdentity("12345");
    const again = traeDeviceIdentity("12345");
    const b = traeDeviceIdentity("67890");
    expect(a.machineId).toBe(again.machineId);
    expect(a.machineId).not.toBe(b.machineId);
    expect(a.deviceId).not.toBe(b.deviceId);
  });

  test("a numeric account id is reused verbatim as the device id", () => {
    expect(traeDeviceIdentity("1234567890123456789").deviceId).toBe("1234567890123456789");
  });

  test("a non-numeric id still yields a 19-digit numeric device id", () => {
    expect(traeDeviceIdentity("user@example.com").deviceId).toMatch(/^\d{19}$/);
  });
});

describe("buildTraeHeaders", () => {
  test("CN authenticates with Cloud-IDE-JWT", () => {
    const headers = buildTraeHeaders({ realm: "cn", token: "t", uid: "1" });
    expect(headers["Authorization"]).toBe("Cloud-IDE-JWT t");
    expect(headers["x-ide-token"]).toBe("t");
  });

  test("intl overrides to Bearer and sends the client version", () => {
    // intl answers 4015 without the current version on these headers.
    const headers = buildTraeHeaders({ realm: "intl", token: "t", uid: "1", clientVersion: "3.6.0" });
    expect(headers["Authorization"]).toBe("Bearer t");
    expect(headers["x-ide-version"]).toBe("3.6.0");
    expect(headers["x-app-version"]).toBe("3.6.0");
    expect(headers["User-Agent"]).toBe("TraeClient/TTNet");
  });

  test("a stream request takes the SSE Accept", () => {
    const headers = buildTraeHeaders({ realm: "cn", token: "t", uid: "1", stream: true });
    expect(headers["Accept"]).toBe("text/event-stream");
  });

  test("extra headers replace case-insensitively and null deletes", () => {
    const headers = buildTraeHeaders({
      realm: "cn",
      token: "t",
      uid: "1",
      extra: { "x-ide-token": "other", "X-Request-Id": null },
    });
    expect(headers["x-ide-token"]).toBe("other");
    expect(headers["X-Request-Id"]).toBeUndefined();
  });
});

describe("buildTraeChatBody", () => {
  test("the model is sent as model_name", () => {
    // Upstream ignores `model` and silently serves its default instead.
    const body = buildTraeChatBody("gpt-5.5", request(), "intl");
    expect(body.model_name).toBe("gpt-5.5");
    expect("model" in body).toBe(false);
  });

  test("content is always a parts array", () => {
    const body = buildTraeChatBody("gpt-5.5", request(), "intl");
    for (const message of body.messages) {
      expect(Array.isArray(message.content)).toBe(true);
      expect(message.content[0]?.type).toBe("text");
    }
  });

  test("system and instructions become one leading system turn", () => {
    const body = buildTraeChatBody(
      "gpt-5.5",
      request({
        system: [{ kind: "text", text: "A" }],
        instructions: [{ kind: "text", text: "B" }],
        messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
      }),
      "intl",
    );
    expect(body.messages[0]?.role).toBe("system");
    expect(body.messages[0]?.content[0]).toEqual({ type: "text", text: "A\n\nB" });
  });

  test("a tool result becomes its own tool turn", () => {
    const body = buildTraeChatBody(
      "gpt-5.5",
      request({
        messages: [
          {
            role: "tool",
            content: [
              { kind: "toolResult", call_id: "c1", content: [{ kind: "text", text: "42" }] },
            ],
          },
        ],
      }),
      "intl",
    );
    expect(body.messages[0]?.role).toBe("tool");
    expect(body.messages[0]?.tool_call_id).toBe("c1");
  });

  test("a tool call is emitted as tool_calls with stringified arguments", () => {
    const body = buildTraeChatBody(
      "gpt-5.5",
      request({
        messages: [
          {
            role: "assistant",
            content: [{ kind: "toolCall", call_id: "c1", name: "f", arguments: { a: 1 } }],
          },
        ],
      }),
      "intl",
    );
    const call = body.messages[0]?.tool_calls?.[0];
    expect(call?.id).toBe("c1");
    expect(call?.function.name).toBe("f");
    expect(call?.function.arguments).toBe('{"a":1}');
  });

  test("only declared generation fields are forwarded", () => {
    const body = buildTraeChatBody(
      "gpt-5.5",
      request({ generation_controls: { temperature: 0.2, max_tokens: 16 } }),
      "intl",
    );
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(16);
    expect(body.top_p).toBeUndefined();
  });

  test("an empty model name is refused", () => {
    expect(() => buildTraeChatBody("", request(), "intl")).toThrow();
  });
});

describe("parseTraeSse", () => {
  function stream(raw: string): ReadableStream<Uint8Array> {
    const bytes = new TextEncoder().encode(raw);
    return new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  test("data frames are parsed as JSON", async () => {
    const frames = [];
    for await (const f of parseTraeSse(stream('data: {"chunk":{"content":"hi"}}\n\n'))) frames.push(f);
    expect(frames.length).toBe(1);
    expect((frames[0]?.data as { chunk: { content: string } }).chunk.content).toBe("hi");
  });

  test("[DONE] becomes a done frame", async () => {
    const frames = [];
    for await (const f of parseTraeSse(stream("data: [DONE]\n\n"))) frames.push(f);
    expect(frames[0]?.event).toBe("done");
  });

  test("comment lines are heartbeats and are skipped", async () => {
    const frames = [];
    for await (const f of parseTraeSse(stream(': ping\ndata: {"a":1}\n\n'))) frames.push(f);
    expect(frames.length).toBe(1);
    expect(frames[0]?.event).toBe("message");
  });

  test("named events keep their name", async () => {
    const frames = [];
    for await (const f of parseTraeSse(stream('event: error\ndata: {"message":"bad"}\n\n'))) frames.push(f);
    expect(frames[0]?.event).toBe("error");
  });

  test("a frame split across chunks still parses", async () => {
    const bytes = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.encode('data: {"chunk"'));
        controller.enqueue(bytes.encode(':{"content":"x"}}\n\n'));
        controller.close();
      },
    });
    const frames = [];
    for await (const f of parseTraeSse(body)) frames.push(f);
    expect(frames.length).toBe(1);
    expect((frames[0]?.data as { chunk: { content: string } }).chunk.content).toBe("x");
  });
});
