import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A marker that one gateway owns this install's port.
 *
 * The port probe alone cannot tell a healthy gateway from a stranger's process:
 * something answering on 12800 is not necessarily ours, so a start that found
 * the port busy either failed outright or — worse — would have to guess before
 * stopping anything. The lock names the PID and the token it was written with,
 * which is what makes "is this our gateway?" answerable without guessing.
 *
 * It is advisory, not an OS lock: a stale file from a crashed process is the
 * normal case this exists to recover from, so presence alone never blocks a
 * start. Liveness is decided by probing the port, and identity by the token.
 */
export interface InstanceLock {
  readonly pid: number;
  readonly port: number;
  /** Fingerprint of the drain token, never the token itself. */
  readonly tokenFingerprint: string;
  readonly startedAt: string;
}

const LOCK_FILE = "instance.json";

function lockPath(): string | null {
  const configDir = process.env.CARTETHYIA_CONFIG_DIR;
  return configDir ? join(configDir, LOCK_FILE) : null;
}

/** A short, non-reversible fingerprint so the token itself is never written. */
export function fingerprint(token: string): string {
  let hash = 0;
  for (let i = 0; i < token.length; i += 1) {
    hash = (hash * 31 + token.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function writeInstanceLock(port: number, pid: number, token: string): void {
  const path = lockPath();
  if (path === null) return;
  const lock: InstanceLock = {
    pid,
    port,
    tokenFingerprint: fingerprint(token),
    startedAt: new Date().toISOString(),
  };
  try {
    writeFileSync(path, JSON.stringify(lock), { encoding: "utf8", mode: 0o600 });
  } catch {
    // A read-only config directory costs the marker, not the run.
  }
}

export function readInstanceLock(): InstanceLock | null {
  const path = lockPath();
  if (path === null || !existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "pid" in parsed &&
      typeof parsed.pid === "number" &&
      "port" in parsed &&
      typeof parsed.port === "number" &&
      "tokenFingerprint" in parsed &&
      typeof parsed.tokenFingerprint === "string"
    ) {
      const startedAt = "startedAt" in parsed && typeof parsed.startedAt === "string" ? parsed.startedAt : "";
      return {
        pid: parsed.pid,
        port: parsed.port,
        tokenFingerprint: parsed.tokenFingerprint,
        startedAt,
      };
    }
  } catch {
    // A corrupt marker reads as none.
  }
  return null;
}

export function clearInstanceLock(): void {
  const path = lockPath();
  if (path === null) return;
  try {
    unlinkSync(path);
  } catch {
    // Already gone, or the directory is read-only.
  }
}

/** Whether a process id is alive. `0` is never a real pid. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
