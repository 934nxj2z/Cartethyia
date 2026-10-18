import { existsSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isNewerRelease } from "../../src/console/updates/version-compare";
import { PACKAGE_ROOT, resolvePackagePath, resolveUserConfigDir } from "../../src/config/package-paths";
import { resolvePort } from "../../src/config/runtime";
import { MINIMUM_BUN_VERSION, bunVersionAtLeast } from "../shared/env";
import { chooseFromMenu, confirmByTyping, confirmStep } from "./menu";
import { ensureDrainToken, readPersistedDrainToken } from "./runtime-state";
import { createTray } from "./tray";
import { readInstalledVersion, readLatestPublishedVersion } from "./version";
import { renderWordmark } from "./wordmark";

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
your terminal — Open Console, Reset password, Backup, Visit
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



async function startGateway(
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
      `Cartethyia is already running on port ${port}. Use \`cartethyia stop\` to stop it, or open http://127.0.0.1:${port}/console.`,
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
      // Attached by default. A detached child cannot be killed from an `exit`
      // handler on Windows (measured: kill() runs, the gateway keeps serving),
      // and a terminal's Ctrl-C only reaches children in the same process
      // group. Staying attached means Ctrl-C and the `exit` backstop both stop
      // the gateway. "Hide to tray" passes detached: true because that gateway
      // must outlive this process.
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



/**
 * The default `carte` experience: start the gateway, then offer an arrow-key
 * menu. This needs no desktop environment, so it works over SSH, on a headless
 * box, and on Windows where the tray icon lands in the hidden-icons overflow
 * and is never seen. `carte --tray` opts into the icon instead.
 */
async function startMenu(): Promise<void> {
  // A fresh install has no config file yet, and the gateway refuses to boot
  // without CARTETHYIA_DB_MODE — which surfaced as a stack trace about a
  // missing database mode rather than "you have not set this up". Run setup
  // first, the way `carte` is expected to behave on a new install.
  const { ENV_PATH, readEnvFile } = await import("../shared/env");
  const configured = existsSync(ENV_PATH) && (await readEnvFile(ENV_PATH)).CARTETHYIA_DB_MODE;
  if (!configured) {
    console.log(
      existsSync(ENV_PATH)
        ? "Cartethyia is missing its database mode. Starting setup.\n"
        : "Cartethyia is not set up yet. Starting setup.\n",
    );
    const { setup } = await import("./setup");
    await setup();
    const after = existsSync(ENV_PATH) ? (await readEnvFile(ENV_PATH)).CARTETHYIA_DB_MODE : undefined;
    if (!after) {
      console.error(
        `Setup did not record CARTETHYIA_DB_MODE in ${ENV_PATH}; run \`cartethyia setup\` and try again.`,
      );
      process.exitCode = 1;
      return;
    }
    process.env.CARTETHYIA_DB_MODE = after;
  }

  const port = resolvePort();
  const drainToken = ensureDrainToken();
  const dashboardUrl = `http://127.0.0.1:${port}/console`;
  const repositoryUrl = "https://github.com/risunCode/cartethyia";
  const currentVersion = await readInstalledVersion();

  // The gateway is detached and holds no stdio, so this process owns the
  // terminal outright: nothing else can consume the keys the menu needs. The
  // drain token is persisted before the menu opens because `cartethyia stop`
  // runs in a later shell and has no other handle on this process.
  const gateway = await startGateway(port, drainToken);
  gateway.unref();

  let stopping = false;
  let handedOff = false;
  const shutDown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await stopGateway(gateway, port, drainToken);
  };
  // Ctrl-C has to stop the gateway, and the drain endpoint cannot be called
  // from an exit path: it is async, and enquirer's own Ctrl-C handler calls
  // process.exit(130) while a prompt is live. So the gateway is a child in this
  // process group — a terminal's Ctrl-C signals the whole group, and the
  // gateway drains through the SIGINT handler it already has in src/main.ts —
  // and `process.on("exit")` is the synchronous backstop for every other way
  // this process can end (a closed terminal, a crash, a signal Bun cannot
  // deliver on Windows). That handler can only call synchronous APIs, which is
  // why it signals the child rather than awaiting the drain endpoint.
  // `handedOff` is set by "Hide to tray": the gateway is being given to a tray
  // that will own it, so this process must not kill it on the way out.
  process.on("exit", () => {
    if (stopping || handedOff) return;
    try {
      gateway.kill();
    } catch {
      // Already gone; nothing to stop.
    }
  });
  const interrupt = async (): Promise<void> => {
    process.stdout.write("\u001b[2J\u001b[H");
    console.log("Stopping Cartethyia…");
    await shutDown();
    process.exit(0);
  };
  process.on("SIGTERM", () => void interrupt());
  process.on("SIGINT", () => void interrupt());

  let latestVersion = await readLatestPublishedVersion();
  let running = true;

  const header = [...renderWordmark(), `Cartethyia ${currentVersion} \u00b7 ${dashboardUrl}`];

  while (running) {
    const upToDate = latestVersion === null || !isNewerRelease(currentVersion, latestVersion);
    const updateLabel =
      latestVersion === null
        ? "Check for updates"
        : upToDate
          ? `Up to date (${currentVersion})`
          : `Update to ${latestVersion}`;

    const actions: readonly (() => Promise<void>)[] = [
      async () => openUrl(dashboardUrl),
      async () => {
        // Deleting the console account is the only real password recovery:
        // /change-password needs the current password, and first-boot setup
        // only runs when no user exists. Removing the user puts the wizard
        // back. Providers, keys, and routing are untouched.
        console.log("");
        console.log("This deletes every console account and its sessions.");
        console.log("The next visit to /console asks you to create a new one.");
        console.log("Providers, API keys, and routing are not touched.");
        console.log("");
        if (!(await confirmStep("Continue with the reset?"))) {
          console.log("Cancelled.");
          return;
        }
        if (!(await confirmByTyping("RESET", "Confirm deleting the console account"))) {
          console.log("Cancelled.");
          return;
        }
        const status = await resetConsoleAccount(port, drainToken);
        console.log(
          status === 0
            ? `Console account removed. Open ${dashboardUrl} to create a new one.`
            : "Reset failed; see the gateway log.",
        );
      },
      async () => {
        // Export straight to the download directory. The console page asks for
        // the operator password, which is exactly the thing a locked-out
        // operator does not have; the CLI already runs as the OS user who owns
        // the database, so the loopback token is the whole gate.
        const result = await exportBackup(port, drainToken);
        if (result === null) return;
        console.log(
          `Backup written to ${result.path} (${(result.bytes / 1024).toFixed(1)} KiB, ${Object.keys(result.counts).length} tables).`,
        );
        console.log("Telemetry is not included: it is per-request history, not configuration.");
      },
      async () => openUrl(repositoryUrl),
      async () => {
        if (upToDate) return;
        // npm cannot replace this package's directory while this process is
        // running out of it: on Windows the rename fails with EBUSY and npm
        // exits 14. Even with the gateway stopped, the CLI itself is executing
        // from that directory, so an in-process install can never succeed.
        // Print the command and exit, the way 9router does.
        await shutDown();
        console.log("");
        console.log(`Update available: ${currentVersion} \u2192 ${latestVersion}`);
        console.log("");
        console.log("Run this now that Cartethyia has stopped:");
        console.log("");
        console.log(`   ${updateCommand()}`);
        console.log("");
        running = false;
        process.exitCode = 0;
        return;
      },
      async () => {
        // Start a detached `tray` process that owns the gateway from scratch,
        // then drain this one so the new process can claim the port. This is
        // the pattern 9router uses and it is simpler than handing a live
        // gateway between processes: the tray is a normal first-class run, not
        // an adopted orphan, so Exit and update behave the same whether the
        // gateway was started here or from `carte --tray`.
        console.log("Starting the tray in the background…");
        const tray = spawn(
          process.execPath,
          ["run", resolvePackagePath("scripts", "cli", "cli.ts"), "tray"],
          {
            cwd: tmpdir(),
            detached: true,
            stdio: "ignore",
            windowsHide: true,
            env: process.env,
          },
        );
        tray.unref();
        running = false;
        stopping = true;
        handedOff = true;
        await shutDown();
        console.log(`Cartethyia is running in the background at ${dashboardUrl}.`);
        console.log("The tray icon owns it. Stop it with: cartethyia stop");
      },
      async () => {
        running = false;
      },
    ];

    const choice = await chooseFromMenu(header, [
        { kind: "action", label: "Open Console", hint: `browser \u00b7 ${dashboardUrl}` },
        { kind: "action", label: "Reset console password", hint: "deletes the account" },
        { kind: "action", label: "Backup", hint: "export config to Downloads" },
        { kind: "action", label: "Visit repository", hint: "github.com/risunCode/cartethyia" },
        { kind: "action", label: updateLabel, hint: upToDate ? "no update available" : "installs now" },
        { kind: "action", label: "Hide to tray", hint: "keep the gateway running" },
        { kind: "rule" },
        { kind: "action", label: "Exit", hint: "stop the gateway" },
      ],
    );
    if (choice === -1) break;
    const action = actions[choice];
    if (action) await action();
  }
  // "Hide to tray" has already given the gateway to the tray. Draining here
  // would stop the very process the tray just adopted, which is why the menu
  // appeared to hand over a gateway that was not listening.
  if (handedOff) return;
  await shutDown();
}

