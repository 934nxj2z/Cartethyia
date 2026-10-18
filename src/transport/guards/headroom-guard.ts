/**
 * Memory-headroom shed guard.
 *
 * The per-key, per-tenant, and process concurrency caps bound how many
 * requests run at once, but not how much memory a hundred large contexts
 * together hold. When the box runs out, the kernel OOM-kills the process — and
 * because the SPA is served by the same process, the dashboard dies with it,
 * leaving the operator with no console to see what happened.
 *
 * This refuses a *gateway* request with 503 before it can push the process into
 * the danger zone, so the console and static surfaces keep being served while
 * gateway load is shed. It reuses the concurrency guard's shape: fail with a
 * short retry hint rather than queue, because queueing would convert an
 * overload into unbounded latency.
 *
 * Only `/v1/*` requests are shed. `/`, `/console/*`, `/share/*`, health and
 * metrics are exempt so an operator can always reach the console that explains
 * the shedding.
 */
import { totalmem } from "node:os";
import { Elysia } from "elysia";
import { GatewayError } from "../../protocol/gateway-error";
import type { RedisClient } from "../../persistence/redis";
import type { ProxyRequestStateStore } from "../request/state";
import { isProxyRequest } from "./body-policy";

/** Free bytes the process must keep below its RSS before it stops accepting. */
const DEFAULT_MIN_FREE_BYTES = 64 * 1024 * 1024;
/** How long the shared shed marker outlives the last shed, so peers can see it. */
const SHED_MARKER_TTL_SECONDS = 5;
/** Fleet-visible marker: set on the first shed so every instance reports the same state. */
const SHED_MARKER_KEY = "gateway:shed:v1";
const SHED_RETRY_MS = 1_000;

export interface HeadroomGuardDeps {
  readonly store: ProxyRequestStateStore;
  /** Free bytes to keep; defaults to 64 MiB. A smaller box wants a larger value. */
  readonly minFreeBytes?: number;
  /**
   * Optional shared client. Used only to publish a shed marker for visibility;
   * the shed decision is local and Redis is never awaited on the request path,
   * so a slow or down Redis cannot add latency or fail a request here.
   */
  readonly redis?: RedisClient | undefined;
}

export function createHeadroomGuard(deps: HeadroomGuardDeps): Elysia {
  const minFreeBytes = deps.minFreeBytes ?? DEFAULT_MIN_FREE_BYTES;
  return new Elysia()
    .beforeHandle(({ request }) => {
      if (!isProxyRequest(request)) return;
      if (process.memoryUsage().rss + minFreeBytes <= totalmem()) return;
      if (deps.redis) {
        // Fire-and-forget: a failed marker write must not change this request's
        // outcome, and awaiting it would put Redis on the shed path.
        void deps.redis
          .set(SHED_MARKER_KEY, String(Date.now()), "EX", SHED_MARKER_TTL_SECONDS, "NX")
          .catch(() => undefined);
      }
      throw new GatewayError(
        "overloaded",
        503,
        "The gateway is at capacity; retry shortly.",
        { retryAfterMs: SHED_RETRY_MS, minFreeBytes, activeRequests: deps.store.activeCount() },
      );
    })
    .as("plugin");
}
