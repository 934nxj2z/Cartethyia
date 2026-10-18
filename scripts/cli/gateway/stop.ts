/**
 * Stops a gateway this process started, gracefully where possible.
 *
 * The drain endpoint is the only graceful path: it lets in-flight responses
 * finish. The OS-level kill is the fallback, and it is reached whenever the
 * endpoint is unreachable — which is also what happens when the gateway is
 * already on its way out, so a failure here is not necessarily an error the
 * operator needs to act on.
 */
export async function stopGateway(
  current: Bun.Subprocess,
  port: number,
  drainToken: string,
): Promise<void> {
  let drainAccepted = false;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/admin/drain`, {
      method: "POST",
      headers: { "x-drain-token": drainToken },
      signal: AbortSignal.timeout(2_000),
    });
    drainAccepted = response.status === 202;
  } catch {
    // The process may already be exiting; fall back to its OS-level termination.
  }
  if (!drainAccepted) {
    console.error("Could not request a graceful gateway drain; terminating the gateway process.");
    current.kill();
    await current.exited;
    return;
  }

  // The drain is bounded: a gateway that accepted the request but never exits
  // would otherwise hang the CLI. 30 s is the drain budget `src/main.ts` uses.
  // The timer is cleared unconditionally afterwards — leaving it pending keeps
  // the event loop alive for its full 30 s after the gateway is already gone,
  // which made every `carte` exit take half a minute.
  let timer: Timer | undefined;
  const drained = await Promise.race([
    current.exited,
    new Promise<null>((resolveExit) => {
      timer = setTimeout(() => resolveExit(null), 30_000);
    }),
  ]);
  clearTimeout(timer);
  if (drained === null) {
    console.error("Graceful drain timed out; terminating the gateway process.");
    current.kill();
    await current.exited;
  }
}
