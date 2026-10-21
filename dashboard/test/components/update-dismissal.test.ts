/**
 * The update prompt's "once per release" memory.
 *
 * The prompt exists because an operator running an old version may never think
 * to look — so it has to appear without being asked. It must not appear on
 * every navigation after that, or it punishes the person who already decided
 * not to upgrade. Which release was dismissed is the whole mechanism, so it is
 * what these cases pin.
 *
 * Asserted against the storage helpers rather than rendered markup: the value
 * in storage is what survives a reload, and a markup assertion would pass even
 * if the prompt returned on every load.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { dismissUpdate, readDismissedUpdate } from "../../src/components/UpdateDialog";

/**
 * A `window` for the helpers to read, because this runner has no DOM.
 *
 * Installed on `globalThis` rather than imported through a preload so the case
 * that matters most — storage throwing — can be set up per test.
 */
function installWindow(storage: {
  getItem?: (key: string) => string | null;
  setItem?: (key: string, value: string) => void;
}): void {
  (globalThis as Record<string, unknown>)["window"] = { localStorage: storage };
}

function removeWindow(): void {
  delete (globalThis as Record<string, unknown>)["window"];
}

/** A working in-memory store, so the happy path exercises real round-trips. */
function memoryStore(): { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void } {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

afterEach(removeWindow);

describe("update dismissal", () => {
  test("nothing is dismissed before anything is recorded", () => {
    installWindow(memoryStore());
    expect(readDismissedUpdate()).toBeNull();
  });

  test("a dismissed release is remembered by version, not by a boolean", () => {
    // A boolean would suppress the prompt forever: the next release after this
    // one would never be announced, which is the exact complaint this feature
    // exists to prevent.
    installWindow(memoryStore());
    dismissUpdate("2.5.2");
    expect(readDismissedUpdate()).toBe("2.5.2");
    dismissUpdate("2.6.0");
    expect(readDismissedUpdate()).toBe("2.6.0");
  });

  test("a newer release is not already dismissed", () => {
    installWindow(memoryStore());
    dismissUpdate("2.5.2");
    expect(readDismissedUpdate()).not.toBe("2.6.0");
  });

  test("a failing write does not throw", () => {
    // A full quota or blocked storage must not take the dialog down: the worst
    // outcome is the prompt returning, which is the safe direction.
    installWindow({
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    expect(() => dismissUpdate("9.9.9")).not.toThrow();
  });

  test("a failing read reports nothing dismissed", () => {
    installWindow({
      getItem: () => {
        throw new Error("blocked");
      },
    });
    expect(readDismissedUpdate()).toBeNull();
  });

  test("a browser with no storage at all still reads as undismissed", () => {
    // No `window` — a server-rendered pass, or a browser with storage denied.
    // Reading must degrade to "never dismissed" rather than throw, because the
    // safe failure is showing the prompt again.
    removeWindow();
    expect(readDismissedUpdate()).toBeNull();
    expect(() => dismissUpdate("1.0.0")).not.toThrow();
  });
});
