/**
 * Copilot streams tool arguments that are not strict JSON. The client parses
 * the assembled string and, on failure, reports the call as `Tool <name> not
 * found` with the parser's own message. The repair makes the string parse
 * before it leaves the gateway.
 */
import { describe, expect, test } from "bun:test";
import { repairToolArguments } from "../../src/transport/surface/chat/encode";

describe("chat tool argument repair", () => {
  test("escapes a raw newline inside a string", () => {
    const raw = '{"command":"echo hello\nworld"}';
    const repaired = repairToolArguments(raw);
    expect(JSON.parse(repaired)).toEqual({ command: "echo hello\nworld" });
  });

  test("drops a trailing comma", () => {
    const repaired = repairToolArguments('{"path":"a.ts",}');
    expect(JSON.parse(repaired)).toEqual({ path: "a.ts" });
  });

  test("leaves valid JSON untouched", () => {
    const raw = '{"count":3,"ok":true}';
    expect(repairToolArguments(raw)).toBe(raw);
  });

  test("returns an empty call as an object", () => {
    expect(repairToolArguments("")).toBe("{}");
  });

  test("returns unrepairable text unchanged", () => {
    const raw = "not json at all";
    expect(repairToolArguments(raw)).toBe(raw);
  });
});
