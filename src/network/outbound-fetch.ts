// Validated fetch: SSRF-guarded outbound fetch with optional pool-agent support.
import { GatewayError } from "../protocol/gateway-error";
import { Agent as HttpAgent, request as httpRequest, type RequestOptions } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { Readable, type Transform } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { resolveAllAddresses, validateResolvedAddresses } from "./ssrf";
import type { SsrfPolicy } from "../config/network";
import { isProxyAgentPair, type ProxyAgentPair } from "./pool/agent";
import { metrics } from "../observability/metrics";
import { trackNetworkCall } from "../observability/performance-metrics";
import { bunClientHelloOptions } from "./tls/bun-client-hello";
import { stripResponseHeaders } from "./response-headers";
// Validated fetch — single egress with ProxyAgent support
export interface ValidatedFetchOptions {
  readonly fetchFn?: typeof fetch;
  readonly policy?: SsrfPolicy;
  readonly maxRedirects?: number;
  readonly resolveFn?: (hostname: string, signal: AbortSignal) => Promise<readonly string[]>;
  readonly agent?: HttpAgent | HttpsAgent | ProxyAgentPair;
  /**
   * Handshake with Bun's cipher list, curve list and ALPN instead of
   * OpenSSL's defaults. Opt-in, and off by default: see
   * `network/tls/bun-client-hello.ts` — ciphers and curves match exactly, but
   * the extension list cannot be shaped from Node, so this is a closer hello
   * rather than an identical one.
   */
  readonly bunClientHello?: boolean;
}
export type ValidatedFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Node validates `agent.protocol` per request, so a pool pair contributes
 * the flavor matching the *target* scheme (redirect hops reselect, since
 * the scheme can change mid-chain).
 */
function agentForTarget(
  agent: HttpAgent | HttpsAgent | ProxyAgentPair | undefined,
  protocol: string,
): HttpAgent | HttpsAgent | undefined {
  if (!agent) return undefined;
  if (isProxyAgentPair(agent)) return protocol === "https:" ? agent.https : agent.http;
  return agent;
}

/**
 * Keep-alive options for the direct (non-pool) egress agents.
 *
 * Matched to `network/pool/agent.ts`, which builds pool agents from
 * `resolveProxyMaxSockets()` / `resolveProxyMaxFreeSockets()` and
 * `PROXY_KEEP_ALIVE_TIMEOUT_MS`. Direct egress has no per-pool config to
 * read, so it uses the documented defaults those resolvers return.
 */
const DIRECT_AGENT_OPTIONS = {
  keepAlive: true,
  maxSockets: 100,
  maxFreeSockets: 20,
  timeout: 60_000,
} as const;

/**
 * An agent whose socket key includes the SSRF-validated address.
 *
 * The direct (non-pool) path pins egress by passing a `lookup` that returns the
 * one validated address, but `Agent#getName` — the keep-alive socket key —
 * hashes only host/port/localAddress/family. Two requests to the same
 * `host:port` that validated to *different* addresses therefore share a pooled
 * socket, and the second one silently egresses to the first one's address:
 * the pin is bypassed without any error surfacing.
 *
 * Including the address in the key makes each validated address its own socket
 * bucket, so a re-resolved address always dials fresh while the *same* address
 * still reuses its socket (keep-alive is preserved, not defeated).
 *
 * This is a real gap, not a theoretical one: with no agent at all the request
 * falls back to the global agent, which has the same key shape *and* is shared
 * with unrelated traffic.
 */
class PinnedAddressAgent extends HttpAgent {
  override getName(options: Record<string, unknown> = {}): string {
    const base = super.getName(options as never);
    const pinned = (options["lookup"] as { pinnedAddress?: string } | undefined)?.pinnedAddress;
    return `${base}:${pinned ?? "-"}`;
  }
}
class PinnedAddressHttpsAgent extends HttpsAgent {
  override getName(options: Record<string, unknown> = {}): string {
    const base = super.getName(options as never);
    const pinned = (options["lookup"] as { pinnedAddress?: string } | undefined)?.pinnedAddress;
    return `${base}:${pinned ?? "-"}`;
  }
}

