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
 *
 * The gateway it starts is detached, which is what makes the health poll below
 * necessary — see {@link TRAY_HEALTH_POLL_MS}.
 */

/**
 * How often the tray asks whether the gateway is still answering.
 *
 * 10 s: often enough that an operator who stops the gateway by hand sees the
 * icon go away, and far below the cost of a request. A detached gateway can no
 * longer be waited on, so this poll is the only signal left.
 */
const TRAY_HEALTH_POLL_MS = 10_000;

/**
 * Consecutive misses to forgive before a dead gateway closes the tray.
 *
 * One refusal is not a stopped gateway — a probe can lose a race with startup
 * or a slow request — and closing the icon on one would make startup feel
 * random.
 */
const TRAY_HEALTH_MISSES_BEFORE_CLOSE = 3;

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
    // The tray has no terminal of its own, so these instructions are only
    // visible when it was started from one. Hold that terminal open long
    // enough to copy the command, then exit.
    await new Promise<void>((resolve) => setTimeout(resolve, 180_000));
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
    // Detached, unlike every other caller: the gateway must outlive this
    // process. Attached, it dies with the tray — and the tray dies with the
    // terminal that launched it, so closing that terminal took the gateway
    // down too and "Hide to tray" left nothing serving. `stopGateway` drains
    // over HTTP before it ever reaches for `kill()`, so detaching costs the
    // exit path nothing: the tray can still stop the gateway on Exit.
    gateway = await startGateway(port, drainToken, { detached: true });
    // The launcher that spawned this tray is blocked on a signal file: it
    // cannot read our stdio, because the tray is detached. Without this write
    // it waits out its 60 s deadline and reports a failure for a tray that is
    // running fine.
    reportTrayStartup({ status: "ready", url: dashboardUrl });
    console.log(`Cartethyia is running at ${dashboardUrl}`);
    void refreshVersion();

    let misses = 0;
    // A detached child's `exited` never settles on Windows, so the old
    // `await current.exited` would have parked here forever and the tray would
    // never notice the gateway going away. Poll its health endpoint instead:
    // that answers for a process we no longer own, which is the whole point of
    // detaching it. The probe is the same one startup used, so a gateway that
    // is up reads as up regardless of who spawned it.
    while (!closing) {
      await Bun.sleep(TRAY_HEALTH_POLL_MS);
      if (closing || gateway === null) continue;
      const alive = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(2_000),
      }).then((response) => response.ok).catch(() => false);
      if (alive) {
        misses = 0;
        continue;
      }
      misses += 1;
      if (misses < TRAY_HEALTH_MISSES_BEFORE_CLOSE) continue;
      gateway = null;
      console.error("Cartethyia stopped answering; the tray is closing.");
      await close(1);
    }
  } catch (error) {
    await close(1);
    throw error;
  }
}
