// Trae request headers: auth + device fingerprint.
//
// The two realms do not authenticate the same way. CN sends
// `Authorization: Cloud-IDE-JWT <token>`; intl overrides it to `Bearer <token>`
// and additionally sends the *current* client version, because intl
// `llm_raw_chat` answers `4015` (risk control) when the version is stale. That
// is why the version here is resolved rather than pinned.
//
// Sourced from the donor hub `Public/trae2api-hub` (`auth_headers` in
// `trae_client.py`, `trae_device_headers` in `trae_fingerprint.py`).

import { createHash, randomUUID } from "node:crypto";
import {
  TRAE_APP_ID,
  TRAE_PLUGIN_CHANNEL,
  TRAE_REALMS,
  type TraeRealm,
} from "./trae-realm";

/** Device fingerprint derived from an account identity. */
export interface TraeDeviceIdentity {
  /** Stable per account: sha256 of a seeded string, 64 hex chars. */
  readonly machineId: string;
  /** Numeric, 19 digits: the upstream client reuses the account's numeric id. */
  readonly deviceId: string;
}

/**
 * Derives the device pair the upstream client sends.
 *
 * Both are pure one-way derivations from the account id, so one account always
 * presents one device and two accounts never share one — the donor notes this
 * is the risk-control correlation surface, so a per-process random id would
 * look like many devices behind one account and a shared id would link them.
 */
export function traeDeviceIdentity(uid: string): TraeDeviceIdentity {
  const seed = String(uid ?? "").trim() || "anonymous";
  const machineId = createHash("sha256").update(`trae-machine:${seed}`).digest("hex");
  const raw = String(uid ?? "").trim();
  if (/^\d+$/.test(raw)) {
    // The official client reuses the 19-digit userId verbatim.
    return { machineId, deviceId: raw };
  }
  const digest = createHash("sha256").update(`trae-device:${raw || "anonymous"}`).digest("hex");
  const numeric = BigInt(`0x${digest.slice(0, 16)}`);
  return { machineId, deviceId: String(10n ** 18n + (numeric % (9n * 10n ** 18n))) };
}

/**
 * OS string reported as `X-Os-Version`.
 *
 * The donor reads this from the host registry, which leaks the operator's real
 * Windows build to upstream. This gateway is not the operator's desktop, so a
 * fixed value of the same shape is both more private and more stable.
 */
export const TRAE_OS_VERSION = "Windows 11 Pro";

/** Reported hardware brand, same reasoning as the OS string. */
export const TRAE_DEVICE_BRAND = "Default string";

/** Per-request correlation id. Random, not derived — decoupled from the device. */
export function traeRequestId(): string {
  return randomUUID();
}

/** Inputs for {@link buildTraeHeaders}. */
export interface TraeHeaderInput {
  readonly realm: TraeRealm;
  /** Access token, sent as both `x-ide-token` and the Authorization bearer. */
  readonly token: string;
  /** Account id the device fingerprint is derived from. */
  readonly uid: string;
  /**
   * Current client version, e.g. `3.6.2`. Sent by intl as `x-ide-version` and
   * `x-app-version`; a stale value is refused with 4015.
   */
  readonly clientVersion?: string;
  /** Version code sent as `x-ide-version-code`. */
  readonly versionCode?: string;
  /** True for the streaming chat call, which overrides `Accept`. */
  readonly stream?: boolean;
  /** Extra/replacement headers, applied case-insensitively. */
  readonly extra?: Readonly<Record<string, string | null>>;
}

/**
 * Builds the header set for one Trae request.
 *
 * `null` in `extra` deletes the header, matching the donor's override rule.
 */
export function buildTraeHeaders(input: TraeHeaderInput): Record<string, string> {
  const config = TRAE_REALMS[input.realm];
  const device = traeDeviceIdentity(input.uid);
  const headers: Record<string, string> = {
    "X-App-Id": TRAE_APP_ID,
    "x-plugin-channel": TRAE_PLUGIN_CHANNEL,
    "x-ide-version-code": input.versionCode ?? config.versionCode,
    "x-ide-token": input.token,
    Authorization: `Cloud-IDE-JWT ${input.token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": config.userAgent,
    "X-Device-Cpu": "Intel",
    "X-Device-Id": device.deviceId,
    "X-Machine-Id": device.machineId,
    "X-Device-Brand": encodeURIComponent(TRAE_DEVICE_BRAND),
    "X-Device-Type": "windows",
    "X-Os-Version": encodeURIComponent(TRAE_OS_VERSION),
    "X-Request-Id": traeRequestId(),
  };

  if (input.realm === "intl") {
    // intl raw_chat requires Bearer (not Cloud-IDE-JWT) *and* the current
    // client version on four headers; a stale version is answered 4015.
    const version = input.clientVersion ?? intlVersionFallback(config.userAgent);
    headers["Authorization"] = `Bearer ${input.token}`;
    headers["x-ide-token"] = input.token;
    headers["x-ide-version"] = version;
    headers["x-app-version"] = version;
    headers["User-Agent"] = "TraeClient/TTNet";
    headers["store-country-code"] = "us";
  }

  if (input.stream === true) {
    headers["Accept"] = "text/event-stream";
    headers["Cache-Control"] = "no-cache";
  }

  for (const [key, value] of Object.entries(input.extra ?? {})) {
    const lower = key.toLowerCase();
    for (const existing of Object.keys(headers)) {
      if (existing.toLowerCase() === lower) delete headers[existing];
    }
    if (value !== null) headers[key] = value;
  }
  return headers;
}

/**
 * Last-resort intl version: the one baked into the realm's own User-Agent.
 *
 * Only reached when the version resolver has not answered yet. It is the
 * donor's last observed version rather than an invented number, so a cold
 * process sends something upstream has accepted before.
 */
function intlVersionFallback(userAgent: string): string {
  const match = userAgent.match(/(\d+\.\d+\.\d+)/);
  return match?.[1] ?? "3.6.2";
}
