/**
 * Upstream response header sanitization.
 *
 * The dangerous direction is under-stripping: one leaked `set-cookie` or
 * `authorization` hands gateway state to a caller, and a hop-by-hop field
 * forwarded to a client that honours it corrupts the connection. Both are
 * silent — the response still looks fine — so nothing else catches them.
 */
import { describe, expect, test } from "bun:test";
import {
  stripResponseHeaders,
  STRIPPED_RESPONSE_HEADERS,
} from "../../src/network/response-headers";

describe("stripResponseHeaders", () => {
  test("drops credential-bearing headers", () => {
    const headers = stripResponseHeaders({
      "set-cookie": "session=abc",
      authorization: "Bearer secret",
      cookie: "a=b",
      "www-authenticate": "Basic",
      "proxy-authenticate": "Basic",
      "proxy-authorization": "Basic x",
    });
    for (const name of [
      "set-cookie",
      "authorization",
      "cookie",
      "www-authenticate",
      "proxy-authenticate",
      "proxy-authorization",
    ]) {
      expect(headers.get(name)).toBeNull();
    }
  });

  test("drops hop-by-hop headers", () => {
    const headers = stripResponseHeaders({
      connection: "keep-alive",
      "keep-alive": "timeout=5",
      "proxy-connection": "close",
      "transfer-encoding": "chunked",
      te: "trailers",
      trailer: "x",
      upgrade: "h2c",
    });
    expect(Object.fromEntries(headers as unknown as Iterable<[string, string]>)).toEqual({});
  });

  test("keeps content-bearing headers", () => {
    const headers = stripResponseHeaders({
      "content-type": "application/json",
      "content-length": "42",
      location: "https://example.test/next",
      "x-request-id": "abc",
    });
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("content-length")).toBe("42");
    expect(headers.get("location")).toBe("https://example.test/next");
    expect(headers.get("x-request-id")).toBe("abc");
  });

  test("strips case-insensitively", () => {
    // Upstream casing is not under our control; a `Set-Cookie` that survives
    // because it was capitalised is still a leak.
    const headers = stripResponseHeaders({ "Set-Cookie": "a=b", "PROXY-Authorization": "x" });
    expect(headers.get("set-cookie")).toBeNull();
    expect(headers.get("proxy-authorization")).toBeNull();
  });

  test("joins repeated header values", () => {
    const headers = stripResponseHeaders({ "x-via": ["a", "b"] });
    expect(headers.get("x-via")).toBe("a, b");
  });

  test("skips undefined values and HTTP/2 pseudo-headers", () => {
    const headers = stripResponseHeaders({
      ":status": "200",
      "x-present": "yes",
      "x-empty": undefined,
    });
    // `Headers.get` rejects a pseudo-header name outright, so the assertion is
    // on the key list: dropping it before construction is the behaviour.
    expect(Object.fromEntries(headers as unknown as Iterable<[string, string]>)).toEqual({ "x-present": "yes" });
  });

  test("the stripped set is lowercase throughout", () => {
    // A single capitalised entry would silently disable that rule.
    for (const name of STRIPPED_RESPONSE_HEADERS) {
      expect(name).toBe(name.toLowerCase());
    }
  });
});
