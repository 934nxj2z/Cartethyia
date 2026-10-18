import { isNewerRelease } from "../../../src/console/updates/version-compare";
import { resolvePackagePath } from "../../../src/config/package-paths";
import { resolvePort } from "../../../src/config/runtime";
import { ensureDrainToken } from "../gateway/drain-token";
import { startGateway } from "../gateway/spawn";
import { stopGateway } from "../gateway/stop";
import { readInstalledVersion, readLatestPublishedVersion } from "../support/version";
import { reportTrayStartup } from "../support/startup-signal";
import { createTray } from "../tray";
import { openUrl } from "../ui/background";
import { exportBackup, resetConsoleAccount } from "./admin";
import { printUpdateInstructions } from "./update";

/**
 * Runs the gateway with a tray icon. The tray is platform-specific (`tray/`):
 * on Windows it is a PowerShell NotifyIcon, because a Node tray library leaves
 * an empty console tab open for the tray's whole lifetime, and that window is
 * owned by Windows Terminal — not by this process, so it cannot be found and
 * hidden from inside.
 */
export async function startTray(): Promise<void> {
  const port = resolvePort();
  const drainToken = ensureDrainToken();
  const dashboardUrl = `http://127.0.0.1:${port}/console`;
  const repositoryUrl = "https://github.com/risunCode/cartethyia";
  const currentVersion = await readInstalledVersion();

  let gateway: Bun.Subprocess | null = null;
  let closing = false;
  let busy = false;
  let resetArmed = false;
  let latestVersion: string | null = null;
  let closePromise: Promise<void> | undefined;

  const tray = createTray({
    iconPath: resolvePackagePath(
      "scripts",
      "cli",
      "tray",
      "assets",
      process.platform === "win32" ? "cartethyia.ico" : "cartethyia.png",
    ),
    tooltip: `Cartethyia ${currentVersion}`,
    items: [
      { kind: "action", id: "update", title: `Cartethyia ${currentVersion} \u00b7 checking\u2026`, enabled: true },
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
    latestVersion = fetched;
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
      // Always clickable: the row opens the repository, and only offers the
      // update command when there is something newer.
      true,
    );
  };

  const runUpdate = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    const latest = await readLatestPublishedVersion();
    await close();
    printUpdateInstructions(currentVersion, latest);
    process.exit(0);
  };

  async function handleSelect(id: string): Promise<void> {
    if (closing) return;
    if (id === "exit") return void (await close());
    if (id === "console") return void (await openUrl(dashboardUrl));
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
    if (id === "update") {
      // Nothing to install: the row is the way to the repository instead.
      if (latestVersion === null || !isNewerRelease(currentVersion, latestVersion)) {
        await openUrl(repositoryUrl);
        return;
      }
      await runUpdate();
    }
  }

  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());

  try {
    await tray.ready();
    gateway = await startGateway(port, drainToken);
    // The launcher that spawned this tray is blocked on a signal file: it
    // cannot read our stdio, because the tray is detached. Without this write
    // it waits out its 60 s deadline and reports a failure for a tray that is
    // running fine.
    reportTrayStartup({ status: "ready", url: dashboardUrl });
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
