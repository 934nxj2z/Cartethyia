/**
 * Payload capture for a request rejected before it ever reached routing.
 *
 * An early rejection — ingress, auth, parse, or the preparer — never calls
 * `completeAttempt`, and that was the only place a payload frame was written.
 * The result was a request row whose four capture panels were all empty, for
 * exactly the case an operator most wants to read: what did the client
 * actually send, and what did we answer?
 *
 * There is no provider exchange to capture here because no provider was
 * reached, so the frame carries what the case has: the ingress body and the
 * error envelope the client received.
 */
import type { PayloadCaptureState } from "../../observability/payload-capture";
/** The capture surface this helper needs; matches the real capture's method. */
export interface EarlyRejectionCaptureSink {
  capture(input: EarlyRejectionCapture): Promise<unknown>;
}

/** One early-rejection payload frame. */
export interface EarlyRejectionCapture {
  readonly tenantId: string;
  readonly requestBody: unknown;
  readonly responseBody: unknown;
  readonly clientResponseBody?: unknown;
  readonly scope: "tenant";
  readonly tenantOptIn: boolean;
  readonly requestId?: string;
}

/** The state this helper reads; a subset of `ProxyRequestState`. */
export interface EarlyRejectionState {
  readonly requestId: string;
  readonly ingressBody?: unknown;
  readonly clientResponseText?: string;
  readonly payloadCapture?: EarlyRejectionCaptureSink;
  /**
   * Written by this helper so telemetry can record whether the rejection's body
   * was captured. Mutable because the reason is an outcome, not an input.
   */
  payloadCaptureState?: PayloadCaptureState;
}

/**
 * Records the ingress body and client error for a rejected request.
 *
 * Fire-and-forget by contract: the response is already on the wire when this
 * runs, so a storage fault must never change the status the client was given.
 * Swallowing the rejection is the point, not an oversight.
 */
export async function captureEarlyRejectionPayload(
  state: EarlyRejectionState,
  authorization: { readonly tenantId: string },
): Promise<void> {
  const capture = state.payloadCapture;
  if (capture === undefined) return;
  if (state.ingressBody === undefined) return;
  try {
    await capture.capture({
      tenantId: authorization.tenantId,
      requestBody: state.ingressBody,
      // No provider exchange: the request never reached one.
      responseBody: null,
      ...(state.clientResponseText === undefined ? {} : { clientResponseBody: state.clientResponseText }),
      scope: "tenant",
      tenantOptIn: true,
      requestId: state.requestId,
    });
    state.payloadCaptureState = "captured";
  } catch {
    // A capture failure is not a request failure; the telemetry row stands.
    state.payloadCaptureState = "failed_write";
  }
}
