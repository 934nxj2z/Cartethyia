/**
 * Starts one gateway instance configured for load measurement.
 *
 * `bun run dev:backend` reloads on change and shortens several budgets, which
 * would make every number in this investigation depend on whether a file was
 * touched mid-run. This starts the same entry point with a fixed environment
 * and no watcher, so a before/after pair differs only by the code under test.
 */
const env: Record<string, string> = {
  ...process.env,
  CARTETHYIA_DB_MODE: "full",
  DATABASE_URL: process.env.CARTETHYIA_PERF_DATABASE_URL ?? "postgres://postgres@localhost:5432/cartethyia_perf",
  PORT: process.env.PERF_PORT ?? "9901",
  // The stub upstream is loopback, which the SSRF policy rejects by default.
  // This flag exists for exactly this shape of deployment (a self-hosted or
  // LAN upstream) so it is the honest way to point the gateway at it rather
  // than a hole in the policy.
  CARTETHYIA_ALLOW_PRIVATE_UPSTREAMS: "true",
  // The default abuse window (240/min) is exactly the concurrency this
  // harness drives, so every run would measure the limiter rather than the
  // gateway. Raised for measurement only — it is a load-test knob, not a
  // production default.
  IP_RATE_MAX_PER_WINDOW: process.env.PERF_IP_RATE ?? "100000",
  // Max is 100 by spec; enough that a load run never trips the strike ban.
  CARTETHYIA_MODEL_STRIKE_THRESHOLD: "100",
};
const entry = new URL("../../src/main.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const proc = Bun.spawn(["bun", "run", entry], {
  env,
  stdout: "inherit",
  stderr: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    proc.kill(signal);
  });
}
await proc.exited;
