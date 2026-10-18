import { openSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_ROOT, resolvePackagePath } from "../../../src/config/package-paths";

/**
 * Starts the gateway and resolves once it answers its own health probe.
 *
 * The child is attached by default. A detached child cannot be killed from an
 * `exit` handler on Windows (measured: `kill()` runs, the gateway keeps
 * serving), and a terminal's Ctrl-C only reaches children in the same process
 * group. Staying attached means Ctrl-C and the `exit` backstop both stop the
 * gateway. "Hide to tray" passes `detached: true` because that gateway must
 * outlive this process.
 */
export async function startGateway(
  port: number,
  drainToken: string,
  options: { readonly detached?: boolean } = {},
): Promise<Bun.Subprocess> {
  // Starting a second gateway on the same port used to fail with "stopped
  // before becoming ready (exit code 1)", which says nothing about the real
  // cause. Probe the port first and say what is actually there.
  const existing = await fetch(`http://127.0.0.1:${port}/health`, {
    signal: AbortSignal.timeout(1_000),
  }).catch(() => null);
  if (existing !== null) {
    throw new Error(
      `Cartethyia is already running on port ${port}. Open http://127.0.0.1:${port}/console, or stop the terminal that started it.`,
    );
  }
  // The gateway logs a startup phase line per stage. In menu mode those lines
  // would scroll through the same terminal the menu is drawing on, so they go
  // to a file instead and the operator sees only the menu.
  const configDir = process.env.CARTETHYIA_CONFIG_DIR;
  let logFd: number | null = null;
  if (configDir) {
    try {
      logFd = openSync(join(configDir, "gateway.log"), "a");
    } catch {
      // A read-only config directory costs only the log, not startup.
    }
  }
  const child = Bun.spawn(
    [process.execPath, "run", resolvePackagePath("src", "main.ts")],
    {
      cwd: PACKAGE_ROOT,
      env: { ...process.env, CARTETHYIA_DRAIN_TOKEN: drainToken },
      // "ignore", not "inherit": the gateway does not read stdin, and in menu
      // mode the menu is the only stdin consumer. With "inherit" the gateway
      // held the fd and swallowed every keypress after the first, so the menu
      // rendered but never received Enter.
      stdin: "ignore",
      stdout: logFd ?? "ignore",
      // stderr goes to the same file: "inherit" ties the gateway to the
      // terminal, so closing that terminal took the gateway down with it and
      // "Hide to tray" left nothing running.
      stderr: logFd ?? "ignore",
      detached: options.detached === true,
    },
  );
  const startupController = new AbortController();
  const ready = (async (): Promise<void> => {
    const deadline = Date.now() + 30_000;
    while (!startupController.signal.aborted && Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(500),
        });
        if (response.ok) {
          const body: unknown = await response.json();
          if (body !== null && typeof body === "object" && "status" in body && body.status === "ok") return;
        }
      } catch {
        // The gateway is not accepting health requests yet.
      }
      await Bun.sleep(250);
    }
    if (startupController.signal.aborted) throw new Error("Cartethyia exited before becoming ready");
    throw new Error("Cartethyia did not open its configured port within 30 seconds");
  })();
  const exitedEarly = child.exited.then((code) => {
    startupController.abort();
    return { status: "exit" as const, code };
  });
  const readyResult = ready.then(
    () => ({ status: "ready" as const }),
    (error: unknown) => ({ status: "failure" as const, error }),
  );
  try {
    const result = await Promise.race([readyResult, exitedEarly]);
    if (result.status === "exit") {
      throw new Error(`Cartethyia stopped before becoming ready (exit code ${result.code})`);
    }
    if (result.status === "failure") throw result.error;
    return child;
  } catch (error) {
    child.kill();
    await child.exited;
    throw error;
  }
}
