// Registers the tray with the OS login/startup facility.
//
// The tray only runs while someone starts it, so a gateway that is meant to be
// always-on needs the OS to start it. Each platform has its own place for that,
// and they differ in what "disable" means:
//
// - **Windows** — a value under `HKCU\\Software\\Microsoft\\Windows\\
//   CurrentVersion\\Run`. Task Manager's Startup tab lists it, so an operator
//   can disable it there without touching the registry by hand.
// - **macOS** — a launch agent plist in `~/Library/LaunchAgents`.
// - **Linux** — a `.desktop` file in `~/.config/autostart` (the freedesktop
//   spec, honoured by every mainstream desktop).
//
// This only ever writes the *user's* own startup location, never a system one,
// so nothing here needs elevation and nothing here is forced on: removing the
// entry is the documented way to turn it off, and the tray itself keeps working
// when started by hand.

import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

/** The launch label, used as the registry value name, plist label and file name. */
const APP_ID = "cartethyia-tray";

export interface AutostartState {
  readonly platform: string;
  readonly enabled: boolean;
  /** Where the entry lives, for the operator who wants to remove it by hand. */
  readonly location: string;
  /** Why it is not supported here, when it is not. */
  readonly reason?: string;
}

/**
 * The command the OS should run.
 *
 * Quoted once here rather than at each call site: the Windows registry value,
 * the plist arguments and the desktop `Exec` line each parse spaces
 * differently, and a path under `C:\\Users\\First Last\\...` silently becomes
 * two arguments otherwise.
 */
function commandFor(executable: string, args: readonly string[]): string {
  const quoted = /\s/.test(executable) ? `"${executable}"` : executable;
  return [quoted, ...args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg))].join(" ");
}

function windowsCommand(command: string): string[] {
  return [
    "reg",
    "add",
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
    "/v",
    APP_ID,
    "/t",
    "REG_SZ",
    "/d",
    command,
    "/f",
  ];
}

function launchAgentsPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${APP_ID}.plist`);
}

/** Escapes the five entities XML defines, so a path cannot break the plist. */
function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function plistFor(executable: string, args: readonly string[]): string {
  const programArgs = [executable, ...args]
    .map((part) => `    <string>${xmlEscape(part)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${APP_ID}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <!-- Restart only if it exits on its own; a crash loop is not a reason to
       respawn forever, and a stopped tray should stay stopped. -->
  <key>KeepAlive</key>
  <false/>
</dict>
</plist>
`;
}

function desktopEntryFor(command: string): string {
  return `[Desktop Entry]
Type=Application
Name=Cartethyia Tray
Exec=${command}
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
`;
}

/**
 * Enables autostart for the tray.
 *
 * Returns the resulting state rather than throwing, because a failure here must
 * not abort startup: the tray is still perfectly usable when launched by hand,
 * and an operator who cannot write to their own startup folder has a reason we
 * should report, not crash on.
 */
export async function enableAutostart(
  executable: string,
  args: readonly string[],
): Promise<AutostartState> {
  const os = platform();
  const command = commandFor(executable, args);

  if (os === "win32") {
    const proc = Bun.spawn(windowsCommand(command), { stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    return {
      platform: os,
      enabled: code === 0,
      location: "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
      ...(code === 0
        ? {}
        : { reason: "reg add failed; the entry can be added by hand or via Task Manager" }),
    };
  }

  if (os === "darwin") {
    const path = launchAgentsPath();
    try {
      mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
      writeFileSync(path, plistFor(executable, args), "utf8");
      return { platform: os, enabled: true, location: path };
    } catch (error) {
      return {
        platform: os,
        enabled: false,
        location: path,
        reason: error instanceof Error ? error.message : "could not write the launch agent",
      };
    }
  }

  if (os === "linux") {
    const dir = join(homedir(), ".config", "autostart");
    const path = join(dir, `${APP_ID}.desktop`);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, desktopEntryFor(command), "utf8");
      return { platform: os, enabled: true, location: path };
    } catch (error) {
      return {
        platform: os,
        enabled: false,
        location: path,
        reason: error instanceof Error ? error.message : "could not write the desktop entry",
      };
    }
  }

  return {
    platform: os,
    enabled: false,
    location: "",
    reason: `no supported autostart location on ${os}`,
  };
}

/** Removes the entry, so the tray stops starting with the session. */
export async function disableAutostart(): Promise<AutostartState> {
  const os = platform();

  if (os === "win32") {
    const proc = Bun.spawn(
      [
        "reg",
        "delete",
        "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
        "/v",
        APP_ID,
        "/f",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    // `reg delete` exits non-zero when the value was already absent, which is
    // the state the caller wanted anyway, so the code is not read.
    await proc.exited;
    return {
      platform: os,
      enabled: false,
      location: "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
    };
  }

  const path = os === "darwin" ? launchAgentsPath() : join(homedir(), ".config", "autostart", `${APP_ID}.desktop`);
  try {
    if (existsSync(path)) rmSync(path);
    return { platform: os, enabled: false, location: path };
  } catch (error) {
    return {
      platform: os,
      enabled: false,
      location: path,
      reason: error instanceof Error ? error.message : "could not remove the entry",
    };
  }
}

/** Whether an entry is currently registered. */
export function autostartStatus(): AutostartState {
  const os = platform();
  if (os === "win32") {
    // Reading the registry needs a process, so this is reported as unknown
    // rather than guessed; `disableAutostart` is idempotent either way.
    return {
      platform: os,
      enabled: false,
      location: "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
      reason: "status is not readable synchronously; enable or disable to set it",
    };
  }
  const path = os === "darwin" ? launchAgentsPath() : join(homedir(), ".config", "autostart", `${APP_ID}.desktop`);
  return { platform: os, enabled: existsSync(path), location: path };
}
