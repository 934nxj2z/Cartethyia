/**
 * A pasted proxy list, in the shapes resellers actually send.
 *
 * The point of the import is that an operator does not convert the file first,
 * so the parser has to accept the forms that arrive rather than one canonical
 * shape. Two properties matter beyond "it parses":
 *
 * 1. **A row that fails is reported, not dropped.** A list of 200 where 40 were
 *    skipped looks like a successful import and leaves the operator short 40
 *    nodes with no reason.
 * 2. **A password containing a colon survives.** Reseller credentials are often
 *    base64-ish and do contain them; splitting on every colon truncates the
 *    password and produces a node that can never authenticate.
 */
import { describe, expect, test } from "bun:test";
import { parseProxyFile } from "../../src/console/routing/pools/import-parse";

describe("parseProxyFile — one URI per line", () => {
  test("userinfo becomes the credential and the scheme sets the kind", () => {
    const result = parseProxyFile("http://user:pass@1.2.3.4:8080");

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.endpoint).toBe("http://1.2.3.4:8080");
    expect(result.rows[0]?.credential).toBe("user:pass");
    expect(result.rows[0]?.kind).toBe("http");
  });

  test("socks5 maps to the socks5 pool kind", () => {
    const result = parseProxyFile("socks5://8.8.8.8:1080");
    expect(result.rows[0]?.kind).toBe("socks5");
  });

  test("a URI with no userinfo yields no credential", () => {
    const result = parseProxyFile("https://9.9.9.9:3128");
    expect(result.rows[0]?.credential).toBeNull();
  });
});

describe("parseProxyFile — host:port:user:password rows", () => {
  test("a full row carries its credential", () => {
    const result = parseProxyFile("1.2.3.4:8080:alice:s3cr3t");

    expect(result.rows[0]?.endpoint).toBe("http://1.2.3.4:8080");
    expect(result.rows[0]?.credential).toBe("alice:s3cr3t");
  });

  test("a password containing a colon is kept whole", () => {
    // Splitting on every colon truncates this to `a:b`, which produces a node
    // that can never authenticate.
    const result = parseProxyFile("1.2.3.4:8080:alice:a:b:c");
    expect(result.rows[0]?.credential).toBe("alice:a:b:c");
  });

  test("a bare host:port row has no credential", () => {
    const result = parseProxyFile("5.5.5.5:1080");
    expect(result.rows[0]?.endpoint).toBe("http://5.5.5.5:1080");
    expect(result.rows[0]?.credential).toBeNull();
  });
});

describe("parseProxyFile — JSON and structure", () => {
  test("a JSON array keeps the kind each row states", () => {
    const result = parseProxyFile(
      JSON.stringify([
        { kind: "socks5", endpoint: "7.7.7.7:1080", credential: "u:p" },
        { endpoint: "6.6.6.6:3128" },
      ]),
    );

    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]?.kind).toBe("socks5");
    expect(result.rows[1]?.kind).toBe("http");
  });

  test("a JSON row with no endpoint is reported, not silently skipped", () => {
    const result = parseProxyFile(JSON.stringify([{ kind: "http" }]));
    expect(result.rows).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
  });

  test("comments and blank lines are structure, not failures", () => {
    // Listing them as skipped would bury the rows that actually failed.
    const result = parseProxyFile("# a comment\n\n1.1.1.1:80\n");
    expect(result.rows).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
  });

  test("an unparseable line is reported against its own line number", () => {
    const result = parseProxyFile("1.1.1.1:80\nbogus line\n");
    expect(result.rows).toHaveLength(1);
    expect(result.skipped[0]?.line).toBe(2);
  });

  test("an empty file yields nothing and no failures", () => {
    const result = parseProxyFile("   \n  \n");
    expect(result.rows).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });
});
