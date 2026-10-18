import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import SysTray from "systray2";
import { resolvePackagePath } from "../../src/config/package-paths";

/**
 * One tray row. `action` rows report their id on click; separators are drawn
 * but never fire.
 */
export type TrayItem =
  | { readonly kind: "action"; readonly id: string; readonly title: string; readonly enabled?: boolean }
  | { readonly kind: "separator" };

export interface TrayOptions {
  readonly iconPath: string;
  readonly tooltip: string;
  readonly items: readonly TrayItem[];
  readonly onSelect: (id: string) => void;
  readonly onExit: () => void;
}

export interface Tray {
  /** Resolves once the icon is on screen and clicks can arrive. */
  ready(): Promise<void>;
  /** Replaces the title and enabled state of an existing row. */
  update(id: string, title: string, enabled?: boolean): void;
  setTooltip(text: string): void;
  /** Removes the icon. Idempotent. */
  close(): Promise<void>;
}

/**
 * Windows tray: a PowerShell NotifyIcon driven over JSON lines.
 *
 * `systray2` on Windows leaves the spawning process attached to a console, so
 * Windows Terminal keeps an empty tab open for the tray's whole lifetime — the
 * window cannot be hidden from inside the process because it is owned by the
 * terminal, and `MainWindowHandle` reads 0 so it cannot be found and closed
 * either. A PowerShell NotifyIcon started with `-WindowStyle Hidden` owns no
 * console at all, which is the only arrangement that shows an icon and no
 * window.
 */
class WindowsTray implements Tray {
  readonly #process: ChildProcess;
  readonly #onSelect: (id: string) => void;
  readonly #onExit: () => void;
  readonly #index = new Map<string, number>();
  #ready: Promise<void>;
  #closed = false;

  constructor(options: TrayOptions) {
    this.#onSelect = options.onSelect;
    this.#onExit = options.onExit;

    this.#process = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-WindowStyle",
        "Hidden",
        "-InputFormat",
        "Text",
        "-OutputFormat",
        "Text",
        "-File",
        resolvePackagePath("scripts", "cli", "tray.ps1"),
        "-IconPath",
        options.iconPath,
        "-Tooltip",
        options.tooltip,
      ],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );

    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.#ready = promise;

    const lines = createInterface({ input: this.#process.stdout! });
    lines.on("line", (line) => {
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event === null || typeof event !== "object" || !("type" in event)) return;
      if (event.type === "ready") {
        resolve();
        return;
      }
      if (event.type === "click" && "index" in event && typeof event.index === "number") {
        for (const [id, index] of this.#index) {
          if (index === event.index) {
            this.#onSelect(id);
            return;
          }
        }
      }
    });

    this.#process.once("error", reject);
    this.#process.once("exit", () => {
      if (!this.#closed) this.#onExit();
      reject(new Error("the tray process exited before it was ready"));
    });

    // Rows are added after "started": the script creates its NotifyIcon first
    // and would drop commands that arrive before it is listening.
    let index = 0;
    for (const item of options.items) {
      if (item.kind === "separator") {
        this.#send({ action: "add-item", index, title: "-", enabled: false });
        index += 1;
        continue;
      }
      this.#index.set(item.id, index);
      this.#send({ action: "add-item", index, title: item.title, enabled: item.enabled ?? true });
      index += 1;
    }
    this.#send({ action: "ready" });
  }

  #send(command: Record<string, unknown>): void {
    if (this.#closed || !this.#process.stdin?.writable) return;
    this.#process.stdin.write(`${JSON.stringify(command)}\n`, "utf8");
  }

  ready(): Promise<void> {
    return this.#ready;
  }

  update(id: string, title: string, enabled = true): void {
    const index = this.#index.get(id);
    if (index === undefined) return;
    this.#send({ action: "update-item", index, title, enabled });
  }

  setTooltip(text: string): void {
    this.#send({ action: "set-tooltip", text });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#send({ action: "kill" });
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.#process.kill();
        resolve();
      }, 1_500);
      this.#process.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

/**
 * macOS and Linux tray: `systray2` runs its own helper, and neither platform
 * attaches a console window to it, so the bundled tray is used as-is.
 */
class UnixTray implements Tray {
  readonly #tray: SysTray;

  constructor(options: TrayOptions) {
    this.#tray = new SysTray({
      menu: {
        icon: options.iconPath,
        title: "Cartethyia",
        tooltip: options.tooltip,
        items: options.items.map((item) =>
          item.kind === "separator"
            ? SysTray.separator
            : { title: item.title, tooltip: item.title, enabled: item.enabled ?? true },
        ),
      },
      copyDir: true,
    });
  }

  ready(): Promise<void> {
    return this.#tray.ready().then(() => undefined);
  }

  update(id: string, title: string, enabled = true): void {
    void id;
    void this.#tray.sendAction({ type: "update-item", item: { title, tooltip: title, enabled } });
  }

  setTooltip(text: string): void {
    // systray2 has no tooltip-only action; the tooltip travels with the title,
    // which `update()` already sends.
    void text;
  }

  async close(): Promise<void> {
    if (this.#tray.killed) return;
    try {
      this.#tray.kill();
    } catch {
      // The helper may already be gone.
    }
  }
}

/** Creates the tray for this platform. */
export function createTray(options: TrayOptions): Tray {
  return process.platform === "win32" ? new WindowsTray(options) : new UnixTray(options);
}
