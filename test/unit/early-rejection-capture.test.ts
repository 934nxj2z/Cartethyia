import { describe, expect, test } from "bun:test";
import { captureEarlyRejectionPayload, type EarlyRejectionCapture } from "../../src/transport/guards/early-rejection-capture";

/** Records what a capture received, so no database is involved. */
function recorder(): { captured: EarlyRejectionCapture[]; capture: (input: EarlyRejectionCapture) => Promise<unknown> } {
  const captured: EarlyRejectionCapture[] = [];
  return {
    captured,
    capture: async (input: EarlyRejectionCapture) => {
      captured.push(input);
      return { id: "frame", expiresAt: new Date() };
    },
  };
}

describe("early rejection payload capture", () => {
  test("records the ingress body and the error the client saw", async () => {
    const rec = recorder();
    await captureEarlyRejectionPayload(
      {
        requestId: "req-1",
        ingressBody: { model: "bansos/x", messages: [] },
        clientResponseText: JSON.stringify({ error: { code: "invalid_request" } }),
        payloadCapture: { capture: rec.capture },
      },
      { tenantId: "tenant-1" },
    );
    expect(rec.captured).toHaveLength(1);
    expect(rec.captured[0]?.requestId).toBe("req-1");
    expect(rec.captured[0]?.requestBody).toEqual({ model: "bansos/x", messages: [] });
    expect(rec.captured[0]?.clientResponseBody).toContain("invalid_request");
  });

  test("does nothing when there is no capture to write through", async () => {
    const rec = recorder();
    await captureEarlyRejectionPayload(
      { requestId: "req-2", ingressBody: { model: "x" } },
      { tenantId: "tenant-1" },
    );
    expect(rec.captured).toHaveLength(0);
  });

  test("does nothing when the body was never read", async () => {
    const rec = recorder();
    await captureEarlyRejectionPayload(
      { requestId: "req-3", payloadCapture: { capture: rec.capture } },
      { tenantId: "tenant-1" },
    );
    expect(rec.captured).toHaveLength(0);
  });

  test("a capture failure never throws", async () => {
    // The response is already on the wire; a storage fault must not change it.
    await expect(
      captureEarlyRejectionPayload(
        {
          requestId: "req-4",
          ingressBody: { model: "x" },
          payloadCapture: { capture: async () => { throw new Error("db down"); } },
        },
        { tenantId: "tenant-1" },
      ),
    ).resolves.toBeUndefined();
  });
});