/**
 * Asks the gateway to write a gzipped config backup into the download
 * directory. Returns the written path and counts, or null when it failed.
 *
 * The file is produced by the gateway, not here: the gateway owns the database
 * connection and the schema is dialect-dependent, so reading the tables from
 * this process would need a second implementation of both.
 */
/** The command an operator runs to update, printed instead of run in-process. */
function updateCommand(): string {
  return "npm install --global cartethyia@latest --prefer-online";
}

async function exportBackup(
  port: number,
  token: string,
): Promise<{ path: string; bytes: number; counts: Record<string, number> } | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/admin/export-backup`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-drain-token": token },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.error(`The gateway refused the backup (HTTP ${response.status}). ${detail}`.trim());
      return null;
    }
    return (await response.json()) as {
      path: string;
      bytes: number;
      counts: Record<string, number>;
    };
  } catch {
    console.error("Could not reach the gateway. Is it still running?");
    return null;
  }
}

/**
 * Posts the console-account reset to the running gateway.
 *
 * The reset has to go through the gateway, not the database file, because the
 * gateway holds the connection and the schema is dialect-dependent. Returns 0
 * on success and 1 on any failure so the caller can print one line either way.
 */
async function resetConsoleAccount(port: number, token: string): Promise<number> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/admin/reset-console-account`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-drain-token": token },
      body: JSON.stringify({ confirm: "RESET" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.error(`The gateway refused the reset (HTTP ${response.status}). ${detail}`.trim());
      return 1;
    }
    return 0;
  } catch {
    console.error("Could not reach the gateway. Is it still running?");
    return 1;
  }
}

