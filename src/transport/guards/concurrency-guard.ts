/**
 * Process-wide concurrency cap.
 *
 * Per-key and per-tenant caps already exist, and they are the right place for
 * a fair share. They do not bound the process: a hundred keys each inside
 * their own cap still open a hundred upstream calls at once, and the event
 * loop, the database pool, and the upstream all feel that as one burst.
 *
 * This counts requests in flight in this process and refuses past the cap
 * with 503 and a three-second retry hint. It is deliberately not a queue:
 * queueing would hold the connection open and make the overload look like
 * latency. A client that retries after the hint lands on a process that has
 * drained.
 */
import { Elysia } from "elysia";
import { GatewayError } from "../../protocol/gateway-error";
import { fastPathname } from "../pathname";

/** In-flight `/v1` requests one process will carry before refusing. */
export const PROCESS_CONCURRENCY_CAP = 64;
const PROCESS_CONCURRENCY_RETRY_MS = 3_000;

let inFlight = 0;

/** The current in-flight count. Exposed for tests; not a control surface. */
export function processInFlight(): number {
  return inFlight;
}

export function createProcessConcurrencyMiddleware(): Elysia {
  return new Elysia()
    .beforeHandle(({ request }) => {
      const path = fastPathname(request.url);
      // Only the gateway surface counts. Console reads and health probes must
      // still answer while the process is saturated, or an operator cannot
      // see why it is refusing.
      if (!path.startsWith("/v1/")) return;
      if (inFlight >= PROCESS_CONCURRENCY_CAP) {
        throw new GatewayError(
          "platform_unavailable",
          503,
          "The gateway is at its concurrency limit. Retry shortly.",
          { retryAfterMs: PROCESS_CONCURRENCY_RETRY_MS },
        );
      }
      inFlight += 1;
    })
    .afterResponse(({ request }: { request: Request }) => {
      const path = fastPathname(request.url);
      if (!path.startsWith("/v1/")) return;
      if (inFlight > 0) inFlight -= 1;
    })
    .as("plugin");
}
