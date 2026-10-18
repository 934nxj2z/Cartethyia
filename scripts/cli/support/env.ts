import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PACKAGE_ROOT } from "../../../src/config/package-paths";

/**
 * Absolute path of the repository root.
 *
 * Operational scripts and the npm runtime share one package-root resolver so
 * assets and repository config do not depend on the caller's working directory.
 */
export const PROJECT_ROOT = PACKAGE_ROOT;

/** Resolve the active `.env`; npm CLI sets a user-owned config directory. */
export function resolveEnvPath(env: NodeJS.ProcessEnv = process.env): string {
  const configDir = env.CARTETHYIA_CONFIG_DIR?.trim();
  return configDir ? resolve(configDir, ".env") : resolve(PROJECT_ROOT, ".env");
}

/** Absolute path of the active `.env`. */
export const ENV_PATH = resolveEnvPath();

/**
 * Reads a dotenv-style file without overriding already-exported variables.
 */
export async function readEnvFile(path: string): Promise<Record<string, string>> {
  if (!existsSync(path)) return {};
  const content = await readFile(path, "utf8");
  const values: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    if (line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key) values[key] = value;
  }
  return values;
}

/**
 * Checks if a string contains a configured placeholder value.
 */
export function hasPlaceholderSecrets(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized.includes("replace-with") ||
    normalized.includes("replace_me") ||
    normalized.includes("your_")
  );
}

/**
 * Generates a 256-bit hex cartethyia encryption key.
 *
 * Hex is preferred over base64 because it never carries padding or `+`/`/`
 * characters that confuse some dotenv shells, and it round-trips through
 * every adapter that accepts either encoding. The install/setup helpers call
 * this when the key is absent or still a placeholder.
 */
export function generateCartethyiaEncryptionKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (let i = 0; i < bytes.length; i += 1) hex += bytes[i]!.toString(16).padStart(2, "0");
  return hex;
}

/**
 * Returns the mandatory-only `.env` body derived from `.env.example`.
 *
 * Mandatory means the key is assigned without a leading `#`. Optional entries
 * (leading `#`) carry built-in defaults and must not be copied into a fresh
 * `.env` — they would override the default with a literal `example` value.
 * The generated body therefore contains only mandatory rows, plus a single
 * `CARTETHYIA_ENCRYPTION_KEY` replacement when the caller supplies one.
 */
export async function mandatoryEnvBody(
  examplePath: string,
  overrides: Readonly<Record<string, string>> = {},
): Promise<string> {
  const raw = await readFile(examplePath, "utf8");
  const lines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const sep = line.indexOf("=");
    if (sep <= 0) continue;
    const key = line.slice(0, sep).trim();
    if (!key) continue;
    const value = (overrides as Record<string, string>)[key] ?? line.slice(sep + 1).trim();
    lines.push(`${key}=${value}`);
  }
  // Preserve overrides even when the example row was commented out (legacy case).
  for (const [key, value] of Object.entries(overrides)) {
    if (!lines.some((l) => l.startsWith(`${key}=`))) lines.push(`${key}=${value}`);
  }
  return `${lines.join("\n")}\n`;
}
