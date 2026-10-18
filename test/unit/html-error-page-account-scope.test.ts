/**
 * An HTML error page from an upstream edge must cool down the account that was
 * dialled.
 *
 * A WAF/edge challenge answers the *request* one specific account sent: eight
 * `cb` accounts shared one egress address and seven of them served the same
 * model fine while one was challenged on 16 of 16 requests. So the block is
 * about the account, and the fix is to rotate off that account — not to change
 * egress, and not to disable the credential.
 *
 * The failure used to classify provider-scoped, and the 5xx branch hard-coded
 * `mutatesAccount: false` on top of that, so `recordAccountFailure` returned
 * before touching the failure streak: the account stayed `active` with
 * `consecutiveFailures: 0` and `cooldownUntil: null` through every failure, and
 * the planner kept re-selecting it (sortIndex 17) for as long as the block
 * lasted. `throwIfHtmlResponse` now marks the account, and the 5xx branch
 * honours that scope instead of overriding it.
 */
import { describe, expect, test } from "bun:test";
import { GatewayError } from "../../src/protocol/gateway-error";
import { classifyAccountError } from "../../src/providers/operations/account-health-service";
import { classifyUpstreamFailure } from "../../src/transport/failure-policy";

/** Exactly the error `throwIfHtmlResponse` raises for a WAF challenge page. */
function wafBlockPage(): GatewayError {
  return new GatewayError(
    "transport_unavailable",
    502,
    "Upstream returned an HTML error page: WAF Block Page",
    { upstreamStatus: 403, contentType: "text/html", accountScope: true },
    "upstream",
  );
}

/** A 502 with no account evidence: the upstream is failing indiscriminately. */
function plainUpstream502(): GatewayError {
  return new GatewayError("transport_unavailable", 502, "upstream boom", {}, "upstream");
}

/** Classifies the way `completeAttempt` does: scope comes from the failure policy. */
function classifyViaDispatch(error: GatewayError) {
  const policy = classifyUpstreamFailure(error);
  return classifyAccountError(error, {
    origin: policy.origin,
    ...(policy.scope ? { scope: policy.scope } : {}),
    ...(policy.statusCode === undefined ? {} : { statusCode: policy.statusCode }),
    ...(policy.credentialEvidence ? { credentialEvidence: true } : {}),
  });
}

describe("HTML error page account scope", () => {
  test("a WAF challenge page scopes to the account", () => {
    expect(classifyUpstreamFailure(wafBlockPage()).scope).toBe("account");
  });

  test("a WAF challenge page mutates the account", () => {
    // The whole point: without this the account is never cooled down and is
    // re-dialled once a minute for the duration of the block.
    const classification = classifyViaDispatch(wafBlockPage());
    expect(classification.mutatesAccount).toBe(true);
  });

  test("it cools down rather than disabling, and names a deadline", () => {
    // An edge challenge is neither a revoked credential nor permanent: it gets
    // a recoverable cooldown with a real `cooldownUntil` so the sweep can bring
    // the account back.
    const classification = classifyViaDispatch(wafBlockPage());
    expect(classification.status).toBe("cooldown");
    expect(classification.cooldownMs).toBeGreaterThan(0);
    expect(classification.retryAt).toBeInstanceOf(Date);
  });

  test("it does not claim credential evidence", () => {
    // `credentialEvidence` also drives forced OAuth refresh and terminal
    // disable, neither of which applies to an edge challenge.
    expect(wafBlockPage().details.credentialEvidence).toBeUndefined();
    expect(wafBlockPage().details.accountScope).toBe(true);
  });

  test("a provider-scoped 502 still leaves the account alone", () => {
    // The unchanged case: when no single account is at fault, none is parked.
    const policy = classifyUpstreamFailure(plainUpstream502());
    expect(policy.scope).toBe("provider");
    expect(classifyViaDispatch(plainUpstream502()).mutatesAccount).toBe(false);
  });
});
