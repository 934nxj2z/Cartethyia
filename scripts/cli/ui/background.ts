import { spawn } from "node:child_process";
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
  if (process.platform !== "win32") {
    const child = spawn(process.execPath, [...args], {
      cwd: PACKAGE_ROOT,
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return;
  }
  const launcher = resolvePackagePath("scripts", "cli", "tray", "hidden-window.vbs");
  const child = spawn(
    "wscript.exe",
    ["//nologo", launcher, process.execPath, ...args],
    { cwd: PACKAGE_ROOT, detached: true, stdio: "ignore", windowsHide: true },
  );
  child.unref();
}
