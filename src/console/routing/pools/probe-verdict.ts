/**
 * What one provider-probe answer means about the egress.
 *
 * Extracted from the store so the console, the CLI probe
 * (`scripts/operations/probe-egress.ts`) and the tests cannot drift into three
 * readings of the same response. The rule that matters is not obvious:
 *
 * **The provider's IP gate runs before it validates the body.** So a `4xx`
 * complaint about the payload proves the address was accepted — it is the
 * probe's request that is wrong, not the proxy. Mapping that to `unreachable`
 * ("the probe could not complete") blamed the proxy for our own defect and hid
 * working egresses behind a verdict that said the pool was unusable.
 *
 * Only the free-tier refusal retires an address. Every other answer either says
 * the address works (`allowed`, `throttled`) or says nothing about it
 * (`unreachable`), and treating "says nothing" as "refused" would drop a usable
 * pool for good.
 */

export type ProbeVerdict = "allowed" | "blocked" | "throttled" | "unreachable";

export interface ProbeAnswer {
  readonly status: ProbeVerdict;
  /** Operator-facing reason; absent when the answer needs none. */
  readonly reason?: string;
}

/** The upstream's own wording for "this address is retired". */
const FREE_TIER_REFUSAL = /freetier|free tier can only be used/i;

/**
 * Classifies one upstream response.
 *
 * `407` is separated from the generic 4xx branch on purpose: it comes from the
 * proxy front door, never from the provider, so it is a credential problem on
 * the tunnel and says nothing about whether the address is refused.
 */
export function classifyProviderProbeAnswer(httpStatus: number, body: string): ProbeAnswer {
  if (httpStatus === 403 && FREE_TIER_REFUSAL.test(body)) {
    return { status: "blocked", reason: "Upstream refused this egress address" };
  }
  if (httpStatus === 407) {
    return { status: "unreachable", reason: "Proxy requires authentication" };
  }
  if (httpStatus === 429) {
    return { status: "throttled", reason: "Address accepted; rate limit spent" };
  }
  if (httpStatus >= 200 && httpStatus < 300) {
    return { status: "allowed" };
  }
  if (httpStatus >= 500) {
    return { status: "unreachable", reason: `Upstream answered ${httpStatus}` };
  }
  // Any other 4xx: the request reached the upstream's own validation, which
  // only happens once the address is accepted.
  return {
    status: "allowed",
    reason: `Reachable; upstream answered ${httpStatus} for the probe body`,
  };
}
