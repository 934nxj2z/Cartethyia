#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const packageRoot = path.resolve(__dirname, "..", "..");
const cliPath = path.join(packageRoot, "scripts", "cli", "cli.ts");
const configDir = process.env.CARTETHYIA_CONFIG_DIR || (
  process.platform === "win32"
    ? path.join(process.env.APPDATA || os.homedir(), "Cartethyia")
    : process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support", "Cartethyia")
      : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "Cartethyia")
);
const trayMode = process.argv[2] === "tray";
const startupSignalPath = trayMode
  ? path.join(os.tmpdir(), `cartethyia-tray-${process.pid}-${randomUUID()}.json`)
  : null;
let spawnError;
// On Windows, `cmd /c start "" /b` gives bun its own console group so the
// launching terminal can close without signalling the gateway. Elsewhere
// `detached: true` is enough. Either way the child is unref'd below so the
// launcher can exit without taking the gateway down with it.
const useWindowsDetach = process.platform === "win32" && trayMode;
const child = useWindowsDetach
  ? spawn("cmd", ["/c", "start", "", "/b", "bun", "run", cliPath, ...process.argv.slice(2)], {
      cwd: packageRoot,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
        CARTETHYIA_CONFIG_DIR: configDir,
        CARTETHYIA_TRAY_STARTUP_SIGNAL: startupSignalPath,
      },
    })
  : spawn("bun", ["run", cliPath, ...process.argv.slice(2)], {
      cwd: packageRoot,
      detached: trayMode,
      stdio: trayMode ? "ignore" : "inherit",
      windowsHide: trayMode,
      env: {
        ...process.env,
        CARTETHYIA_CONFIG_DIR: configDir,
        ...(trayMode ? { CARTETHYIA_TRAY_STARTUP_SIGNAL: startupSignalPath } : {}),
      },
    });

child.once("error", (error) => {
  spawnError = error;
  if (error.code === "ENOENT") {
    console.error("Cartethyia requires Bun 1.4.0 or newer. Install Bun from https://bun.sh, then run this command again.");
  } else {
    console.error(`Could not start Cartethyia's Bun runtime: ${error.message}`);
  }
  process.exitCode = 1;
});

if (trayMode) {
  child.unref();
  console.log("Loading Cartethyia…");
  let settled = false;
  const deadline = Date.now() + 60_000;
  const finish = (error, url) => {
    if (settled) return;
    settled = true;
    try {
      fs.unlinkSync(startupSignalPath);
    } catch {}
    if (error) {
      // `error.message` can be an empty string when the failure came from a
      // signal rather than a thrown message, which printed as a bare
      // "Cartethyia failed to start:" with no cause. Fall back to the code and
      // name what usually causes it.
      const detail =
        error.message && error.message.trim() !== ""
          ? error.message
          : `the process exited without a message (code ${child.exitCode ?? "unknown"})`;
      console.error(`Cartethyia failed to start: ${detail}`);
      console.error(
        "If another Cartethyia is already running on this port, stop it with `cartethyia stop` first.",
      );
      process.exitCode = 1;
      if (child.exitCode === null) child.kill();
      return;
    }
    console.log(`Cartethyia is ready at ${url}`);
    // The gateway child is already detached and unref'd; this Node process is
    // the only thing still holding the launching terminal open. Exit once the
    // URL has been shown so the shell prompt comes back.
    setTimeout(() => process.exit(0), 1_500);
  };
  const poll = () => {
    if (settled) return;
    if (fs.existsSync(startupSignalPath)) {
      try {
        const signal = JSON.parse(fs.readFileSync(startupSignalPath, "utf8"));
        if (signal.status === "ready" && typeof signal.url === "string") {
          finish(null, signal.url);
          return;
        }
        if (signal.status === "failed" && typeof signal.message === "string") {
          finish(new Error(signal.message));
          return;
        }
      } catch {}
    }
    if (spawnError) {
      finish(spawnError);
      return;
    }
    if (Date.now() >= deadline) {
      finish(new Error("startup did not complete within 60 seconds"));
      return;
    }
    setTimeout(poll, 150);
  };
  child.once("exit", (code, signal) => {
    if (!settled) setTimeout(() => finish(new Error(`the tray process exited before readiness (code ${code ?? signal ?? "unknown"})`)), 250);
  });
  poll();
} else {
  child.once("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  });
}