const DIRECT_HTTP_AGENT = new PinnedAddressAgent(DIRECT_AGENT_OPTIONS);
const DIRECT_HTTPS_AGENT = new PinnedAddressHttpsAgent(DIRECT_AGENT_OPTIONS);

/**
 * Builds the application-relay request used by hosted relay front doors.
 * These endpoints intentionally do not receive CONNECT: they accept the
 * target origin/path in headers and perform the upstream fetch themselves,
 * matching the 21-beta relay contract.
 */
function relayRequest(
  relayEndpoint: URL,
  target: URL,
  init: RequestInit,
): { url: URL; init: RequestInit } {
  const relayUrl = new URL(relayEndpoint.toString());
  const headers = new Headers(init.headers);
  headers.delete("host");
  headers.set("x-relay-target", target.origin);
  headers.set("x-relay-path", `${target.pathname}${target.search}`);
  if (relayUrl.username || relayUrl.password) {
    const credentials = `${decodeURIComponent(relayUrl.username)}:${decodeURIComponent(relayUrl.password)}`;
    headers.set("x-relay-auth", `Basic ${Buffer.from(credentials).toString("base64")}`);
    relayUrl.username = "";
    relayUrl.password = "";
  }
  return { url: relayUrl, init: { ...init, headers } };
}

/**
 * Decompresses an upstream body the way `fetch` would, because this path
 * bypasses `fetch`.
 *
 * `node:http` hands back the raw body and does not decode `content-encoding`,
 * while `fetch`/Undici transparently gunzips. Rebuilding a `Response` around the
 * still-compressed stream therefore told every consumer the body was plain when
 * it was not: `response.text()` returned binary garbage, and a JSON parse on it
 * failed as `platform_unavailable: Claude response is not valid JSON`. That is
 * why only the upstreams that actually compress (`br` for Anthropic) appeared
 * broken while others worked — nothing here requested an encoding, but a server
 * may compress anyway.
 *
 * Returns the stream untouched for `identity`, an unknown encoding, or when no
 * `content-encoding` is present.
 */
function decompressBody(
  body: Readable,
  encoding: string | undefined,
): { stream: Readable; encoding: string | undefined } {
  const normalized = encoding?.trim().toLowerCase();
  if (normalized === undefined || normalized === "" || normalized === "identity") {
    return { stream: body, encoding: undefined };
  }
  const decoder: Transform | undefined =
    normalized === "gzip" || normalized === "x-gzip"
      ? createGunzip()
      : normalized === "deflate"
        ? createInflate()
        : normalized === "br"
          ? createBrotliDecompress()
          : undefined;
  // An encoding we cannot decode (e.g. zstd) is left alone: forwarding the
  // header with the raw body keeps the caller's own decoder in charge, which is
  // strictly better than claiming a plain body we never decoded.
  if (decoder === undefined) return { stream: body, encoding: normalized };
  body.on("error", (error) => decoder.destroy(error));
  return { stream: body.pipe(decoder), encoding: undefined };
}

