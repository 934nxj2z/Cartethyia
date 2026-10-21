import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isNewerRelease } from "../../../src/console/updates/version-compare";
import { resolvePackagePath } from "../../../src/config/package-paths";
import { resolvePort } from "../../../src/config/runtime";
import { ensureDrainToken } from "../gateway/drain-token";
import { startGateway } from "../gateway/spawn";
import { stopGateway } from "../gateway/stop";
import { ENV_PATH, readEnvFile } from "../support/env";
import { readInstalledVersion, readLatestPublishedVersion } from "../support/version";
import { launchBackgroundWithStatus, openUrl } from "../ui/background";
import { chooseFromMenu, confirmByTyping, confirmStep } from "../ui/prompt";
import { renderWordmark } from "../ui/wordmark";
import { exportBackup, resetConsoleAccount } from "./admin";
import { updateCommand } from "./update";

/**
 * The default `carte` experience: start the gateway, then offer an arrow-key
 * menu. This needs no desktop environment, so it works over SSH, on a headless
 * box, and on Windows where the tray icon lands in the hidden-icons overflow
 * and is never seen. `carte --tray` opts into the icon instead.
 */
export async function startMenu(): Promise<void> {
  // A fresh install has no config file yet, and the gateway refuses to boot
  // without CARTETHYIA_DB_MODE — which surfaced as a stack trace about a
  // missing database mode rather than "you have not set this up". Run setup
  // first, the way `carte` is expected to behave on a new install.
  const configured = existsSync(ENV_PATH) && (await readEnvFile(ENV_PATH)).CARTETHYIA_DB_MODE;
  if (!configured) {
    console.log(
      existsSync(ENV_PATH)
        ? "Cartethyia is missing its database mode. Starting setup.\n"
        : "Cartethyia is not set up yet. Starting setup.\n",
    );
    // Dynamic on purpose: `setup` pulls in the whole wizard and the database
    // mode resolver, and it is only reachable on a first run. A static import
    // would pay that cost on every `carte`, which is the one path that has to
    // stay fast.
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
  const currentVersion = await readInstalledVersion();

  // The gateway starts in the background: the menu is usable before it has
  // finished booting, and awaiting it cost ~670 ms of blank terminal on every
  // start. `ready` resolves when the health probe passes; actions that need a
  // listening gateway await it, so nothing races.
  const ready = startGateway(port, drainToken);
  let gateway: Bun.Subprocess | null = null;
  void ready.then((child) => {
    gateway = child;
    child.unref();
  }).catch((error: unknown) => {
    console.error(
      `The gateway did not start: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  });

  let stopping = false;
  let handedOff = false;
  const shutDown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    const child = gateway ?? (await ready.catch(() => null));
    if (child) await stopGateway(child, port, drainToken);
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
    if (stopping || handedOff || gateway === null) return;
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

    // Anything that talks to the gateway waits for it to be listening; the menu
    // itself does not.
    const whenReady = async (): Promise<void> => {
      await ready.catch(() => undefined);
    };

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
        await whenReady();
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
        await whenReady();
        const result = await exportBackup(port, drainToken);
        if (result === null) return;
        console.log(
          `Backup written to ${result.path} (${(result.bytes / 1024).toFixed(1)} KiB, ${Object.keys(result.counts).length} tables).`,
        );
        console.log("Telemetry is not included: it is per-request history, not configuration.");
      },
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
        console.log("This terminal will stay open for 180s so you can copy the command, then exit.");
        running = false;
        await new Promise<void>((resolve) => setTimeout(resolve, 180_000));
        console.log("Session ended. Run the command above to update.");
        process.exit(0);
      },
      async () => {
        // Drain first, then start the tray.
        //
        // The tray's own startup probe refuses to boot when the port is busy,
        // so starting it before this process has let go made it fail with
        // "already running on port" every time — while the menu still printed
        // that everything was running, because a detached child with no stdio
        // cannot report anything back. Releasing the port first is the fix, and
        // waiting on the child's signal is what stops the menu from claiming
        // success for a child that died.
        console.log("Stopping the gateway to free the port…");
        running = false;
        stopping = true;
        handedOff = true;
        await shutDown();
        console.log("Starting the tray in the background…");
        const signalPath = join(tmpdir(), `cartethyia-tray-menu-${process.pid}-${randomUUID()}.json`);
        try {
          const url = await launchBackgroundWithStatus(
            ["run", resolvePackagePath("scripts", "cli", "main.ts"), "tray"],
            { signalPath },
          );
          console.log(`Cartethyia is running in the background at ${url || dashboardUrl}.`);
          console.log("The tray icon owns it; use Exit there to stop it.");
        } catch (error) {
          handedOff = false;
          console.error(
            `Could not hand off to the tray: ${error instanceof Error ? error.message : "unknown error"}`,
          );
          console.error("Cartethyia is stopped. Start it again from this menu.");
        }
      },
      async () => {
        running = false;
      },
    ];

    const choice = await chooseFromMenu(header, [
        { kind: "action", label: "Open Console", hint: `browser \u00b7 ${dashboardUrl}` },
        { kind: "action", label: "Reset console password", hint: "deletes the account" },
        { kind: "action", label: "Backup", hint: "export config to Downloads" },
        { kind: "action", label: updateLabel, hint: upToDate ? "open the repository" : "installs now" },
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
