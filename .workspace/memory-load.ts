export {};

/**
 * Load probe — measures the TRANSIENT half of memory.
 *
 * The baseline probe (memory-probe.ts) measures what a module graph retains.
 * This one answers the other question: how much does memory grow while traffic
 * is served, and does it come back down afterwards? A figure that never comes
 * back down is retained-per-request — the thing that turns a 130 MiB idle
 * gateway into an OOM after a day.
 *
 * Usage:  bun run .workspace/memory-load.ts [iterations]
 *
 * It drives the running gateway over HTTP (no auth needed for /health and
 * /metrics) and samples RSS/heap from the *gateway's own* metrics endpoint, so
 * the numbers are the server's, not this client's.
 */

const BASE = process.env["CARTETHYIA_BASE"] ?? "http://127.0.0.1:12800";
const ITERATIONS = Number(process.argv[2] ?? 400);
const CONCURRENCY = Number(process.argv[3] ?? 16);

interface Sample {
  readonly rss: number;
  readonly heap: number;
  readonly heapTotal: number;
}

async function readMetrics(): Promise<Sample | undefined> {
  try {
    const response = await fetch(`${BASE}/metrics`);
    if (!response.ok) return undefined;
    const text = await response.text();
    const grab = (name: string): number => {
      const match = new RegExp(`^${name} (\\d+)`, "m").exec(text);
      return match?.[1] ? Number(match[1]) : NaN;
    };
    return {
      rss: grab("cartethyia_memory_rss_bytes"),
      heap: grab("cartethyia_memory_heap_used_bytes"),
      heapTotal: grab("cartethyia_memory_heap_total_bytes"),
    };
  } catch {
    return undefined;
  }
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MiB`;

const before = await readMetrics();
if (before === undefined) {
  console.error(`No gateway at ${BASE} — start one first, then re-run.`);
  process.exit(1);
}
console.log(`gateway at ${BASE}`);
console.log(`before:  rss ${mb(before.rss)}   heap ${mb(before.heap)} / ${mb(before.heapTotal)}`);

console.log(`\ndriving ${ITERATIONS} requests at concurrency ${CONCURRENCY} ...`);
let cursor = 0;
let failures = 0;
const started = performance.now();
const worker = async (): Promise<void> => {
  for (;;) {
    const index = cursor++;
    if (index >= ITERATIONS) return;
    try {
      const response = await fetch(`${BASE}/health`);
      if (!response.ok) failures += 1;
      await response.text();
    } catch {
      failures += 1;
    }
  }
};
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
const elapsed = Math.round(performance.now() - started);
console.log(`  done in ${elapsed}ms (${Math.round((ITERATIONS / elapsed) * 1000)} req/s), failures ${failures}`);

const during = await readMetrics();
if (during) console.log(`during:  rss ${mb(during.rss)}   heap ${mb(during.heap)} (+${mb(during.heap - before.heap)})`);

// Settle: give the GC and any flush interval time to run.
console.log("\nsettling 5s ...");
await new Promise((r) => setTimeout(r, 5000));
const after = await readMetrics();
if (after) {
  console.log(`after:   rss ${mb(after.rss)}   heap ${mb(after.heap)}`);
  const retained = after.heap - before.heap;
  console.log(`\nheap retained after traffic: ${retained >= 0 ? "+" : ""}${mb(retained)}`);
  console.log(
    retained > 16 * 1024 * 1024
      ? "  -> material growth: worth investigating before it compounds."
      : "  -> within normal allocator noise for this workload.",
  );
}

console.log("\n=== notes ===");
console.log("/health is nearly free, so this measures the request machinery, not the");
console.log("provider path. Point CARTETHYIA_BASE at a gateway and hit a real");
console.log("/v1/chat/completions route to measure the dispatch path instead — that");
console.log("is where snapshot candidates, quota cache entries, and streams live.");
