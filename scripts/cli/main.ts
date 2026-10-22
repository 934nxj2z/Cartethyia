import { mkdirSync } from "node:fs";
import { resolveUserConfigDir } from "../../src/config/package-paths";
import { ENV_PATH, readEnvFile } from "./support/env";
import { MINIMUM_BUN_VERSION, assertBunVersion } from "./support/bun";
import { printUpdateInstructions, runDetachedUpdate } from "./command/update";
import { reportTrayStartup } from "./support/startup-signal";

process.env.CARTETHYIA_CONFIG_DIR ??= resolveUserConfigDir();

const HELP = `Cartethyia ${MINIMUM_BUN_VERSION}+ (Bun is required)

Usage:
  carte                  start, then show an arrow-key menu (no GUI needed)
  carte --tray           start with a system-tray icon instead
  cartethyia setup [--non-interactive]
  cartethyia start
  cartethyia menu
  cartethyia doctor
  cartethyia update

carte starts the gateway in the background and leaves only the console menu on
your terminal — Open Console, Reset password, Backup, Update, Hide to tray,
Exit. Arrow keys and Enter; no desktop environment needed, so it works over SSH
and headless. Exiting the menu drains the gateway.
carte --tray uses a system-tray icon instead, which needs a graphical session.
Stop a gateway whose terminal is gone with Ctrl-C in that terminal.
Setup explains Lite (embedded SQLite) and Full (external PostgreSQL), then saves
configuration under the current user's Cartethyia config directory.
`;

/** Loads the user's `.env` into the environment without overriding it. */
async function loadUserConfig(): Promise<void> {
  const configDir = process.env.CARTETHYIA_CONFIG_DIR;
  if (!configDir) throw new Error("Cartethyia config directory could not be resolved");
  mkdirSync(configDir, { recursive: true });
  const values = await readEnvFile(ENV_PATH);
  for (const [key, value] of Object.entries(values)) {
    if (!process.env[key]) process.env[key] = value;
  }
}

async function main(): Promise<void> {
  assertBunVersion();
  const [command] = process.argv.slice(2);
  if (command === "setup" || command === "start" || command === "tray" || command === "menu" || command === "doctor") {
    await loadUserConfig();
  }

  switch (command) {
    case "setup": {
      const { setup } = await import("./command/setup");
      await setup();
      return;
    }
    case "start": {
      const { startForeground } = await import("./command/start");
      await startForeground();
      return;
    }
    case "menu": {
      const { startMenu } = await import("./command/console-menu");
      await startMenu();
      return;
    }
    case "tray": {
      const { startTray } = await import("./command/tray");
      await startTray();
      return;
    }
    case "autostart": {
      const { enableAutostart, disableAutostart, autostartStatus } = await import("./autostart");
      const arg = Bun.argv[3]?.trim();
      if (arg === "off" || arg === "disable") {
        const state = await disableAutostart();
        console.log(`Autostart disabled (${state.location || state.platform}).`);
        return;
      }
      if (arg === "status") {
        const state = autostartStatus();
        console.log(
          `Autostart: ${state.enabled ? "enabled" : "not enabled"} — ${state.location || state.platform}` +
            (state.reason ? ` (${state.reason})` : ""),
        );
        return;
      }
      // The tray is what autostart launches: a gateway alone has no session to
      // attach to and no icon to show.
      const state = await enableAutostart(process.execPath, [Bun.argv[1] ?? "carte", "tray"]);
      console.log(
        state.enabled
          ? `Autostart enabled — ${state.location}`
          : `Autostart not enabled: ${state.reason ?? "unknown reason"}`,
      );
      return;
    }
    case "doctor": {
      const { doctor } = await import("./command/doctor");
      await doctor();
      return;
    }
    case "update":
      runDetachedUpdate();
      printUpdateInstructions("this install", null);
      return;
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
