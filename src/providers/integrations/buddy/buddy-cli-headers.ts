/**
 * The header family only the CLI identity sends.
 *
 * Everything here comes from the two reference gateways, which agree: the
 * desktop product sends conversation/tracing headers and browser transport,
 * while the CLI sends the agent envelope plus the OpenAI Node SDK fingerprint
 * and no browser headers at all. A request carrying both halves is a hybrid no
 * real client produces, which is what risk control keys on.
 *
 * Two references, two fingerprints: the hub derives OS/arch and a Node version
 * from its own host, and codebuddy2api pins a fixed Linux/x64/v24.21.0 set.
 * Neither can be right for every deployment, so the values here follow the
 * host this gateway actually runs on — they are a fingerprint of the process,
 * not a claim about a remote machine.
 */

/** OpenAI Node SDK 6.25.0 `x-stainless-*` fingerprint; both references agree. */
const STAINLESS_PACKAGE_VERSION = "6.25.0";

function hostOs(): string {
  return process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "MacOS" : "Linux";
}

function hostArch(): string {
  return process.arch === "arm64" || process.arch === "ia32" ? process.arch : "x64";
}

/**
 * The SDK fingerprint headers.
 *
 * `x-stainless-timeout` is in the hub only and `x-stainless-retry-count` is in
 * both; the SDK sends both, so both go out.
 */
export function buddyStainlessHeaders(): Record<string, string> {
  return {
    "x-stainless-lang": "js",
    "x-stainless-package-version": STAINLESS_PACKAGE_VERSION,
    "x-stainless-os": hostOs(),
    "x-stainless-arch": hostArch(),
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": process.version,
    "x-stainless-retry-count": "0",
    "x-stainless-timeout": "1200",
  };
}

/**
 * The trace family the CLI carries as a child span.
 *
 * The desktop product omits the parent (`with_parent=False` in the reference);
 * the CLI conversation request is a child span, so it also sends `b3`'s fourth
 * field and `X-B3-ParentSpanId`. `buddyConversationHeaders` already produces
 * `traceparent`, `b3`, and the `X-B3-*` set, so only the parent is added here.
 */
export function buddyCliTraceHeaders(
  conversation: Readonly<Record<string, string>>,
): Record<string, string> {
  const traceId = conversation["x-trace-id"] ?? conversation["x-b3-traceid"];
  const spanId = conversation["x-b3-spanid"];
  if (traceId === undefined) return {};
  const b3 = `${traceId}-${spanId ?? traceId.slice(0, 16)}-1-${traceId.slice(0, 16)}`;
  return { ...(spanId === undefined ? {} : { "X-B3-ParentSpanId": spanId }), b3 };
}

/**
 * The full CLI identity envelope, minus what each caller already supplies.
 *
 * The caller keeps ownership of `User-Agent`, `X-IDE-*`, `X-Domain`, and the
 * conversation family, because those vary by provider and realm: only the
 * headers that are the same for every CLI dispatch are built here.
 */
export function buddyCliHeaders(args: { readonly userId: string }): Record<string, string> {
  return {
    "X-Agent-Intent": "craft",
    "X-Agent-Type": "main",
    // The reference enum is local-agent / cloud-agent / agent-agent, and its
    // parser returns "other" for anything unknown or absent. A gateway is none
    // of the three, so "other" is the honest value rather than a guess.
    "X-Agent-Runtime": "other",
    "X-User-Id": args.userId,
    // Personal accounts are not an enterprise and the reference sends the flag
    // either way (`true` only for an enterprise id), so the non-enterprise
    // default goes out here. Step 3 replaces this with the account's real
    // enterprise id once discovery carries one.
    "X-Private-Data": "false",
    ...buddyStainlessHeaders(),
  };
}
