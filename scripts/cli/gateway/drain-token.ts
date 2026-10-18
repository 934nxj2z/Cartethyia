import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The install's drain token, persisted in the config directory.
 *
 * Why it persists instead of being generated per run: `cartethyia stop` runs in
 * a different process, possibly minutes later, and the token is the only way it
 * can authenticate to a gateway it did not start. A token regenerated on each
 * start could never match the gateway that is actually running, which is why
 * `stop` reported "no gateway found" or a 401 on a live gateway.
 *
 * It is kept out of `.env` on purpose: it authorises a shutdown, so it belongs
 * in a machine-written file the operator never hand-edits and never commits.
 * Mode 0600 where the platform honours it.
 */
const RUNTIME_STATE_FILE = "runtime.json";

interface RuntimeState {
  readonly drainToken: string;
}

function statePath(): string | null {
  const configDir = process.env.CARTETHYIA_CONFIG_DIR;
  return configDir ? join(configDir, RUNTIME_STATE_FILE) : null;
}

function readState(): RuntimeState | null {
  const path = statePath();
  if (path === null || !existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "drainToken" in parsed &&
      typeof parsed.drainToken === "string" &&
      parsed.drainToken.length > 0
    ) {
      return { drainToken: parsed.drainToken };
    }
  } catch {
    // A corrupt or stale state file reads as "no token".
  }
  return null;
}

/**
 * Returns the install's drain token, creating and persisting one on first use.
 *
 * Every start calls this, so a gateway started from the menu, from `tray`, or
 * from `cartethyia start` all authenticate with the same token and `stop`
 * always has the one that works.
 */
export function ensureDrainToken(): string {
  const existing = readState();
  if (existing !== null) return existing.drainToken;

  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const path = statePath();
  if (path !== null) {
    try {
      writeFileSync(path, JSON.stringify({ drainToken: token }), {
        encoding: "utf8",
        mode: 0o600,
      });
    } catch {
      // A read-only config directory still yields a usable in-process token;
      // only `stop` from another process is lost.
    }
  }
  return token;
}

/** The persisted token, or null when this install has never started. */
export function readPersistedDrainToken(): string | null {
  return readState()?.drainToken ?? null;
}