/**
 * Asks a gateway we do not own to drain, then waits for its port to close.
 *
 * Used by `cartethyia stop` and by an adopted tray's Exit: in both cases the
 * gateway is a separate process, so the loopback endpoint is the only handle.
 * Returns 0 only once the port stops answering — a drain that is accepted but
 * leaves the listener up is not a stop.
 */
async function drainThroughEndpoint(port: number, token: string): Promise<number> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/admin/drain`, {
      method: "POST",
      headers: { "x-drain-token": token },
      signal: AbortSignal.timeout(3_000),
    });
    if (response.status !== 202) {
      console.error(
        response.status === 401
          ? `The gateway on port ${port} rejected the drain token. It was started by a different install; stop it where it was started.`
          : `The gateway refused the drain request (HTTP ${response.status}).`,
      );
      return 1;
    }
  } catch {
    console.error(`No gateway is listening on port ${port}. It may already be stopped.`);
    return 1;
  }

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const alive = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(500),
    })
      .then(() => true)
      .catch(() => false);
    if (!alive) return 0;
    await Bun.sleep(250);
  }
  console.error(
    `The gateway accepted the drain but is still answering on port ${port} after 20 seconds.`,
  );
  return 1;
}

/**
 * Stops a running gateway through its loopback drain endpoint.
 *
 * That process is not a child of this one, so it cannot be signalled directly —
 * the token in the config directory is the only handle. A 202 means the drain
 * was accepted, not that the process is gone, so this waits for the port to
 * stop answering before reporting success; a `stop` that returns while the
 * gateway is still serving is worse than one that fails.
 */
async function stopRunningGateway(): Promise<number> {
  const port = resolvePort();
  const token = readPersistedDrainToken();
  if (token === null) {
    console.error(
      "This install has no saved drain token, so there is no background gateway to stop. Start one with `carte`, or stop a foreground run with Ctrl-C.",
    );
    return 1;
  }
  const code = await drainThroughEndpoint(port, token);
  if (code === 0) console.log("Cartethyia stopped.");
  return code;
}


/**
 * Runs the gateway with a tray icon. The tray is platform-specific (`tray.ts`):
 * on Windows it is a PowerShell NotifyIcon, because a Node tray library leaves
 * an empty console tab open for the tray's whole lifetime, and that window is
 * owned by Windows Terminal — not by this process, so it cannot be found and
 * hidden from inside.
 */
async function startTray(): Promise<void> {
  const port = resolvePort();
  const drainToken = ensureDrainToken();
  const dashboardUrl = `http://127.0.0.1:${port}/console`;
  const repositoryUrl = "https://github.com/risunCode/cartethyia";
  const currentVersion = await readInstalledVersion();

  let gateway: Bun.Subprocess | null = null;
  let closing = false;
  let busy = false;
  let resetArmed = false;
  let closePromise: Promise<void> | undefined;

  const tray = createTray({
    iconPath: resolvePackagePath(
      "tray-assets",
      process.platform === "win32" ? "cartethyia.ico" : "cartethyia.png",
    ),
    tooltip: `Cartethyia ${currentVersion}`,
    items: [
      { kind: "action", id: "repository", title: "Visit repository" },
      { kind: "action", id: "update", title: `Cartethyia ${currentVersion} \u00b7 checking\u2026`, enabled: false },
      { kind: "separator" },
      { kind: "action", id: "console", title: `Open Console \u00b7 ${dashboardUrl}` },
      { kind: "action", id: "reset", title: "Reset console password" },
      { kind: "action", id: "backup", title: "Backup" },
      { kind: "separator" },
      { kind: "action", id: "exit", title: "Exit" },
    ],
    onSelect: (id: string) => void handleSelect(id),
    onExit: () => void close(1),
  });

  const close = (exitCode = 0): Promise<void> => {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      const current: Bun.Subprocess | null = gateway;
      gateway = null;
      if (current) await stopGateway(current, port, drainToken);
      await tray.close();
      process.exitCode = exitCode;
    })();
    return closePromise;
  };

  const refreshVersion = async (): Promise<void> => {
    const fetched = await readLatestPublishedVersion();
    if (closing) return;
    if (fetched === null) {
      tray.update("update", `Cartethyia ${currentVersion} \u00b7 check for updates`, true);
      return;
    }
    const newer = isNewerRelease(currentVersion, fetched);
    tray.update(
      "update",
      newer
        ? `Cartethyia ${currentVersion} \u00b7 update to ${fetched}`
        : `Cartethyia ${currentVersion} \u00b7 up to date`,
      newer,
    );
  };

  const runUpdate = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    // npm cannot replace this package's directory while this process is
    // running out of it: on Windows the rename fails with EBUSY and npm exits
    // 14, and stopping only the gateway is not enough because the tray itself
    // is executing from that directory. Stop everything and print the command.
    const latest = await readLatestPublishedVersion();
    await close();
    console.log("");
    console.log(`Update available: ${currentVersion} \u2192 ${latest ?? "latest"}`);
    console.log("");
    console.log("Run this now that Cartethyia has stopped:");
    console.log("");
    console.log(`   ${updateCommand()}`);
    console.log("");
    process.exit(0);
  };

  async function handleSelect(id: string): Promise<void> {
    if (closing) return;
    if (id === "exit") return void (await close());
    if (id === "console") return void (await openUrl(dashboardUrl));
    if (id === "repository") return void (await openUrl(repositoryUrl));
    if (id === "backup") {
      const result = await exportBackup(port, drainToken);
      if (result !== null) {
        console.log(
          `Backup written to ${result.path} (${(result.bytes / 1024).toFixed(1)} KiB). Telemetry is not included.`,
        );
      }
      return;
    }
    if (id === "reset") {
      // A tray click cannot ask for the typed confirmation the menu uses, so
      // the first click arms the action and the second one runs it.
      if (!resetArmed) {
        resetArmed = true;
        tray.update("reset", "Reset console password \u00b7 click again to delete", true);
        return;
      }
      resetArmed = false;
      tray.update("reset", "Reset console password", true);
      await resetConsoleAccount(port, drainToken);
      return;
    }
    if (id === "update") await runUpdate();
  }

  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());

  try {
    await tray.ready();
    gateway = await startGateway(port, drainToken);
    console.log(`Cartethyia is running at ${dashboardUrl}`);
    void refreshVersion();

    while (!closing) {
      const current: Bun.Subprocess | null = gateway;
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
    case "start": {
      // A foreground run still needs a drain token on disk: `cartethyia stop`
      // in another shell has no other handle on it, and without the token the
      // gateway has no /admin/drain route at all.
      process.env.CARTETHYIA_DRAIN_TOKEN ??= ensureDrainToken();
      await import("../../src/main");
      return;
    }
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
      // Running the install from here can never work: this process is itself
      // executing out of the package directory npm would have to rename, and on
      // Windows that rename fails with EBUSY. Stop any running gateway and print
      // the command instead.
      process.exitCode = await stopRunningGateway();
      console.log("");
      console.log("Now run:");
      console.log("");
      console.log(`   ${updateCommand()}`);
      console.log("");
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
