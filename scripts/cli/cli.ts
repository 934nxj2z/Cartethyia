import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import SysTray from "systray2";
import { isNewerRelease } from "../../src/console/updates/version-compare";
import { PACKAGE_ROOT, resolvePackagePath, resolveUserConfigDir } from "../../src/config/package-paths";
import { resolvePort } from "../../src/config/runtime";
import { MINIMUM_BUN_VERSION, bunVersionAtLeast } from "../shared/env";
import { chooseFromMenu } from "./menu";
import {
  clearPersistedDrainToken,
  readPersistedDrainToken,
  writePersistedDrainToken,
} from "./runtime-state";
import { npmUpdate, readInstalledVersion, readLatestPublishedVersion } from "./version";

process.env.CARTETHYIA_CONFIG_DIR ??= resolveUserConfigDir();

const HELP = `Cartethyia ${MINIMUM_BUN_VERSION}+ (Bun is required)

Usage:
  carte                  start, then show an arrow-key menu (no GUI needed)
  carte --tray           start with a system-tray icon instead
  cartethyia setup [--non-interactive]
  cartethyia start
  cartethyia menu
  cartethyia stop           stop a gateway left running in the background
  cartethyia update

carte starts the gateway in the background and leaves only the console menu on
your terminal — Open Console, Reset password, Backup & Restore, Visit
repository, Update, Exit. Arrow keys and Enter; no desktop environment needed,
so it works over SSH and headless. Exiting the menu drains the gateway.
carte --tray uses a system-tray icon instead, which needs a graphical session.
Stop a gateway whose terminal is gone with "cartethyia stop".
Setup explains Lite (embedded SQLite) and Full (external PostgreSQL), then saves
configuration under the current user's Cartethyia config directory.
`;

function assertBunVersion(): void {
  if (bunVersionAtLeast(Bun.version, MINIMUM_BUN_VERSION)) return;
  throw new Error(
    `Bun ${MINIMUM_BUN_VERSION} or newer is required (found ${Bun.version}). Install it from https://bun.sh and run this command again.`,
  );
}

async function loadUserConfig(): Promise<void> {
  const configDir = process.env.CARTETHYIA_CONFIG_DIR;
  if (!configDir) throw new Error("Cartethyia config directory could not be resolved");
  mkdirSync(configDir, { recursive: true });
  const { ENV_PATH, readEnvFile } = await import("../shared/env");
  const values = await readEnvFile(ENV_PATH);
  for (const [key, value] of Object.entries(values)) {
    if (!process.env[key]) process.env[key] = value;
  }
}


type TrayStartupSignal =
  | { readonly status: "ready"; readonly url: string }
  | { readonly status: "failed"; readonly message: string };

function reportTrayStartup(signal: TrayStartupSignal): void {
  const signalPath = process.env.CARTETHYIA_TRAY_STARTUP_SIGNAL;
  if (!signalPath) return;
  try {
    writeFileSync(signalPath, JSON.stringify(signal), { encoding: "utf8", flag: "wx" });
  } catch {
    // The launcher may have timed out and removed the one-shot signal file.
  }
}

async function waitForTrayStartupSignal(
  signalPath: string,
  child: ChildProcess,
  timeoutMs: number,
): Promise<string> {
  let spawnError: Error | undefined;
  child.once("error", (error) => {
    spawnError = error;
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(signalPath)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(signalPath, "utf8"));
        if (parsed !== null && typeof parsed === "object" && "status" in parsed) {
          if (parsed.status === "ready" && "url" in parsed && typeof parsed.url === "string") return parsed.url;
          if (parsed.status === "failed" && "message" in parsed && typeof parsed.message === "string") {
            throw new Error(parsed.message);
          }
        }
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error(`updated Cartethyia exited during startup (exit code ${child.exitCode})`);
    await Bun.sleep(150);
  }
  throw new Error("Cartethyia did not finish tray and gateway startup within 45 seconds");
}


