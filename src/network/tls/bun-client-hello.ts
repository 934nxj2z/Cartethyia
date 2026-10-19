import type { Socket } from "node:net";
import { connect as tlsConnect, type ConnectionOptions } from "node:tls";

/**
 * A TLS ClientHello that matches Bun's fetch, for the paths that cannot use
 * Bun's own `fetch`.
 *
 * `opencode2api` impersonates OpenCode by impersonating **Bun** — the official
 * clients are Bun programs, and the free-tier gate fingerprints the TLS
 * ClientHello, not just headers. It needed `utls` to do that, because Go's
 * `crypto/tls` cannot change its hello. We are on Bun, so `fetch()` already
 * emits the right one — but our outbound path is `node:https`, which emits
 * OpenSSL's.
 *
 * This module narrows the gap on the Node path. **It does not close it**, and
 * the shortfall is stated plainly below because it decides whether this is
 * worth using at all.
 *
 * What it matches, measured:
 *
 * | Field | Bun | This module |
 * |---|---|---|
 * | Cipher count | 17 | **17** |
 * | Cipher order | `1301-1302-1303-c02b-c02f-c02c-c030-cca9-cca8-c009-c013-c00a-c014-009c-009d-002f-0035` | **identical** |
 * | Curves | `4588,29,23,24` | **`4588,29,23,24`** |
 * | ALPN | `http/1.1` only | **`http/1.1` only** |
 * | TLS span | 1.2–1.3 | **1.2–1.3** |
 * | Extensions | 13, order `0,23,65281,10,11,35,16,5,13,18,51,45,43` | **11, `0,23,65281,10,11,35,16,13,51,45,43`** |
 *
 * The extension list is the part Node cannot reach. The first seven match
 * exactly, then it diverges: `status_request` (5, OCSP stapling) and
 * `signed_certificate_timestamp` (18, SCT) are absent, and BoringSSL sends
 * both between ALPN and `signature_algorithms`. Neither has a Node option.
 * No extension we send is foreign to Bun's — we send a subset, not a
 * different set.
 *
 * **So this is a closer hello, not an identical one.** If the gate's check is
 * JA3/JA4-shaped — and the reference gateway's own comment names JA4
 * `t13d1713h1`, which is computed from the extension list — this will not pass
 * it. Use `fetch` through a CONNECT bridge (`outbound-fetch.ts`) where an exact
 * match is required; that path measures identical, all 13 extensions in order.
 *
 * Kept because it is still strictly better than the OpenSSL default (52 ciphers
 * in OpenSSL's order) for any check that reads ciphers or curves without hashing
 * the whole extension list, and because it costs one function call.
 */

/**
 * Bun's cipher list, in wire order.
 *
 * OpenSSL names, because that is what Node accepts — the `TLS_*` spellings
 * resolve to only 3 suites here (the rest are unavailable to OpenSSL), which is
 * why an earlier attempt at this produced a 3-cipher hello that was *further*
 * from Bun than doing nothing.
 */
export const BUN_CIPHER_SUITES =
  "TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:" +
  "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:" +
  "ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:" +
  "ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:" +
  "ECDHE-ECDSA-AES128-SHA:ECDHE-RSA-AES128-SHA:" +
  "ECDHE-ECDSA-AES256-SHA:ECDHE-RSA-AES256-SHA:" +
  "AES128-GCM-SHA256:AES256-GCM-SHA384:AES128-SHA:AES256-SHA";

/**
 * Bun's supported groups, in order: the post-quantum hybrid first, then
 * X25519, P-256, P-384 — and nothing else. Measured identical to Bun.
 */
export const BUN_SUPPORTED_GROUPS = "X25519MLKEM768:X25519:P-256:P-384";

/**
 * Options that make a Node TLS connection handshake with Bun's cipher list,
 * curve list, ALPN and version span.
 *
 * Spread into `tls.connect` or `https.request`. Does not touch the extension
 * list, which Node does not expose.
 */
export function bunClientHelloOptions(): Pick<
  ConnectionOptions,
  "ciphers" | "ecdhCurve" | "ALPNProtocols" | "minVersion" | "maxVersion"
> {
  return {
    ciphers: BUN_CIPHER_SUITES,
    ecdhCurve: BUN_SUPPORTED_GROUPS,
    // One protocol, like Bun. Offering `h2` here would change the ALPN
    // extension and the negotiated protocol.
    ALPNProtocols: ["http/1.1"],
    minVersion: "TLSv1.2",
    maxVersion: "TLSv1.3",
  };
}

/**
 * Upgrades an already-connected socket to TLS with Bun's parameters.
 *
 * The socket is the point: it lets a SOCKS5 `SocksProxyAgent` own the dial
 * (keeping its SSRF `lookup`) while this controls the hello. Bun's `fetch`
 * cannot do that combination — it refuses SOCKS5 outright.
 */
export function bunTlsOverSocket(
  socket: Socket,
  servername: string,
  extra: Omit<ConnectionOptions, "socket" | "servername"> = {},
) {
  return tlsConnect({
    socket,
    servername,
    rejectUnauthorized: true,
    ...bunClientHelloOptions(),
    ...extra,
  });
}
