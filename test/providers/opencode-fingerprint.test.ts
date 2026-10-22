import { describe, expect, test } from "bun:test";
import type { ProviderDispatchContext } from "../../src/providers/provider-contracts";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";
import { encodeWireRequest } from "../../src/protocol/registry";
import { OPENCODE_FREE_SPEC } from "../../src/providers/integrations/opencode/provider";
import { canonicalProjectId, generateOpenCodeSessionId } from "../../src/providers/integrations/opencode/fingerprint";

describe("OpenCode request fingerprint", () => {
  test("matches the captured CLI identity and reuses session identity per conversation", async () => {
    const context: ProviderDispatchContext = {
      credential: {
        provider_id: "opencode",
        credential_kind: "none",
      },
      deadline: Date.now() + 1_000,
      abort_signal: new AbortController().signal,
      conversation_affinity: "aff_stable_conversation",
      request_headers: { "x-opencode-project": "stable-project-hash" },
    };
    const buildHeaders = OPENCODE_FREE_SPEC.buildExtraHeaders;
    if (!buildHeaders) throw new Error("OpenCode Free must provide fingerprint headers");

    const first = await buildHeaders(context);
    const second = await buildHeaders(context);

    // "cli" is the identity every source agrees on: the captured 2.x dispatch,
    // the local 2.0.26 CLI captures, and the reference gateway.
    expect(first["x-opencode-client"]).toBe("cli");
    expect(first["x-opencode-session"]).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(second["x-opencode-session"]).toBe(first["x-opencode-session"]);
    expect(first["x-opencode-session-id"]).toBe(first["x-opencode-session"]);
    expect(first["x-session-affinity"]).toBe(first["x-opencode-session"]);
    expect(first["x-session-id"]).toBe(first["x-opencode-session"]);
    // The captured 2.x dispatch carries 40 hex here, not a name. A caller's
    // project identity is hashed into that shape; an already-canonical value is
    // kept as-is.
    expect(first["x-opencode-project"]).toMatch(/^[0-9a-f]{40}$/);
    expect(first["user-agent"]).toMatch(/^opencode\/latest\/\d+\.\d+\.\d+\/cli$/);
    const traceparent = first["traceparent"];
    const b3 = first["b3"];
    if (!traceparent || !b3) throw new Error("OpenCode trace headers must be present");
    expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(b3).toMatch(/^[0-9a-f]{32}-[0-9a-f]{16}-1-[0-9a-f]{16}$/);
    const [, traceId, spanId] = traceparent.split("-");
    expect(b3).toStartWith(`${traceId}-${spanId}-1-`);
    // The request id is NOT sent: the current client dropped it, and an
    // identical dispatch returns 403 with it and 200 without (live 2026-10-14).
    // Asserting its absence is the whole point — a re-add would silently
    // break every free-tier dispatch again.
    expect(first["x-opencode-request"]).toBeUndefined();
    expect(second["x-opencode-request"]).toBeUndefined();
    // The session hex must decode to a plausible inverted-millisecond
    // timestamp: the gate rejects arbitrary hash hex. The production jitter
    // buckets to 6-hour boundaries up to 42h back, so decode and check the
    // decoded instant lands within the last 48 hours.
    const sessionHex = String(first["x-opencode-session"]).slice(4, 16);
    // The hex window carries only the low 48 bits of the inverted value: the
    // raw decode is the timestamp mod 2^36. Snap to the multiple of 2^36
    // nearest to now — the 48h production jitter is far smaller than the
    // ~2.2-year window, so the snap is exact.
    const low36 = Number((0xffffffffffffn - BigInt(`0x${sessionHex}`) - 1n) >> 12n);
    const periodMs = 2 ** 36;
    const snapped = low36 + Math.round((Date.now() - low36) / periodMs) * periodMs;
    expect(Date.now() - snapped).toBeGreaterThan(0);
    expect(Date.now() - snapped).toBeLessThan(49 * 3_600_000);
    expect(traceparent).not.toBe(second["traceparent"]);
  });

  test("uses the captured Chat Completions token-limit field in the wire encoder", async () => {
    const tokenLimitField = OPENCODE_FREE_SPEC.chatTokenLimitField;
    if (!tokenLimitField) throw new Error("OpenCode must configure its Chat token-limit field");
    const request: CanonicalRequest = {
      model: "big-pickle",
      messages: [],
      generation_controls: { max_tokens: 512 },
      stream: true,
      source_surface: "chat",
    };
    const payload = await encodeWireRequest("chat", request, { chatTokenLimitField: tokenLimitField });

    expect(payload["max_completion_tokens"]).toBe(512);
    expect(payload["max_tokens"]).toBeUndefined();
  });

  /**
   * The gate decodes the session's time part back into `(ts_ms << 12 | counter)`
   * and accepts counters 1..63 only. A genuine id therefore always ends in
   * `f[c-f][0-9a-f]`; anything lower is refused with `403 FreeTierError` even
   * when the `ses_` shape is right.
   *
   * The generator used to let the counter grow without bound. Sixty-four
   * dispatches inside one millisecond produced ids the gate refuses — and a
   * burst is exactly what a proxy pool produces, so the pool 403'd on its own
   * headers while the tools, the stream flag, and the bearer were all correct.
   */
  test("no session id falls outside the gate's counter window", () => {
    const ACCEPTED_TIME_PART = /^[0-9a-f]{9}f[c-f][0-9a-f]$/;
    const now = 1_792_242_000_000;
    const ids: string[] = [];
    for (let index = 0; index < 500; index += 1) ids.push(generateOpenCodeSessionId(now));
    for (const id of ids) {
      expect(id.slice(4, 16)).toMatch(ACCEPTED_TIME_PART);
    }
    // Rolling into the next millisecond must not collapse ids together.
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("the counter resets between milliseconds", () => {
    const base = 1_792_242_000_000;
    const first = generateOpenCodeSessionId(base);
    const later = generateOpenCodeSessionId(base + 5);
    expect(first.slice(4, 16)).toMatch(/f[c-f][0-9a-f]$/);
    expect(later.slice(4, 16)).toMatch(/f[c-f][0-9a-f]$/);
    expect(later).not.toBe(first);
  });

  test("the project header is 40 hex, and a canonical value is preserved", () => {
    // The captured 2.x dispatch carries `82b484de...` — 40 hex, not a name.
    // Sending "global" was a guess that passed one probe, not the client's
    // shape, and the gate fingerprints this header beside the session id.
    const canonical = "82b484de3985b491abf573de7d60d7999302b858";
    expect(canonicalProjectId(canonical)).toBe(canonical);
    expect(canonicalProjectId("stable-project-hash")).toMatch(/^[0-9a-f]{40}$/);
    expect(canonicalProjectId(undefined)).toMatch(/^[0-9a-f]{40}$/);
    // Distinct projects must not collide.
    expect(canonicalProjectId("a")).not.toBe(canonicalProjectId("b"));
  });
});