function openUrl(url: string): Promise<void> {
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


function launchUpdatedTray(signalPath: string): ChildProcess {
  const env = { ...process.env, CARTETHYIA_TRAY_STARTUP_SIGNAL: signalPath };
  const child = spawn(
    process.execPath,
    ["run", resolvePackagePath("scripts", "cli", "cli.ts"), "tray"],
    { cwd: tmpdir(), detached: true, stdio: "ignore", windowsHide: true, env },
  );
  child.unref();
  return child;
}

async function startGateway(port: number, drainToken: string): Promise<Bun.Subprocess> {
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
      stderr: "inherit",
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

async function stopGateway(
  current: ReturnType<typeof Bun.spawn>,
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

  let timer: ReturnType<typeof setTimeout> | undefined;
  const exit = await Promise.race([
    current.exited,
    new Promise<null>((resolveExit) => {
      timer = setTimeout(() => resolveExit(null), 30_000);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (exit === null) {
    console.error("Graceful drain timed out; terminating the gateway process.");
    current.kill();
    await current.exited;
  }
}

async function waitForTray(tray: SysTray): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      tray.ready(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("System tray startup timed out")), 15_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function stopTray(tray: SysTray, ready: boolean, exited: boolean): Promise<void> {
  if (exited) return;
  if (!ready) {
    tray.process.kill();
    return;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      tray.kill(false),
      new Promise<void>((resolveExit) => {
        timer = setTimeout(() => resolveExit(), 5_000);
      }),
    ]);
  } catch {
    // Fall through to a direct child termination below.
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (!tray.killed) tray.process.kill();
}

/**
 * The default `carte` experience: start the gateway, then offer an arrow-key
 * menu. This needs no desktop environment, so it works over SSH, on a headless
 * box, and on Windows where the tray icon lands in the hidden-icons overflow
 * and is never seen. `carte --tray` opts into the icon instead.
 */
async function startMenu(): Promise<void> {
  const port = resolvePort();
  const drainToken = randomBytes(32).toString("hex");
  const dashboardUrl = `http://127.0.0.1:${port}/console`;
  const settingsUrl = `${dashboardUrl}/settings`;
  const repositoryUrl = "https://github.com/risunCode/cartethyia";
  const currentVersion = await readInstalledVersion();

  // The gateway is detached and holds no stdio, so this process owns the
  // terminal outright: nothing else can consume the keys the menu needs. The
  // drain token is persisted before the menu opens because `cartethyia stop`
  // runs in a later shell and has no other handle on this process.
  const gateway = await startGateway(port, drainToken);
  gateway.unref();
  writePersistedDrainToken(drainToken);

  let stopping = false;
  const shutDown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await stopGateway(gateway, port, drainToken);
    clearPersistedDrainToken();
  };
  process.once("SIGINT", () => void shutDown());
  process.once("SIGTERM", () => void shutDown());

  let latestVersion = await readLatestPublishedVersion();
  let running = true;

  while (running) {
    const upToDate = latestVersion === null || !isNewerRelease(currentVersion, latestVersion);
    const latestLabel =
      latestVersion === null
        ? "Latest published version: unavailable"
        : `Latest published version: ${latestVersion}`;
    const updateLabel =
      latestVersion === null
        ? "Check for updates"
        : upToDate
          ? `Up to date (${currentVersion})`
          : `Update to ${latestVersion}`;

    const actions: readonly (() => Promise<void>)[] = [
      async () => openUrl(dashboardUrl),
      async () => openUrl(settingsUrl),
      async () => openUrl(settingsUrl),
      async () => openUrl(repositoryUrl),
      async () => {
        if (upToDate) return;
        const code = await npmUpdate();
        console.log(code === 0 ? "Update finished." : "Update failed.");
        latestVersion = await readLatestPublishedVersion();
      },
      async () => {
        // Hand the running gateway over to the tray instead of stopping it:
        // the token stays persisted so `cartethyia stop` still reaches it, and
        // `detached` keeps the tray alive after this process exits.
        running = false;
        stopping = true;
        const tray = spawn(
          process.execPath,
          ["run", resolvePackagePath("scripts", "cli", "cli.ts"), "tray"],
          {
            cwd: tmpdir(),
            detached: true,
            stdio: "ignore",
            windowsHide: true,
            env: { ...process.env, CARTETHYIA_TRAY_ADOPT_RUNNING: "1" },
          },
        );
        tray.unref();
        console.log(`Cartethyia keeps running at ${dashboardUrl} — the tray icon now owns it.`);
      },
      async () => {
        running = false;
      },
    ];

    const choice = await chooseFromMenu(
      [`Cartethyia ${currentVersion} \u2014 running at ${dashboardUrl}`, latestLabel],
      [
        `Open Console \u00b7 ${dashboardUrl}`,
        "Reset password",
        "Backup & Restore",
        "Visit repository",
        updateLabel,
        "Hide to tray",
        "Exit",
      ],
    );
    if (choice === -1) break;
    const action = actions[choice];
    if (action) await action();
  }
  await shutDown();
}

/**
 * Stops a gateway left running by "Hide to background". That process is not a
 * child of this one, so it cannot be signalled directly — the only handle is
 * the loopback drain endpoint, which needs the drain token the start wrote.
 */
async function stopRunningGateway(): Promise<number> {
  const port = resolvePort();
  const token = readPersistedDrainToken();
  if (token === null) {
    console.error(
      "No background Cartethyia gateway was found for this install. Start one with `carte`, or stop a foreground run with Ctrl-C.",
    );
    return 1;
  }
  try {
    const response = await fetch(`http://127.0.0.1:${port}/admin/drain`, {
      method: "POST",
      headers: { "x-drain-token": token },
      signal: AbortSignal.timeout(3_000),
    });
    if (response.status !== 202) {
      console.error(`The gateway refused the drain request (HTTP ${response.status}).`);
      return 1;
    }
  } catch {
    console.error("No gateway is listening on the configured port. It may already be stopped.");
    return 1;
  }
  clearPersistedDrainToken();
  console.log("Cartethyia is draining and will stop once in-flight requests finish.");
  return 0;
}


async function startTray(): Promise<void> {
  const port = resolvePort();
  const drainToken = randomBytes(32).toString("hex");
  const currentVersion = await readInstalledVersion();
  const dashboardUrl = `http://127.0.0.1:${port}/console`;
  const settingsUrl = `${dashboardUrl}/settings`;
  const icon = resolvePackagePath(
    "tray-assets",
    process.platform === "win32" ? "cartethyia.ico" : "cartethyia.png",
  );
  const version = {
    title: `Current Cartethyia version: ${currentVersion}`,
    tooltip: `Running Cartethyia ${currentVersion}`,
    enabled: false,
  };
  const repository = {
    title: "Repository: risunCode/cartethyia",
    tooltip: "Open the Cartethyia GitHub repository",
    enabled: true,
  };
  const updateStatus = {
    title: "Version tracker: checking npm…",
    tooltip: "Latest published Cartethyia version on npm",
    enabled: false,
  };
  const update = {
    title: "Checking for updates…",
    tooltip: "Update Cartethyia and restart the tray process",
    enabled: false,
  };
  const openConsole = {
    title: `Open Console · ${dashboardUrl}`,
    tooltip: `Open the local Console at ${dashboardUrl}`,
    enabled: true,
  };
  const resetPassword = {
    title: "Reset password",
    tooltip: "Open Console settings to change the administrator password",
    enabled: true,
  };
  const backupRestore = {
    title: "Backup & Restore",
    tooltip: "Open Console settings to export or restore configuration",
    enabled: true,
  };
  const exit = {
    title: "Exit",
    tooltip: "Stop Cartethyia gracefully and close the tray",
    enabled: true,
  };
  const tray = new SysTray({
    menu: {
      icon,
      title: "Cartethyia",
      tooltip: "Cartethyia AI gateway",
      items: [
        version,
        repository,
        updateStatus,
        update,
        SysTray.separator,
        openConsole,
        resetPassword,
        backupRestore,
        SysTray.separator,
        exit,
      ],
    },
    copyDir: true,
  });

  let gateway: ReturnType<typeof Bun.spawn> | null = null;
  let trayReady = false;
  let trayExited = false;
  let closing = false;
  let busy = false;
  let latestVersion: string | null = null;
  let closePromise: Promise<void> | undefined;

  const close = (exitCode = 0): Promise<void> => {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      const current: ReturnType<typeof Bun.spawn> | null = gateway;
      gateway = null;
      if (current) await stopGateway(current, port, drainToken);
      await stopTray(tray, trayReady, trayExited);
      process.exitCode = exitCode;
    })();
    return closePromise;
  };

  const refreshVersion = async (): Promise<void> => {
    const fetchedVersion = await readLatestPublishedVersion();
    if (closing) return;
    latestVersion = fetchedVersion;
    if (fetchedVersion === null) {
      updateStatus.title = "Version tracker: unavailable";
      update.title = "Check for updates";
      update.enabled = true;
    } else {
      updateStatus.title = `Latest published version: ${fetchedVersion}`;
      if (isNewerRelease(currentVersion, fetchedVersion)) {
        update.title = `Update to ${fetchedVersion}`;
        update.enabled = true;
      } else {
        update.title = `Up to date (${currentVersion})`;
        update.enabled = false;
      }
    }
    try {
      await tray.sendAction({ type: "update-item", item: updateStatus });
      await tray.sendAction({ type: "update-item", item: update });
    } catch {
      // The tray may be closing while the background version check completes.
    }
  };

  const handleClick = async (title: string): Promise<void> => {
    if (closing) return;
    if (title === "Exit") {
      await close();
      return;
    }
    if (title === openConsole.title) {
      await openUrl(dashboardUrl);
      return;
    }
    if (title === resetPassword.title || title === backupRestore.title) {
      await openUrl(settingsUrl);
      return;
    }
    if (title === repository.title) {
      await openUrl("https://github.com/risunCode/cartethyia");
      return;
    }
    if (title === "Check for updates" && !busy) {
      await refreshVersion();
      return;
    }
    if (title !== update.title || !update.enabled || busy) return;
    if (latestVersion === null || !isNewerRelease(currentVersion, latestVersion)) {
      await refreshVersion();
      return;
    }

    busy = true;
    update.title = "Updating Cartethyia…";
    update.enabled = false;
    try {
      await tray.sendAction({ type: "update-item", item: update });
      const current = gateway;
      if (!current) throw new Error("Cartethyia gateway is not running");
      gateway = null;
      await stopGateway(current, port, drainToken);
      if (closing) return;

      console.log("Updating Cartethyia through npm...");
      const code = await npmUpdate();
      if (closing) return;
      if (code !== 0) {
        console.error(`npm update failed with exit code ${code}; restarting the current installation.`);
        gateway = await startGateway(port, drainToken);
        await refreshVersion();
        return;
      }

      const signalPath = join(tmpdir(), `cartethyia-tray-update-${randomBytes(16).toString("hex")}.json`);
      try {
        const updatedProcess = launchUpdatedTray(signalPath);
        const updatedUrl = await waitForTrayStartupSignal(signalPath, updatedProcess, 60_000);
        console.log(`Cartethyia updated to ${await readInstalledVersion()} and restarted at ${updatedUrl}`);
        await close();
      } finally {
        if (existsSync(signalPath)) unlinkSync(signalPath);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown error";
      console.error(`Cartethyia update or restart failed: ${reason}`);
      if (!closing && gateway === null) {
        try {
          gateway = await startGateway(port, drainToken);
        } catch {
          await close(1);
        }
      }
      if (!closing) {
        update.title = "Update failed — retry";
        update.enabled = true;
        try {
          await tray.sendAction({ type: "update-item", item: update });
        } catch {
          // The tray may have failed while the update was being recovered.
        }
      }
    } finally {
      busy = false;
    }
  };

  await tray.onClick((event) => {
    void handleClick(event.item.title).catch(() => {
      console.error("The selected system-tray action failed.");
    });
  });
  tray.onExit(() => {
    trayExited = true;
    if (!closing) void close(1);
  });
  tray.onError(() => {
    console.error("The system-tray process failed; stopping Cartethyia.");
    if (!closing) void close(1);
  });
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());

  try {
    await waitForTray(tray);
    trayReady = true;
    // "Hide to tray" hands over a gateway that is already listening. Spawning a
    // second one would fail on the port, so an adopted tray only watches the
    // existing process and stops owning it when the menu process exits.
    if (process.env.CARTETHYIA_TRAY_ADOPT_RUNNING === "1") {
      reportTrayStartup({ status: "ready", url: dashboardUrl });
      console.log(`Cartethyia is running at ${dashboardUrl}`);
      void refreshVersion();
      while (!closing) await Bun.sleep(500);
      return;
    }
    gateway = await startGateway(port, drainToken);
    reportTrayStartup({ status: "ready", url: dashboardUrl });
    console.log(`Cartethyia is running at ${dashboardUrl}`);
    void refreshVersion();

    while (!closing) {
      const current: ReturnType<typeof Bun.spawn> | null = gateway;
      if (!current) {
        await Bun.sleep(100);
        continue;
      }
      const code = await current.exited;
      if (gateway !== current || closing) continue;
      gateway = null;
      console.error(`Cartethyia exited with code ${code}.`);
      await close(code ?? 1);
    }
  } catch (error) {
    await close(1);
    throw error;
  }
}

async function main(): Promise<void> {
  assertBunVersion();
  const [command] = process.argv.slice(2);
  if (command === "setup" || command === "start" || command === "tray" || command === "menu" || command === "stop") {
    await loadUserConfig();
  }

  switch (command) {
    case "setup": {
      const { setup } = await import("./setup");
      await setup();
      return;
    }
    case "start":
      await import("../../src/main");
      return;
    case "menu":
      await startMenu();
      return;
    case "tray":
      await startTray();
      return;
    case "stop":
      process.exitCode = await stopRunningGateway();
      return;
    case "update": {
      const code = await npmUpdate();
      if (code !== 0) process.exitCode = code;
      else console.log("Cartethyia is up to date.");
      return;
    }
    case "--help":
    case "-h":
    case undefined:
      console.log(HELP);
      return;
    default:
      console.error(`Unknown command: ${command}\n\n${HELP}`);
      process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown error";
  if (process.argv[2] === "tray") reportTrayStartup({ status: "failed", message });
  console.error(`Cartethyia failed: ${message}`);
  process.exitCode = 1;
});
