// Stable, non-secret installation identity for the Cursor integration.
//
// Cursor keys device identity off the ids embedded in `x-cursor-checksum` and
// treats every new machineId as a separate device ("too many connections from
// different devices"), so the fingerprint MUST be stable across restarts and
// across processes on one host.
//
// The donor derived it from OS identifiers (IOPlatformUUID / MAC address) by
// shelling out to `ioreg` / `reg query`. Cartethyia does not run provider code
// that spawns a shell per dispatch: the identity is instead derived from
// Cartethyia's own persisted installation id, which is stable for one
// installation and is never derived from a credential. A credential-derived id
// would rotate whenever an operator re-authenticated, which is exactly the
// "too many devices" symptom the stability exists to avoid.
import { createHash } from "node:crypto";
import { getOrCreateInstallId } from "../shared/install-id";

/** One process-lifetime cache: the id is stable, so it is read once. */
let cached: { machineId: string; macMachineId: string } | undefined;
let inFlight: Promise<{ machineId: string; macMachineId: string }> | undefined;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Stable device fingerprints for the `x-cursor-checksum` header.
 *
 * `machineId` and `macMachineId` are two distinct hashes of one stable install
 * id, mirroring the donor's two-id shape without reading a MAC address (which
 * would make the fingerprint depend on hardware that a container may not have).
 * Neither value is logged: they are device identity, not diagnostics.
 */
export async function resolveCursorDeviceIds(): Promise<{
  machineId: string;
  macMachineId: string;
}> {
  if (cached !== undefined) return cached;
  inFlight ??= (async () => {
    const installId = await getOrCreateInstallId("cursor");
    return {
      machineId: sha256Hex(`cursor-machine:${installId}`),
      macMachineId: sha256Hex(`cursor-mac:${installId}`),
    };
  })();
  try {
    cached = await inFlight;
    return cached;
  } finally {
    inFlight = undefined;
  }
}

/**
 * Cursor's obfuscated checksum header value.
 *
 * The wire format is a base64 of an obfuscated 6-byte time prefix followed by
 * the device ids. Ported verbatim from the donor so the server's own de-obfuscation
 * produces the ids it expects.
 */
export function createCursorChecksumHeader(machineId: string, macMachineId?: string): string {
  const n = Math.floor(Date.now() / 1e6);
  const ts = new Uint8Array([
    (n >> 40) & 0xff,
    (n >> 32) & 0xff,
    (n >> 24) & 0xff,
    (n >> 16) & 0xff,
    (n >> 8) & 0xff,
    n & 0xff,
  ]);
  const obfuscated = obfuscate(ts);
  let binary = "";
  for (const byte of obfuscated) binary += String.fromCharCode(byte);
  const prefix = btoa(binary).replace(/=+$/, "");
  return macMachineId ? `${prefix}${machineId}/${macMachineId}` : `${prefix}${machineId}`;
}

function obfuscate(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes);
  let a = 165;
  for (let i = 0; i < out.length; i++) {
    out[i] = ((out[i]! ^ a) + i) & 0xff;
    a = out[i]!;
  }
  return out;
}

/** Test seam: clears the process-lifetime cache so an injected id is re-read. */
export function resetCursorDeviceIdCache(): void {
  cached = undefined;
  inFlight = undefined;
}
