export {};

/**
 * Baseline memory probe — read-only, no production code changes.
 *
 * Answers one question: where does this process's memory go, and how much of it
 * is retained (held forever) versus transient (released after a request)?
 *
 * Usage:  bun run .workspace/memory-probe.ts
 *
 * It deliberately does NOT import `src/main.ts` — that would start a listener
 * and its own boot phases, and the startup log already reports those deltas.
 * This measures the module graphs that a running gateway retains, so it can be
 * run anywhere without a port or a database.
 */
const SAMPLE = () => {
  const m = process.memoryUsage();
  return { rss: m.rss, heap: m.heapUsed, external: m.external, arrayBuffers: m.arrayBuffers };
};

const fmt = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MiB`;

function report(label: string, before: ReturnType<typeof SAMPLE>, after: ReturnType<typeof SAMPLE>) {
  const d = (a: number, b: number) => (a - b >= 0 ? "+" : "") + fmt(a - b);
  console.log(
    `${label.padEnd(32)} rss ${fmt(after.rss).padStart(9)} (${d(after.rss, before.rss).padStart(10)})` +
      `   heap ${fmt(after.heap).padStart(9)} (${d(after.heap, before.heap).padStart(10)})`,
  );
}

console.log("=== baseline (bare process, before any repo import) ===");
const base = SAMPLE();
console.log(`rss ${fmt(base.rss)}   heap ${fmt(base.heap)}   external ${fmt(base.external)}`);

const step = async (label: string, importPath: string, before: ReturnType<typeof SAMPLE>) => {
  const t0 = performance.now();
  await import(importPath);
  const after = SAMPLE();
  report(label, before, after);
  console.log(`${" ".repeat(32)}   import ${Math.round(performance.now() - t0)}ms`);
  return after;
};

console.log("\n=== module graphs a running gateway retains ===");
let cursor = await step("provider metadata", "../src/providers/provider-metadata.ts", base);
cursor = await step("default registry", "../src/providers/default-registry.ts", cursor);
cursor = await step("protocol registry", "../src/protocol/registry.ts", cursor);
cursor = await step("persistence boot", "../src/persistence/boot.ts", cursor);
cursor = await step("route catalog", "../src/transport/routing/route-catalog.ts", cursor);
cursor = await step("console router", "../src/console/console-router.ts", cursor);

console.log("\n=== retained floor (what survives a forced GC) ===");
const gc = (globalThis as { Bun?: { gc?: (b: boolean) => void } }).Bun?.gc;
if (typeof gc === "function") {
  const beforeGc = SAMPLE();
  gc(true);
  await new Promise((r) => setTimeout(r, 250));
  const afterGc = SAMPLE();
  report("forced GC", beforeGc, afterGc);
  console.log(`\nretained after GC:  rss ${fmt(afterGc.rss)}   heap ${fmt(afterGc.heap)}`);
  console.log(`transient (freed):  heap ${fmt(beforeGc.heap - afterGc.heap)}`);
} else {
  console.log("Bun.gc unavailable — run with --expose-gc for the retained/transient split.");
  console.log(`current: rss ${fmt(cursor.rss)}   heap ${fmt(cursor.heap)}`);
}

console.log("\n=== how to read this ===");
console.log("- Absolute RSS includes the Bun runtime baseline (~90-110 MiB), so compare");
console.log("  the DELTAS, not the absolute numbers.");
console.log("- A delta that survives GC is retained: memory the operator pays for at idle.");
console.log("- Re-run under load to see the transient half grow; that is the part a");
console.log("  smaller buffer or a shorter TTL would shrink.");
