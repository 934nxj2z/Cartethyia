import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Runtime state for a gateway left running by "Hide to background".
 *
 * Kept out of `.env` on purpose: the drain token authorises a shutdown, so it
 * belongs in a machine-written file the operator never hand-edits and never
 * commits. It is written when the menu detaches and removed when the gateway
 * is drained, so a stale file never outlives the process it refers to.
 */
const RUNTIME_STATE_FILE = "runtime.json";

function statePath(): string | null {
  const configDir = process.env.CARTETHYIA_CONFIG_DIR;
  return configDir ? join(configDir, RUNTIME_STATE_FILE) : null;
}

/** Persists the drain token so a later `cartethyia stop` can reach the gateway. */
export function writePersistedDrainToken(token: string): void {
  const path = statePath();
  if (path === null) return;
  try {
    writeFileSync(path, JSON.stringify({ drainToken: token }), {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch {
    // A read-only config directory costs only the `stop` command, not startup.
  }
}

/** Returns the token for a background gateway, or null when there is none. */
export function readPersistedDrainToken(): string | null {
  const path = statePath();
  if (path === null || !existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "drainToken" in parsed &&
      typeof parsed.drainToken === "string"
    ) {
      return parsed.drainToken;
    }
  } catch {
    // A corrupt or stale state file reads as "no background gateway".
  }
  return null;
}

/** Removes the token once the drain has been accepted. */
export function clearPersistedDrainToken(): void {
  const path = statePath();
  if (path === null) return;
  try {
    unlinkSync(path);
  } catch {
    // Best effort: the drain request already succeeded.
  }
}
