/**
 * The update path.
 *
 * npm cannot replace this package's directory while a process is executing out
 * of it (EBUSY on Windows). So we spawn the installer as a detached process,
 * print a short notice, and exit — the installer runs after this process is gone.
 * After install, it attempts to restart the gateway (systemd if available, else
 * `cartethyia start`), so the new version comes up automatically.
 * Cross-OS: uses npm.cmd on Windows.
 */
import { spawn } from "node:child_process";

export function updateCommand(): string {
  return "npm install -g cartethyia@latest --prefer-online";
}

export function runDetachedUpdate(): void {
  const isWin = process.platform === "win32";
  const shell = isWin ? "cmd.exe" : "/bin/sh";
  const install = "npm install -g cartethyia@latest --prefer-online";
  const restart = isWin
    ? "cartethyia start"
    : "systemctl restart cartethyia 2>/dev/null || cartethyia start";
  const script = `${install} && ${restart}`;
  const args = isWin ? ["/c", script] : ["-c", script];
  const child = spawn(shell, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

export function printUpdateInstructions(from: string, to: string | null): void {
  console.log("");
  console.log(`Update available: ${from} \u2192 ${to ?? "latest"}`);
  console.log("");
  console.log("Starting detached update; this process will exit now.");
  console.log("The gateway will restart automatically after the install.");
  console.log("");
}