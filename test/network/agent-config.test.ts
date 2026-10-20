/**
 * Pool agent config parsing.
 *
 * `parseAgentConfig` is the trust boundary between the DB/console and the agent
 * resolver. A row that decodes to a wrong number produces a silently mis-tuned
 * agent — a pool that holds too few sockets, or one that never releases them —
 * with no error anywhere. Accepting what should be rejected is the dangerous
 * direction, so the rejection cases matter more than the happy path.
 */
import { describe, expect, test } from "bun:test";
import { parseAgentConfig, ProxyConfigError } from "../../src/network/types";

describe("parseAgentConfig", () => {
  test("an empty or non-object config is an empty tuning", () => {
    expect(parseAgentConfig(undefined)).toEqual({});
    expect(parseAgentConfig(null)).toEqual({});
    expect(parseAgentConfig("nope")).toEqual({});
    expect(parseAgentConfig([])).toEqual({});
    expect(parseAgentConfig({})).toEqual({});
  });

  test("accepts integer values", () => {
    expect(
      parseAgentConfig({ maxSockets: 50, maxFreeSockets: 10, keepAliveTimeout: 60_000 }),
    ).toEqual({ maxSockets: 50, maxFreeSockets: 10, keepAliveTimeout: 60_000 });
  });

  test("coerces numeric strings", () => {
    // The console posts form-ish JSON; a string "50" is a real row shape.
    expect(parseAgentConfig({ maxSockets: "50" })).toEqual({ maxSockets: 50 });
  });

  test("rejects non-integers", () => {
    expect(() => parseAgentConfig({ maxSockets: 1.5 })).toThrow(ProxyConfigError);
    expect(() => parseAgentConfig({ maxSockets: "abc" })).toThrow(ProxyConfigError);
    expect(() => parseAgentConfig({ maxSockets: true })).toThrow(ProxyConfigError);
  });

  test("rejects out-of-range values", () => {
    expect(() => parseAgentConfig({ maxSockets: 0 })).toThrow(ProxyConfigError);
    expect(() => parseAgentConfig({ maxSockets: 100_001 })).toThrow(ProxyConfigError);
    expect(() => parseAgentConfig({ keepAliveTimeout: -1 })).toThrow(ProxyConfigError);
  });

  test("maxFreeSockets may be zero but not negative", () => {
    // Zero free sockets is a legitimate "do not pool" setting.
    expect(parseAgentConfig({ maxFreeSockets: 0 })).toEqual({ maxFreeSockets: 0 });
    expect(() => parseAgentConfig({ maxFreeSockets: -1 })).toThrow(ProxyConfigError);
  });

  test("omits absent fields rather than filling defaults", () => {
    // A default injected here would override the resolver's own defaults.
    const parsed = parseAgentConfig({ maxSockets: 5 });
    expect(Object.keys(parsed)).toEqual(["maxSockets"]);
  });

  test("the error names the offending field", () => {
    try {
      parseAgentConfig({ keepAliveTimeout: -5 });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as Error).message).toContain("keepAliveTimeout");
    }
  });
});