async function pinnedFetch(
  url: URL,
  init: RequestInit,
  resolvedAddress: string | undefined,
  agent?: HttpAgent | HttpsAgent,
  useBunHello = false,
): Promise<Response> {
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  const headers = new Headers(init.headers);
  // String/Buffer/Uint8Array bodies go direct: routing them through
  // `new Response(body).arrayBuffer()` copied the whole body per request.
  const rawBody = init.body;
  const body =
    rawBody === undefined || rawBody === null
      ? undefined
      : typeof rawBody === "string" || Buffer.isBuffer(rawBody) || rawBody instanceof Uint8Array
        ? rawBody
        : Buffer.from(await new Response(rawBody).arrayBuffer());
  const outboundHeaders: Record<string, string> = {};
  headers.forEach((value, key) => {
    outboundHeaders[key] = value;
  });
  // A known-length JSON/string body must not fall back to chunked encoding.
  // Upstream gateways may wait for the complete chunked stream before routing
  // the request, adding an avoidable RTT compared with global fetch/Undici.
  if (body !== undefined && !headers.has("content-length")) {
    outboundHeaders["content-length"] =
      typeof body === "string" ? String(Buffer.byteLength(body, "utf8")) : String(body.byteLength);
  }
  const lookup = Object.assign(
    (
      _hostname: string,
      options: { all?: boolean; family?: number } | number,
      callback: (
        error: Error | null,
        address?: string | Array<{ address: string; family: number }>,
        family?: number,
      ) => void,
    ): void => {
      if (resolvedAddress === undefined) {
        callback(new Error("no validated address available"));
        return;
      }
      const opts = typeof options === "number" ? { family: options } : options;
      const family = resolvedAddress.includes(":") ? 6 : 4;
      if (opts?.all) {
        callback(null, [{ address: resolvedAddress, family }] as never);
        return;
      }
      callback(null, resolvedAddress, family);
    },
    // Read by `PinnedAddressAgent#getName` so the keep-alive socket key
    // carries the validated address. See the class comment for why.
    { pinnedAddress: resolvedAddress },
  ) as unknown as NonNullable<RequestOptions["lookup"]>;
  // Direct egress gets a dedicated agent as well as the pinning `lookup`.
  // Passing only `lookup` left the request on the global agent, whose socket
  // key ignores `lookup` — so a re-resolved address could reuse a socket
  // dialed against an earlier one and egress past the SSRF check. The direct
  // agent keys its sockets on the pinned address, so the pin holds.
  const directAgent = url.protocol === "https:" ? DIRECT_HTTPS_AGENT : DIRECT_HTTP_AGENT;
  return new Promise<Response>((resolve, reject) => {
    const nodeRequest = request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port ? url.port : url.protocol === "https:" ? "443" : "80",
        path: `${url.pathname}${url.search}`,
        method: init.method ?? "GET",
        headers: outboundHeaders,
        signal: init.signal ?? undefined,
        ...(agent ? { agent } : { agent: directAgent, lookup }),
        ...(url.protocol === "https:" ? { servername: url.hostname } : {}),
        // Bun's cipher list, curve list, ALPN and version span, when this
        // request opted into it. See `network/tls/bun-client-hello.ts` for
        // what this does and does not match: ciphers and curves land exactly;
        // the extension list cannot be shaped from Node at all.
        //
        // Opt-in, and off by default. It changes the TLS handshake of every
        // request it touches, and no provider needs it until the free-tier
        // gate is shown to reject the default hello.
        ...(useBunHello && url.protocol === "https:" ? bunClientHelloOptions() : {}),
      },
      (response) => {
        const responseHeaders = stripResponseHeaders(response.headers);
        const { stream, encoding } = decompressBody(response, response.headers["content-encoding"]);
        if (encoding === undefined) {
          // Body is plain (decoded here, or never compressed): the header must
          // not survive, or the caller would try to decode a decoded body.
          responseHeaders.delete("content-encoding");
        }
        // A compressed body this path cannot decode keeps its header so the
        // caller's decoder still applies.
        const webStream = Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
        resolve(
          new Response(webStream, {
            status: response.statusCode ?? 502,
            headers: responseHeaders,
          }),
        );
      },
    );
    nodeRequest.on("error", reject);
    if (body !== undefined) nodeRequest.write(body);
    nodeRequest.end();
  });
}

const CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization"] as const;

function stripCredentialsOnCrossOrigin(
  headersInit: HeadersInit | undefined,
): Headers {
  const headers = new Headers(headersInit);
  for (const name of CREDENTIAL_HEADERS) headers.delete(name);
  return headers;
}

