/**
 * Drives concurrent load at a running gateway and reports what the audit needs.
 *
 * Deliberately measures two things separately:
 *
 * - **Hot path** — `POST /v1/chat/completions` on the seeded model. The
 *   upstream is unroutable, so this exercises everything the gateway owns
 *   (auth, admission, routing, lease, attempt bookkeeping, telemetry, release)
 *   and none of the provider's latency. That is the part under investigation.
 * - **Dashboard** — `GET /console/api/*` endpoints, driven *concurrently* with
 *   the hot path so contention is visible rather than inferred.
 *
 * Reports p50/p95/p99 per surface, and samples RSS/heap before, during, and
 * after so a reclaim claim is backed by numbers instead of a vibe.
 *
 * Usage: bun run scripts/perf/load.ts --concurrency 40 --requests 400
 *        [--dashboard] [--base http://127.0.0.1:9901] [--token <key>]
 *        [--settle 30] [--json out.json]
 */
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    concurrency: { type: "string", default: "40" },
    requests: { type: "string", default: "400" },
    base: { type: "string", default: "http://127.0.0.1:9901" },
    token: { type: "string" },
    model: { type: "string" },
    dashboard: { type: "boolean", default: false },
    "dashboard-rps": { type: "string", default: "2" },
    settle: { type: "string", default: "30" },
    json: { type: "string" },
  },
});

const base = String(values.base);
const concurrency = Number(values.concurrency);
const total = Number(values.requests);
const withDashboard = values.dashboard === true;
const dashboardRps = Number(values["dashboard-rps"]);
const settleSeconds = Number(values.settle);
const token = values.token ? String(values.token) : undefined;
const model = values.model ? String(values.model) : undefined;

if (!Number.isFinite(concurrency) || concurrency < 1) throw new Error("--concurrency must be >= 1");
if (!Number.isFinite(total) || total < 1) throw new Error("--requests must be >= 1");
if (!token || !model) throw new Error("--token and --model are required (run scripts/perf/seed.ts first)");

/** Dashboard routes that read aggregated data, hit alongside the hot path. */
const DASHBOARD_PATHS = [
  "/console/api/usage/summary",
  "/console/api/requests/recent",
  "/console/api/providers",
  "/console/api/models",
  "/console/api/accounts",
] as const;

type Sample = { readonly rssMb: number; readonly heapMb: number; readonly inFlight: number };

async function sample(): Promise<Sample> {
  const memory = process.memoryUsage();
  return {
    rssMb: Math.round((memory.rss / 1024 / 1024) * 10) / 10,
    heapMb: Math.round((memory.heapUsed / 1024 / 1024) * 10) / 10,
    inFlight: 0,
  };
}

/** Reads the gateway's own process memory, not this harness's. */
async function gatewayMemory(): Promise<Sample> {
  // Retried: the probe competes with the load it is measuring for a
  // connection, and one failed attempt must not cost the run its memory
  // numbers — the reclaim evidence is half the point.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      // A longer timeout than the default: under peak load this probe is one
      // more client competing for the listener, and losing it silently is what
      // made the memory columns read NaN on earlier runs.
      const response = await fetch(`${base}/metrics`, {
        signal: AbortSignal.timeout(10_000),
      });
      const text = await response.text();
      const gauge = (name: string): number => {
        const match = new RegExp(`^${name} (\\d+)$`, "m").exec(text);
        return match ? Number(match[1]) : Number.NaN;
      };
      const inFlightMatch = /^proxy_in_flight (\d+)$/m.exec(text);
      return {
        rssMb: Math.round((gauge("cartethyia_memory_rss_bytes") / 1024 / 1024) * 10) / 10,
        heapMb: Math.round((gauge("cartethyia_memory_heap_used_bytes") / 1024 / 1024) * 10) / 10,
        inFlight: inFlightMatch ? Number(inFlightMatch[1]) : Number.NaN,
      };
    } catch (error) {
      if (attempt < 2) {
        await Bun.sleep(250);
        continue;
      }
      console.log(`[load] metrics sample failed: ${(error as Error).message}`);
    }
  }
  return { rssMb: Number.NaN, heapMb: Number.NaN, inFlight: Number.NaN };
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

function summarize(values: readonly number[]): {
  readonly count: number;
  readonly meanMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  readonly errors: number;
} {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((sum, v) => sum + v, 0) / Math.max(1, values.length);
  return {
    count: values.length,
    meanMs: Math.round(mean * 100) / 100,
    p50Ms: Math.round(percentile(sorted, 50) * 100) / 100,
    p95Ms: Math.round(percentile(sorted, 95) * 100) / 100,
    p99Ms: Math.round(percentile(sorted, 99) * 100) / 100,
    maxMs: Math.round((sorted.at(-1) ?? 0) * 100) / 100,
    errors: 0,
  };
}

