import { describe, expect, test } from "bun:test";
import {
  BUN_CIPHER_SUITES,
  BUN_SUPPORTED_GROUPS,
  bunClientHelloOptions,
} from "../../src/network/tls/bun-client-hello";

/**
 * What the Node-side Bun hello actually achieves, pinned.
 *
 * The point of these tests is the **boundary**: ciphers and curves match Bun
 * exactly, the extension list does not and cannot. That distinction decides
 * whether this module is usable, so it must never be allowed to drift into a
 * claim of a full match.
 */


/** Bun's groups, in order: the PQ hybrid first, nothing else. */
const BUN_GROUP_IDS = ["X25519MLKEM768", "X25519", "P-256", "P-384"];

describe("the Bun cipher list", () => {
  test("names all 17 suites", () => {
    const names = BUN_CIPHER_SUITES.split(":").filter((v) => v !== "");
    expect(names.length).toBe(17);
  });

  test("uses the TLS_* spelling only where OpenSSL has no other name", () => {
    // The three TLS 1.3 suites exist *only* as `TLS_*` — OpenSSL has no
    // `ECDHE-` spelling for them, and they resolve fine. The trap is using
    // `TLS_*` for the 1.2 suites, where OpenSSL silently drops all but three
    // of them; that is what made an earlier attempt produce a 3-cipher hello
    // further from Bun than the default.
    const names = BUN_CIPHER_SUITES.split(":");
    expect(names.filter((n) => n.startsWith("TLS_"))).toEqual([
      "TLS_AES_128_GCM_SHA256",
      "TLS_AES_256_GCM_SHA384",
      "TLS_CHACHA20_POLY1305_SHA256",
    ]);
    // Every 1.2 suite is spelled the OpenSSL way instead.
    expect(names.filter((n) => n.startsWith("ECDHE-")).length).toBe(10);
    expect(names.filter((n) => n.startsWith("AES")).length).toBe(4);
  });

  test("keeps the two shape markers a reader would recognise", () => {
    const names = BUN_CIPHER_SUITES.split(":");
    // ECDSA before RSA for CHACHA20, and the CBC/RSA tail — the BoringSSL
    // shape the reference named as distinctive.
    expect(names.indexOf("ECDHE-ECDSA-CHACHA20-POLY1305")).toBeLessThan(
      names.indexOf("ECDHE-RSA-CHACHA20-POLY1305"),
    );
    expect(names).toContain("AES256-SHA");
  });
});

describe("the Bun group list", () => {
  test("offers the PQ hybrid first, and nothing beyond Bun's four", () => {
    const groups = BUN_SUPPORTED_GROUPS.split(":");
    expect(groups).toEqual(BUN_GROUP_IDS);
  });
});

describe("the options a Node TLS call receives", () => {
  test("pins ciphers, curves, ALPN and the version span — and nothing else", () => {
    const options = bunClientHelloOptions();
    expect(options.ciphers).toBe(BUN_CIPHER_SUITES);
    expect(options.ecdhCurve).toBe(BUN_SUPPORTED_GROUPS);
    // One protocol. Offering h2 would change both the ALPN extension and the
    // negotiated protocol, and Bun offers only http/1.1.
    expect(options.ALPNProtocols).toEqual(["http/1.1"]);
    expect(options.minVersion).toBe("TLSv1.2");
    expect(options.maxVersion).toBe("TLSv1.3");
    // Deliberately narrow: no `sigalgs`, no `sessionTimeout`. Neither moves
    // the extension list, and pretending otherwise would be a false claim.
    expect(Object.keys(options).sort()).toEqual([
      "ALPNProtocols",
      "ciphers",
      "ecdhCurve",
      "maxVersion",
      "minVersion",
    ]);
  });
});

describe("what this does NOT achieve", () => {
  test("the extension list cannot be matched from Node", () => {
    // Recorded so the gap is never quietly forgotten. Measured:
    //   Bun  -> 13 extensions, 0,23,65281,10,11,35,16,5,13,18,51,45,43
    //   Node -> 11 extensions, 0,23,65281,10,11,35,16,13,51,45,43
    // The first seven match, then `status_request` (5) and
    // `signed_certificate_timestamp` (18) are missing and there is no Node
    // option that adds them.
    const bun = [0, 23, 65281, 10, 11, 35, 16, 5, 13, 18, 51, 45, 43];
    const node = [0, 23, 65281, 10, 11, 35, 16, 13, 51, 45, 43];
    expect(node.length).toBeLessThan(bun.length);
    expect(bun.filter((t) => !node.includes(t))).toEqual([5, 18]);
    // A subset, not a different set — nothing foreign is sent.
    expect(node.filter((t) => !bun.includes(t))).toEqual([]);
    // JA4 is computed from the extension list, so a JA4 check still fails.
    expect(bunClientHelloOptions()).not.toHaveProperty("sigalgs");
  });
});
