import { spawn } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { PACKAGE_ROOT, resolvePackagePath } from "../../../src/config/package-paths";

/** Opens a URL in the operator's default browser, ignoring a missing handler. */
export function openUrl(url: string): Promise<void> {
  const command = process.platform === "win32"
    ? "explorer.exe"
    : process.platform === "darwin"
      ? "open"
      : "xdg-open";
  const child = Bun.spawn([command, url], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  return child.exited.then(() => undefined);
}

/**
 * Starts a detached process and resolves once it reports readiness.
 *
 * The child owns no stdio, so a signal file is the only channel that survives
 * the parent. Without it the caller prints "running in the background" for a
 * child that may already have died — which is exactly what a port clash looks
 * like, because the child's own startup probe fails while the parent's gateway
 * still holds the port.
 *
 * Resolves with the URL the child reported. Rejects with the child's message
 * when it reports failure, or with a timeout if it never reports at all.
 */
export function launchBackgroundWithStatus(
  args: readonly string[],
  options: { readonly signalPath: string; readonly timeoutMs?: number } = { signalPath: "" },
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const signalPath = options.signalPath;
    const deadline = Date.now() + (options.timeoutMs ?? 60_000);
    let settled = false;
    const finish = (error: Error | null, url?: string): void => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      try {
        unlinkSync(signalPath);
      } catch {}
      if (error) reject(error);
      else resolve(url ?? "");
    };

    const env = { ...process.env, CARTETHYIA_TRAY_STARTUP_SIGNAL: signalPath };
    spawnBackground(args, env);

    const timer = setInterval(() => {
      if (settled) return;
      let raw: string;
      try {
        raw = readFileSync(signalPath, "utf8");
      } catch {
        if (Date.now() >= deadline) finish(new Error("the background process did not report startup within the deadline"));
        return;
      }
      try {
        const signal = JSON.parse(raw) as { status?: string; url?: string; message?: string };
        if (signal.status === "ready" && typeof signal.url === "string") finish(null, signal.url);
        else if (signal.status === "failed") finish(new Error(signal.message ?? "the background process failed to start"));
      } catch {
        // A partially written file is read again on the next tick.
      }
    }, 150);
    timer.unref?.();
  });
}

/**
 * Starts a Bun process that owns no console window.
 *
 * On Windows, spawning the child directly is not enough: a console-subsystem
 * child of a window-less parent allocates a new console, and when the parent is
 * inside Windows Terminal the tab is already on screen before any flag can take
 * effect — measured: `detached: true` plus `windowsHide: true` still produced a
 * Windows Terminal window titled with the bun path. `wscript.exe` is a
 * GUI-subsystem host, so it never allocates a console, and a child launched
 * from it with window style 0 inherits that. The VBS is that launcher.
 *
 * Elsewhere `detached` is enough and the helper is not used.
 */
export function launchBackground(args: readonly string[]): void {
  spawnBackground(args, process.env);
}

function spawnBackground(args: readonly string[], env: NodeJS.ProcessEnv): void {
  if (process.platform !== "win32") {
    const child = spawn(process.execPath, [...args], {
      cwd: PACKAGE_ROOT,
      detached: true,
      stdio: "ignore",
      env,
    });
    child.unref();
    return;
  }
  const launcher = resolvePackagePath("scripts", "cli", "tray", "hidden-window.vbs");
  const child = spawn(
    "wscript.exe",
    ["//nologo", launcher, process.execPath, ...args],
    { cwd: PACKAGE_ROOT, detached: true, stdio: "ignore", windowsHide: true, env },
  );
  child.unref();
}