interface SurfaceResult {
  readonly surface: string;
  readonly sent: number;
  readonly ok: number;
  readonly statusCounts: Record<string, number>;
  readonly latency: ReturnType<typeof summarize>;
}

async function driveSurface(
  surface: string,
  path: string,
  init: () => { method: string; headers: Record<string, string>; body?: string },
  count: number,
  parallel: number,
): Promise<SurfaceResult> {
  const latencies: number[] = [];
  const statusCounts: Record<string, number> = {};
  let index = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const mine = index;
      index += 1;
      if (mine >= count) return;
      const started = Bun.nanoseconds();
      try {
        const response = await fetch(`${base}${path}`, init() as RequestInit);
        await response.arrayBuffer();
        const bucket = String(response.status);
        statusCounts[bucket] = (statusCounts[bucket] ?? 0) + 1;
      } catch {
        statusCounts.network_error = (statusCounts.network_error ?? 0) + 1;
      }
      latencies.push((Bun.nanoseconds() - started) / 1e6);
    }
  };
  await Promise.all(Array.from({ length: parallel }, () => worker()));
  const ok = Object.entries(statusCounts)
    .filter(([status]) => status.startsWith("2"))
    .reduce((sum, [, n]) => sum + n, 0);
  return { surface, sent: count, ok, statusCounts, latency: summarize(latencies) };
}

const chatInit = () => ({
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({
    model,
    max_tokens: 64,
    stream: false,
    messages: [{ role: "user", content: "Say hello to Cartethyia." }],
  }),
});

console.log(`[load] base=${base} concurrency=${concurrency} requests=${total} dashboard=${withDashboard}`);

const idleBefore = await gatewayMemory();
console.log(`[load] idle  rss=${idleBefore.rssMb}MB heap=${idleBefore.heapMb}MB`);

const started = Date.now();
const dashboardLatencies: number[] = [];
let dashboardStop = false;
const dashboardTask = (async () => {
  if (!withDashboard) return;
  const intervalMs = Math.max(20, Math.round(1000 / Math.max(1, dashboardRps)));
  let pathIndex = 0;
  while (!dashboardStop) {
    const path = DASHBOARD_PATHS[pathIndex % DASHBOARD_PATHS.length]!;
    pathIndex += 1;
    const t0 = Bun.nanoseconds();
    try {
      const response = await fetch(`${base}${path}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      await response.arrayBuffer();
    } catch {
      // Counted as latency only; a refusal is still contention evidence.
    }
    dashboardLatencies.push((Bun.nanoseconds() - t0) / 1e6);
    await Bun.sleep(intervalMs);
  }
})();

const hot = await driveSurface("chat", "/v1/chat/completions", chatInit, total, concurrency);
const duringPeak = await gatewayMemory();
dashboardStop = true;
await dashboardTask;
const elapsedMs = Date.now() - started;

console.log(
  `[load] peak  rss=${duringPeak.rssMb}MB heap=${duringPeak.heapMb}MB inFlight=${duringPeak.inFlight} ` +
    `elapsed=${elapsedMs}ms throughput=${Math.round((total / elapsedMs) * 1000)}req/s`,
);
console.log(
  `[load] hot   p50=${hot.latency.p50Ms}ms p95=${hot.latency.p95Ms}ms p99=${hot.latency.p99Ms}ms ` +
    `mean=${hot.latency.meanMs}ms max=${hot.latency.maxMs}ms statuses=${JSON.stringify(hot.statusCounts)}`,
);
if (withDashboard) {
  console.log(
    `[load] dash  n=${dashboardLatencies.length} p50=${summarize(dashboardLatencies).p50Ms}ms ` +
      `p95=${summarize(dashboardLatencies).p95Ms}ms p99=${summarize(dashboardLatencies).p99Ms}ms`,
  );
}

if (settleSeconds > 0) {
  await Bun.sleep(settleSeconds * 1000);
  const settled = await gatewayMemory();
  console.log(`[load] settled rss=${settled.rssMb}MB heap=${settled.heapMb}MB after ${settleSeconds}s`);
  console.log(
    `[load] reclaim rssDelta=${Math.round((settled.rssMb - duringPeak.rssMb) * 10) / 10}MB ` +
      `heapDelta=${Math.round((settled.heapMb - duringPeak.heapMb) * 10) / 10}MB`,
  );
}

if (values.json) {
  await Bun.write(
    String(values.json),
    JSON.stringify(
      {
        base,
        concurrency,
        requests: total,
        withDashboard,
        dashboardRps,
        elapsedMs,
        idleBefore,
        duringPeak,
        hot,
        dashboard: withDashboard ? summarize(dashboardLatencies) : undefined,
        harness: await sample(),
      },
      null,
      2,
    ),
  );
}
