import { describe, expect, test, vi } from "bun:test";
import { writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchBackgroundWithStatus } from "../../scripts/cli/ui/background";

/**
 * The signal channel a detached child reports startup through.
 *
 * "Hide to tray" used to start the tray and drain the menu's own gateway in
 * that order, so the child's startup probe found the port still held and died
 * with "already running on port" — while the menu printed that everything was
 * running, because a detached child with no stdio can report nothing.
 *
 * The ordering fix lives in the menu, but what makes either order *observable*
 * is this channel: without it a caller cannot tell success from a child that
 * died before it bound the port, which is why the bug looked like a hang.
 *
 * Timers are faked: the poller is the thing under test, and a real 150 ms tick
 * would pin these three cases to the wall clock for no benefit.
 */
describe("background handoff status", () => {
  const signalDir = mkdtempSync(join(tmpdir(), "cartethyia-bg-"));
  let counter = 0;

  /** Stands in for the child, which writes the file from another process. */
  function childWrites(signal: unknown): string {
    const path = join(signalDir, `signal-${counter++}.json`);
    writeFileSync(path, JSON.stringify(signal), { encoding: "utf8", flag: "wx" });
    return path;
  }

  test("resolves with the url the child reported ready", async () => {
    vi.useFakeTimers();
    try {
      const pending = launchBackgroundWithStatus(["--version"], {
        signalPath: childWrites({ status: "ready", url: "http://127.0.0.1:12800/console" }),
        timeoutMs: 5_000,
      });
      vi.advanceTimersByTime(200);
      await expect(pending).resolves.toBe("http://127.0.0.1:12800/console");
    } finally {
      vi.useRealTimers();
    }
  });

  test("rejects with the child's own failure message", async () => {
    vi.useFakeTimers();
    try {
      const pending = launchBackgroundWithStatus(["--version"], {
        signalPath: childWrites({ status: "failed", message: "already running on port 12800" }),
        timeoutMs: 5_000,
      });
      vi.advanceTimersByTime(200);
      await expect(pending).rejects.toThrow("already running on port 12800");
    } finally {
      vi.useRealTimers();
    }
  });

  test("gives up when the child never reports", async () => {
    vi.useFakeTimers();
    try {
      const pending = launchBackgroundWithStatus(["--version"], {
        signalPath: join(signalDir, `never-${counter++}.json`),
        timeoutMs: 1_000,
      });
      vi.advanceTimersByTime(1_500);
      await expect(pending).rejects.toThrow(/did not report startup/);
    } finally {
      vi.useRealTimers();
    }
  });

  test("removes the one-shot signal file either way", async () => {
    vi.useFakeTimers();
    try {
      const path = childWrites({ status: "ready", url: "http://127.0.0.1:1/console" });
      const pending = launchBackgroundWithStatus(["--version"], { signalPath: path, timeoutMs: 5_000 });
      vi.advanceTimersByTime(200);
      await pending;
      expect(() => unlinkSync(path)).toThrow();
    } finally {
      vi.useRealTimers();
    }
  });
});