export function createValidatedFetch(options: ValidatedFetchOptions = {}): ValidatedFetch {
  const policy = options.policy ?? {};
  const maxRedirects = options.maxRedirects ?? policy.maxRedirects ?? 3;
  const resolveFn = options.resolveFn ?? resolveAllAddresses;
  const configuredAgent = options.agent;
  const relayEndpoint = isProxyAgentPair(configuredAgent)
    ? configuredAgent.relayEndpoint
    : undefined;
  return async (input, init = {}) => {
    const startedAt = performance.now();
    let url = input instanceof Request ? new URL(input.url) : new URL(input.toString());
    let requestInit: RequestInit = { ...init, redirect: "manual" };
    if (input instanceof Request && init.headers === undefined) {
      requestInit.headers = new Headers(input.headers);
    }
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      if (url.protocol !== "http:" && url.protocol !== "https:")
        throw new TypeError("unsupported outbound URL protocol");
      const signal = requestInit.signal ?? new AbortController().signal;
      // Every hop — including proxied dials and redirect targets — is resolved
      // and checked against the SSRF policy. When a proxy agent owns the dial,
      // the proxy still resolves its own answer, so the check is advisory there;
      // it deterministically rejects targets whose *advertised* addresses fall
      // in blocked ranges (literal-IP redirects, private-space DNS, relay abuse).
      // For a pool/relay-owned dial, the upstream *target* is resolved by the
      // proxy/relay itself, so local DNS for it is an advisory SSRF check,
      // not a prerequisite for egress. Operator VPNs routinely break the
      // system resolver (tunnel DNS that is unreachable or drops queries);
      const poolDialsTarget = Boolean(configuredAgent || relayEndpoint);
      let resolvedAddress: string | undefined;
      let relayResolvedAddress: string | undefined;
      if (poolDialsTarget) {
        // The egress dials the pool/relay, which resolves the target itself.
        // Counting these lets ops confirm how much traffic depends on
        // proxy-resolved DNS rather than the local system resolver.
        metrics.cartethyia_proxy_dial_proxy_resolved_total.inc();
      }
      try {
        if (!poolDialsTarget) {
          const addresses = await resolveFn(url.hostname, signal);
          validateResolvedAddresses(addresses, policy);
          resolvedAddress = addresses[0];
        }
        if (relayEndpoint) {
          const relayAddresses = await resolveFn(relayEndpoint.hostname, signal);
          validateResolvedAddresses(relayAddresses, policy);
          relayResolvedAddress = relayAddresses[0];
          if (!relayResolvedAddress)
            throw new TypeError(`no validated address for ${relayEndpoint.hostname}`);
        }
      } catch (error) {
        // A pool/relay-owned dial still needs its egress host locally; only
        // the advisory target lookup may degrade.
        if (relayEndpoint && !relayResolvedAddress) throw error;
        if (!poolDialsTarget) throw new TypeError(`no validated address for ${url.hostname}`);
      }
      if (!poolDialsTarget && !resolvedAddress)
        throw new TypeError(`no validated address for ${url.hostname}`);
      let response: Response;
      if (relayEndpoint) {
        const relay = relayRequest(relayEndpoint, url, requestInit);
        response = options.fetchFn
          ? await options.fetchFn(relay.url, relay.init)
          : await pinnedFetch(relay.url, relay.init, relayResolvedAddress!);
      } else if (options.fetchFn) {
        response = await options.fetchFn(url, requestInit);
      } else {
        const agent = agentForTarget(configuredAgent, url.protocol);
        response = await pinnedFetch(
          url,
          requestInit,
          resolvedAddress!,
          agent,
          options.bunClientHello === true,
        );
      }
      if (response.status < 300 || response.status >= 400) {
        trackNetworkCall(url.hostname, performance.now() - startedAt);
        return response;
      }
      const location = response.headers.get("location");
      if (!location) {
        trackNetworkCall(url.hostname, performance.now() - startedAt);
        return response;
      }
      // The redirect response body is never consumed: release its socket
      // before following the next hop instead of leaving it open.
      await response.body?.cancel().catch(() => undefined);
      const nextUrl = new URL(location, url);
      const isCrossOriginRedirect = nextUrl.origin !== url.origin;
      if (isCrossOriginRedirect) {
        requestInit = { ...requestInit, headers: stripCredentialsOnCrossOrigin(requestInit.headers) };
      }
      if (isCrossOriginRedirect && (response.status === 307 || response.status === 308)) {
        const method = (requestInit.method ?? "GET").toUpperCase();
        if (method !== "GET" && method !== "HEAD" && requestInit.body !== undefined) {
          throw new GatewayError("invalid_request", 400, "cross-origin redirect with body blocked");
        }
      }
      url = nextUrl;
      if (response.status === 301 || response.status === 302 || response.status === 303) {
        const method = (requestInit.method ?? "GET").toUpperCase();
        if (method !== "GET" && method !== "HEAD") {
          const { body: _body, ...withoutBody } = requestInit;
          requestInit = { ...withoutBody, method: "GET" };
        }
      }
    }
    throw new Error("outbound redirect limit exceeded");
  };
}
