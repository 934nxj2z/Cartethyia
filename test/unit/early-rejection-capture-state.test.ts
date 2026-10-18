/**
 * Why a request's drawer payloads are empty is recorded, not inferred.
 *
 * The four panels read blank whether capture is switched off, the tenant is
 * missing, the attempt was not the terminal one, the preference read failed, or
 * the write failed. An operator debugging remotely — with no access to the
 * server's logs — could not tell those apart, so every exit now names itself.
 *
 * These pin the early-rejection path, which is the one case an operator most
 * wants to read: the client sent something we rejected, and the drawer is the
 * only place to see what.
 */
import { describe, expect, test } from "bun:test";
import {
  captureEarlyRejectionPayload,
  type EarlyRejectionCaptureSink,
  type EarlyRejectionState,
} from "../../src/transport/guards/early-rejection-capture";

function sink(behavior: () => Promise<unknown>): EarlyRejectionCaptureSink {
  return { capture: behavior };
}

function state(capture: EarlyRejectionCaptureSink): EarlyRejectionState {
  return { requestId: "req-1", ingressBody: { model: "m", messages: [] }, payloadCapture: capture };
}

describe("captureEarlyRejectionPayload records why", () => {
  test("a successful capture is recorded as captured", async () => {
    const s = state(sink(async () => ({ id: "p1" })));
    await captureEarlyRejectionPayload(s, { tenantId: "t1" });
    expect(s.payloadCaptureState).toBe("captured");
  });

  test("a failed write is recorded as failed_write, not silently as empty", async () => {
    // The distinction is the point: "we tried and storage failed" and "we never
    // tried" need different fixes, and both used to render as four blank panels.
    const s = state(
      sink(async () => {
        throw new Error("disk full");
      }),
    );
    await captureEarlyRejectionPayload(s, { tenantId: "t1" });
    expect(s.payloadCaptureState).toBe("failed_write");
  });

  test("no capture surface leaves the state unset rather than claiming one", async () => {
    const s: EarlyRejectionState = { requestId: "req-1", ingressBody: {} };
    await captureEarlyRejectionPayload(s, { tenantId: "t1" });
    expect(s.payloadCaptureState).toBeUndefined();
  });

  test("no ingress body leaves the state unset", async () => {
    const s: EarlyRejectionState = {
      requestId: "req-1",
      payloadCapture: sink(async () => ({ id: "p1" })),
    };
    await captureEarlyRejectionPayload(s, { tenantId: "t1" });
    expect(s.payloadCaptureState).toBeUndefined();
  });
});
